/**
 * Word Pong — the GameModule the mp-runtime drives. The runtime owns transport, lobby, auth,
 * card provisioning, and broadcasting; this file is the rules.
 *
 * A rally of words. Each player holds two cards in their own study language. The ball flies at
 * a player carrying the meaning of one of THEIR two cards (in their own language); before it
 * reaches them they swing the matching card at it. A correct hit scores them a point and
 * reflects the ball straight back — already carrying the meaning of one of the opponent's
 * cards — so play never stops. A wrong card or a late swing is a miss: no point (there are no
 * minus points), a moment to show the right answer, then the player who missed serves. Either
 * way the player who swung is dealt a fresh pair. The ball strictly alternates sides, so both
 * players receive the same number of balls; after the last one the highest score wins.
 *
 * Cross-language: concepts are keyed by their English word, so a Greek learner can rally with
 * a Russian learner — each sees words in their own study language.
 *
 * `playerId` throughout is the stable per-match userId (survives reconnects).
 */
import type { CardTranslation, GameModule, GameResult, MatchContext } from '@memdecks/mp-types';
import { pick, shuffled } from './random';

/** Cards in each player's hand — the ball always carries the meaning of one of them. */
const HAND_SIZE = 2;
/** Fewest distinct concepts a match needs, pooled from both decks. */
const MIN_CONCEPTS = 6;
/** Countdown before the very first serve, so both players are looking at the table. */
const READY_MS = 2_500;
/** After a miss: long enough to see the right answer, short enough to keep the rally going. */
const MISS_PAUSE_MS = 1_100;
/** After the last ball, before the result screen. */
const FINAL_PAUSE_MS = 1_400;
/** A missed word comes back after this many fresh pairs, for another try. */
const RETRY_GAP = 3;
/** How long a disconnected player may stay away before forfeiting the match. */
const FORFEIT_GRACE_MS = 30_000;
const DEFAULT_BALLS_PER_PLAYER = 10;
/** Ball flight time = the receiver's window to answer. */
const SPEEDS = { relaxed: 8_000, normal: 6_000, fast: 4_000 } as const;
type Speed = keyof typeof SPEEDS;

type Phase = 'PLAYING' | 'GAME_OVER';
type Stage = 'ready' | 'flight' | 'pause';
type Outcome = 'hit' | 'wrong' | 'missed';

/** One meaning, rendered into every language in the match. */
interface Concept {
  /** Opaque id, so a hand card's id never tells the client what the word means. */
  id: string;
  english: string;
  partOfSpeech: string;
  /** The study-language word, per study language. */
  wordByLang: Record<string, CardTranslation>;
  /** The meaning in each non-English base language. English bases read `english`. */
  promptByLang: Record<string, string>;
  /** Each player's own Translator card id for this concept, keyed by userId — the only id
   *  their token can resolve pronunciation for. Others get the word spoken by text. */
  cardIdByPlayer: Record<string, string>;
}

/**
 * The ball in play. Its position along the table runs 0 (sender's end) → 1 (receiver's end) on
 * the `travel` curve; a return starts where the previous ball was hit, not at the far end.
 */
interface Ball {
  /** 1-based count of balls played this match. */
  number: number;
  fromId: string;
  toId: string;
  /** The receiver's hand card whose meaning the ball carries. */
  targetId: string;
  /** The sender's card that sent it back (shown on the sender's side); null for a serve. */
  carriedId: string | null;
  startedAt: number;
  durationMs: number;
  startPos: number;
  /** Lateral position (0–100, seat 0's view of the table) where it starts and where it lands. */
  startX: number;
  endX: number;
  outcome: Outcome | null;
  /** Where along the table it was decided (1 = it reached the receiver untouched). */
  contactPos: number | null;
  pickedId: string | null;
}

/** A player's most recent decided ball — drives their own feedback and the opponent's swing. */
interface SwingResult {
  ball: number;
  outcome: Outcome;
  targetId: string;
  pickedId: string | null;
  at: number;
}

interface BallRecord {
  number: number;
  receiverId: string;
  conceptId: string;
  pickedId: string | null;
  outcome: Outcome;
}

type AudioRef = { cardId: string } | { text: string; lang: string };

/** One-shot pronunciation cue: the client plays `audio` whenever `token` advances. */
interface SoundCue {
  token: number;
  audio?: AudioRef;
}

export interface PongState {
  players: string[]; // userIds, seat order
  names: Record<string, string>;
  studyLanguages: Record<string, string>;
  baseLanguages: Record<string, string>;
  concepts: Record<string, Concept>;
  hands: Record<string, string[]>;
  /** Per player: concept ids not yet dealt this cycle; refilled (reshuffled) when it runs dry. */
  queues: Record<string, string[]>;
  scores: Record<string, number>;
  stage: Stage;
  /** End of the `ready` countdown or the `pause` after a miss. */
  stageUntil: number | null;
  /** What happens when the countdown / pause ends. */
  afterPause: 'serve' | 'finish';
  /** Who serves when the countdown / pause ends. */
  nextServerId: string | null;
  ball: Ball | null;
  totalBalls: number;
  flightMs: number;
  results: Record<string, SwingResult>;
  history: BallRecord[];
  phase: Phase;
  winnerId: string | null;
  message: string;
  sound: Record<string, SoundCue>;
  /** Epoch ms when a player disconnected mid-match; cleared on return. */
  absentSince: Record<string, number>;
}

export type PongAction = { action: 'hit'; payload?: { cardId?: string } };

// ── flight ──────────────────────────────────────────────────────────────────

/** Ease-out: the ball is over the net in under a third of the window and slows as it nears the
 *  receiver, so most of the answer time is spent with the ball on their side. The linear part
 *  keeps it moving at the end (arriving at about a fifth of its starting speed) instead of
 *  crawling. The client draws the same curve. */
export function travel(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 0.45 * clamped + 0.55 * (1 - (1 - clamped) ** 3);
}

function progressAt(ball: Ball, now: number): number {
  return travel((now - ball.startedAt) / ball.durationMs);
}

function posAt(ball: Ball, progress: number): number {
  return ball.startPos + (1 - ball.startPos) * progress;
}

function xAt(ball: Ball, progress: number): number {
  return ball.startX + (ball.endX - ball.startX) * progress;
}

/** Where a ball lands sideways: anywhere but the very edges. */
function randomLane(): number {
  return 22 + Math.random() * 56;
}

// ── language + concept helpers ──────────────────────────────────────────────

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/** The most common non-English language in a deck — used when the roster omits one. */
function dominantLanguage(cards: MatchContext['cards'][string]): string | null {
  const counts = new Map<string, number>();
  for (const card of cards) {
    for (const [lang, translation] of Object.entries(card.translations)) {
      if (lang === 'en' || !translation?.word) continue;
      counts.set(lang, (counts.get(lang) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** Each player's study language: the roster value, else their deck's dominant language, else the
 *  language their co-player studies — so even an empty deck resolves. */
function resolveStudyLanguages(ctx: MatchContext, players: string[]): Record<string, string | null> {
  const resolved: Record<string, string | null> = {};
  for (const userId of players) {
    const fromRoster = ctx.players.find((p) => p.userId === userId)?.language;
    resolved[userId] = fromRoster || dominantLanguage(ctx.cards[userId] ?? []);
  }
  const fallback = Object.values(resolved).find((lang): lang is string => !!lang) ?? null;
  for (const userId of players) resolved[userId] ??= fallback;
  return resolved;
}

/** The language each player reads meanings in: the roster value, else the language their own
 *  cards are prompted in, else English. */
function resolveBaseLanguages(ctx: MatchContext, players: string[]): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const userId of players) {
    const fromRoster = ctx.players.find((p) => p.userId === userId)?.baseLanguage;
    const counts = new Map<string, number>();
    for (const card of ctx.cards[userId] ?? []) {
      const lang = card.promptLanguage ?? 'en';
      counts.set(lang, (counts.get(lang) ?? 0) + 1);
    }
    const fromDeck = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    resolved[userId] = fromRoster || fromDeck || 'en';
  }
  return resolved;
}

/** Pool both players' cards into concepts keyed by normalized English, merging every language
 *  either deck already carries (first word per language wins). */
function poolConcepts(
  ctx: MatchContext,
  players: string[],
  studyLanguages: Record<string, string>,
): Concept[] {
  const byEnglish = new Map<string, Concept>();
  for (const userId of players) {
    for (const card of ctx.cards[userId] ?? []) {
      if (!card.english) continue;
      const key = normalize(card.english);
      let concept = byEnglish.get(key);
      if (!concept) {
        concept = {
          id: `w${byEnglish.size + 1}`,
          english: card.english,
          partOfSpeech: card.partOfSpeech ?? 'noun',
          wordByLang: {},
          promptByLang: {},
          cardIdByPlayer: {},
        };
        byEnglish.set(key, concept);
      }
      if (card.prompt && card.promptLanguage && card.promptLanguage !== 'en') {
        concept.promptByLang[card.promptLanguage] ??= card.prompt;
      }
      for (const [lang, translation] of Object.entries(card.translations)) {
        if (lang === 'en' || !translation?.word) continue;
        const kept = concept.wordByLang[lang];
        if (!kept) concept.wordByLang[lang] = translation;
        // Both decks cover this language but disagree; this row's audio would not match the
        // displayed word, so it is not this player's pronunciation source.
        else if (normalize(kept.word) !== normalize(translation.word)) continue;
        if (lang === studyLanguages[userId]) concept.cardIdByPlayer[userId] ??= card.id;
      }
    }
  }
  return [...byEnglish.values()];
}

/** Fill every (concept, language) gap with one `ctx.translate` call, then keep only concepts
 *  every player can see in their own study language. */
async function buildConcepts(
  ctx: MatchContext,
  players: string[],
  studyLanguages: Record<string, string>,
  baseLanguages: Record<string, string>,
): Promise<Concept[]> {
  const concepts = poolConcepts(ctx, players, studyLanguages);
  const langs = [...new Set(Object.values(studyLanguages))];
  const baseLangs = [...new Set(Object.values(baseLanguages).filter((l) => l !== 'en'))];

  const words = new Set<string>();
  const gapLangs = new Set<string>();
  for (const concept of concepts) {
    for (const lang of langs) {
      if (!concept.wordByLang[lang]?.word) { words.add(concept.english); gapLangs.add(lang); }
    }
    for (const lang of baseLangs) {
      if (!concept.promptByLang[lang]) { words.add(concept.english); gapLangs.add(lang); }
    }
  }
  if (words.size > 0 && ctx.translate) {
    try {
      const translated = await ctx.translate([...words], [...gapLangs]);
      for (const concept of concepts) {
        const row = translated[concept.english];
        if (!row) continue;
        for (const lang of langs) {
          const translation = row[lang];
          if (!concept.wordByLang[lang]?.word && translation?.word) concept.wordByLang[lang] = translation;
        }
        // A meaning the platform cannot give in a player's language stays English for them.
        for (const lang of baseLangs) {
          const word = row[lang]?.word;
          if (word && !concept.promptByLang[lang]) concept.promptByLang[lang] = word;
        }
      }
    } catch {
      // Best-effort: unfilled concepts are dropped below.
    }
  }

  return concepts.filter((c) => langs.every((lang) => c.wordByLang[lang]?.word));
}

function wordFor(concept: Concept, lang: string): CardTranslation | undefined {
  return concept.wordByLang[lang];
}

function promptFor(concept: Concept, base: string): string {
  return (base !== 'en' && concept.promptByLang[base]) || concept.english;
}

/** Two concepts can share a hand only if their owner would not see them as the same word —
 *  on the card (study language) or on the ball (base language). */
function distinguishable(state: PongState, playerId: string, a: Concept, b: Concept): boolean {
  const lang = state.studyLanguages[playerId] ?? '';
  const base = state.baseLanguages[playerId] ?? 'en';
  if (normalize(wordFor(a, lang)?.word ?? '') === normalize(wordFor(b, lang)?.word ?? '')) return false;
  return normalize(promptFor(a, base)) !== normalize(promptFor(b, base));
}

/** Deal a player a fresh pair: mutually distinguishable, cycling the whole pool before any
 *  concept repeats (a missed word is slotted back in sooner — see `retryLater`). */
function dealHand(state: PongState, playerId: string): void {
  const all = Object.keys(state.concepts);
  const queue = (state.queues[playerId] ??= []);
  const hand: string[] = [];
  const fits = (id: string) =>
    !hand.includes(id) &&
    hand.every((h) => distinguishable(state, playerId, state.concepts[h]!, state.concepts[id]!));
  while (hand.length < HAND_SIZE) {
    if (queue.length === 0) queue.push(...shuffled(all.filter((id) => !hand.includes(id))));
    const index = queue.findIndex(fits);
    if (index >= 0) {
      hand.push(queue.splice(index, 1)[0]!);
      continue;
    }
    // Nothing left in this cycle fits next to the card already dealt: reach into the full pool.
    const fallback = shuffled(all).find(fits) ?? shuffled(all).find((id) => !hand.includes(id));
    if (!fallback) break;
    hand.push(fallback);
  }
  state.hands[playerId] = hand;
}

/** Bring a missed word back a few pairs later. */
function retryLater(state: PongState, playerId: string, conceptId: string): void {
  const queue = (state.queues[playerId] ??= []);
  const existing = queue.indexOf(conceptId);
  if (existing >= 0) queue.splice(existing, 1);
  queue.splice(Math.min(RETRY_GAP * HAND_SIZE - 1, queue.length), 0, conceptId);
}

function audioFor(state: PongState, concept: Concept, playerId: string): AudioRef | undefined {
  const cardId = concept.cardIdByPlayer[playerId];
  if (cardId) return { cardId };
  const lang = state.studyLanguages[playerId];
  const word = lang ? wordFor(concept, lang)?.word : undefined;
  return lang && word ? { text: word, lang } : undefined;
}

/** Cue a concept's pronunciation for one player, in their own study language. */
function cue(state: PongState, playerId: string, conceptId: string): void {
  const concept = state.concepts[conceptId];
  const token = (state.sound[playerId]?.token ?? 0) + 1;
  const audio = concept ? audioFor(state, concept, playerId) : undefined;
  state.sound[playerId] = audio ? { token, audio } : { token };
}

function nameOf(state: PongState, playerId: string | null | undefined): string {
  return (playerId && state.names[playerId]) || 'Player';
}

function opponentOf(state: PongState, playerId: string): string | null {
  return state.players.find((id) => id !== playerId) ?? null;
}

// ── rally flow ──────────────────────────────────────────────────────────────

/** Put a ball in flight from `fromId` towards their opponent, aimed at one of the opponent's cards. */
function launch(
  state: PongState,
  fromId: string,
  from: { carriedId: string | null; startPos: number; startX: number },
): void {
  const toId = opponentOf(state, fromId);
  const targetId = toId ? pick(state.hands[toId] ?? []) : undefined;
  if (!toId || !targetId) return;
  state.ball = {
    number: (state.ball?.number ?? 0) + 1,
    fromId,
    toId,
    targetId,
    carriedId: from.carriedId,
    startedAt: Date.now(),
    durationMs: state.flightMs,
    startPos: from.startPos,
    startX: from.startX,
    endX: randomLane(),
    outcome: null,
    contactPos: null,
    pickedId: null,
  };
  state.stage = 'flight';
  state.stageUntil = null;
}

function serve(state: PongState, fromId: string): void {
  launch(state, fromId, { carriedId: null, startPos: 0, startX: 50 });
  state.message = `${nameOf(state, fromId)} serves.`;
}

/** Settle the ball in flight: score a hit, deal the swinger a fresh pair, and either reflect the
 *  ball straight back (hit) or pause briefly on the right answer (miss). */
function decide(state: PongState, outcome: Outcome, pickedId: string | null): void {
  const ball = state.ball;
  if (!ball || ball.outcome) return;
  const now = Date.now();
  const progress = outcome === 'missed' ? 1 : progressAt(ball, now);
  const receiverId = ball.toId;

  ball.outcome = outcome;
  ball.pickedId = pickedId;
  ball.contactPos = posAt(ball, progress);
  if (outcome === 'hit') state.scores[receiverId] = (state.scores[receiverId] ?? 0) + 1;
  else retryLater(state, receiverId, ball.targetId);
  state.results[receiverId] = { ball: ball.number, outcome, targetId: ball.targetId, pickedId, at: now };
  state.history.push({ number: ball.number, receiverId, conceptId: ball.targetId, pickedId, outcome });
  // The receiver hears the word the ball carried, right or wrong.
  cue(state, receiverId, ball.targetId);
  dealHand(state, receiverId);

  const name = nameOf(state, receiverId);
  const last = ball.number >= state.totalBalls;
  if (outcome === 'hit' && !last) {
    // Reflect: the return leaves from where the ball was hit, on the hitter's side of the net.
    launch(state, receiverId, {
      carriedId: ball.targetId,
      startPos: 1 - ball.contactPos,
      startX: xAt(ball, progress),
    });
    state.message = `${name} hit it back! +1`;
    return;
  }

  state.stage = 'pause';
  state.stageUntil = now + (last ? FINAL_PAUSE_MS : MISS_PAUSE_MS);
  state.afterPause = last ? 'finish' : 'serve';
  // Whoever missed serves the next ball, so the ball keeps alternating sides.
  state.nextServerId = receiverId;
  state.message =
    outcome === 'hit' ? `${name} hit the last ball! +1`
      : outcome === 'wrong' ? `${name} swung the wrong word.`
        : `${name} missed the ball.`;
}

function hit(state: PongState, playerId: string, cardId: string): void {
  const ball = state.ball;
  if (state.phase !== 'PLAYING' || state.stage !== 'flight' || !ball || ball.toId !== playerId) return;
  if (!state.hands[playerId]?.includes(cardId)) return;
  decide(state, cardId === ball.targetId ? 'hit' : 'wrong', cardId);
}

function computeWinner(state: PongState): string | null {
  const [a, b] = state.players;
  if (!a || !b) return null;
  const aScore = state.scores[a] ?? 0;
  const bScore = state.scores[b] ?? 0;
  if (aScore === bScore) return null;
  return aScore > bScore ? a : b;
}

function finish(state: PongState, message: string, winnerId: string | null = computeWinner(state)): void {
  state.phase = 'GAME_OVER';
  state.winnerId = winnerId;
  state.message = message;
  state.stageUntil = null;
}

function readSettings(settings: Record<string, unknown>): { balls: number; flightMs: number } {
  const balls = Number(settings.shots);
  const speed = String(settings.speed ?? 'normal');
  return {
    balls: Number.isInteger(balls) && balls > 0 && balls <= 50 ? balls : DEFAULT_BALLS_PER_PLAYER,
    flightMs: speed in SPEEDS ? SPEEDS[speed as Speed] : SPEEDS.normal,
  };
}

// ── module ──────────────────────────────────────────────────────────────────

export const wordPongModule: GameModule<PongState, PongAction> = {
  manifest: {
    id: 'word-pong',
    title: 'Word Pong',
    minPlayers: 2,
    maxPlayers: 2,
    settingsSchema: [
      {
        key: 'shots',
        label: 'Balls per player',
        type: 'select',
        default: DEFAULT_BALLS_PER_PLAYER,
        options: [5, 10, 15].map((n) => ({ value: n, label: String(n) })),
      },
      {
        key: 'speed',
        label: 'Ball speed',
        type: 'select',
        default: 'normal',
        options: [
          { value: 'relaxed', label: 'Relaxed (8 s)' },
          { value: 'normal', label: 'Normal (6 s)' },
          { value: 'fast', label: 'Fast (4 s)' },
        ],
      },
    ],
    requiresCards: { minUsable: MIN_CONCEPTS, perLanguage: true },
  },

  async createMatch(ctx: MatchContext): Promise<PongState> {
    const players = [...ctx.players].sort((a, b) => a.seat - b.seat).map((p) => p.userId);
    const names: Record<string, string> = {};
    for (const p of ctx.players) names[p.userId] = p.name;
    const { balls, flightMs } = readSettings(ctx.settings);

    const resolvedStudy = resolveStudyLanguages(ctx, players);
    const studyLanguages: Record<string, string> = {};
    for (const userId of players) studyLanguages[userId] = resolvedStudy[userId] ?? '';
    const baseLanguages = resolveBaseLanguages(ctx, players);

    const scores: Record<string, number> = {};
    for (const userId of players) scores[userId] = 0;

    const state: PongState = {
      players,
      names,
      studyLanguages,
      baseLanguages,
      concepts: {},
      hands: {},
      queues: {},
      scores,
      stage: 'ready',
      stageUntil: null,
      afterPause: 'serve',
      nextServerId: players[0] ?? null,
      ball: null,
      totalBalls: balls * players.length,
      flightMs,
      results: {},
      history: [],
      phase: 'GAME_OVER',
      winnerId: null,
      message: 'Waiting for players.',
      sound: {},
      absentSince: {},
    };

    const concepts = Object.values(studyLanguages).every(Boolean)
      ? await buildConcepts(ctx, players, studyLanguages, baseLanguages)
      : [];
    if (players.length < 2 || concepts.length < MIN_CONCEPTS) {
      state.message = `Need at least ${MIN_CONCEPTS} words playable in every player's language.`;
      return state;
    }
    for (const concept of concepts) state.concepts[concept.id] = concept;
    for (const userId of players) dealHand(state, userId);

    state.phase = 'PLAYING';
    state.stageUntil = Date.now() + READY_MS;
    state.message = `${nameOf(state, players[0])} serves first.`;
    return state;
  },

  applyAction(state, playerId, action) {
    const cardId = action.payload?.cardId;
    if (action.action === 'hit' && typeof cardId === 'string') hit(state, playerId, cardId);
  },

  viewFor(state, playerId) {
    const lang = state.studyLanguages[playerId] ?? '';
    const base = state.baseLanguages[playerId] ?? 'en';
    const now = Date.now();
    // Each player sees themselves at the bottom of the table: seat 1's view is turned around.
    const mirror = (x: number) => (state.players.indexOf(playerId) === 1 ? 100 - x : x);

    const cardView = (conceptId: string, withPrompt: boolean) => {
      const concept = state.concepts[conceptId];
      if (!concept) return null;
      const translation = wordFor(concept, lang);
      const audio = audioFor(state, concept, playerId);
      return {
        id: conceptId,
        word: translation?.word ?? concept.english,
        ...(translation?.transliteration ? { transliteration: translation.transliteration } : {}),
        // The meaning is the answer — only shown once the ball is decided.
        ...(withPrompt ? { prompt: promptFor(concept, base) } : {}),
        partOfSpeech: concept.partOfSpeech,
        ...(audio ? { audio } : {}),
      };
    };

    const hand = (state.hands[playerId] ?? [])
      .map((id) => cardView(id, false))
      .filter((card) => card !== null);

    const ball = state.ball;
    let ballView: Record<string, unknown> | null = null;
    if (ball && state.phase === 'PLAYING' && state.stage !== 'ready') {
      const incoming = ball.toId === playerId;
      const target = state.concepts[ball.targetId];
      const carried = ball.carriedId ? state.concepts[ball.carriedId] : undefined;
      // Coming at you: the meaning you must answer. Going away: the word you sent it with.
      const label = incoming
        ? target && promptFor(target, base)
        : carried && (wordFor(carried, lang)?.word ?? carried.english);
      ballView = {
        id: ball.number,
        direction: incoming ? 'incoming' : 'outgoing',
        state: !ball.outcome ? 'flying' : ball.outcome === 'hit' ? 'returned' : 'missed',
        startPos: ball.startPos,
        startX: mirror(ball.startX),
        endX: mirror(ball.endX),
        durationMs: ball.durationMs,
        elapsedMs: Math.max(0, now - ball.startedAt),
        contactPos: ball.contactPos,
        ...(label ? { label } : {}),
      };
    }

    const resultView = (userId: string | null, withWords: boolean) => {
      const result = userId ? state.results[userId] : undefined;
      if (!result) return null;
      const target = withWords ? cardView(result.targetId, true) : null;
      const picked = withWords && result.pickedId ? cardView(result.pickedId, true) : null;
      return {
        ball: result.ball,
        outcome: result.outcome,
        ageMs: Math.max(0, now - result.at),
        ...(target ? { target } : {}),
        ...(picked ? { picked } : {}),
      };
    };

    const opponentId = opponentOf(state, playerId);
    return {
      phase: state.phase,
      you: playerId,
      studyLanguage: lang || null,
      players: state.players.map((id) => ({
        id,
        name: state.names[id] ?? 'Player',
        score: state.scores[id] ?? 0,
        present: state.absentSince[id] === undefined,
      })),
      stage: state.stage,
      stageRemainingMs: state.stageUntil ? Math.max(0, state.stageUntil - now) : 0,
      nextServerId: state.nextServerId,
      ballNumber: ball?.number ?? 0,
      totalBalls: state.totalBalls,
      hand,
      opponentHandCount: opponentId ? state.hands[opponentId]?.length ?? 0 : 0,
      // Never the target's id or its study-language word while it flies — only its meaning.
      ball: ballView,
      myResult: resultView(playerId, true),
      opponentResult: resultView(opponentId, false),
      winnerId: state.winnerId,
      message: state.message,
      sound: state.sound[playerId] ?? { token: 0 },
      // The end-of-match review: every ball, in this player's languages.
      history: state.phase === 'GAME_OVER'
        ? state.history.map((record) => {
          const card = cardView(record.conceptId, true);
          return {
            number: record.number,
            receiverId: record.receiverId,
            outcome: record.outcome,
            word: card?.word ?? '',
            prompt: card?.prompt ?? '',
            ...(card?.audio ? { audio: card.audio } : {}),
          };
        })
        : [],
    };
  },

  onPresenceChange(state, playerId, present) {
    if (state.phase !== 'PLAYING' || !state.players.includes(playerId)) return;
    if (present) {
      if (state.absentSince[playerId] === undefined) return;
      delete state.absentSince[playerId];
      state.message = `${nameOf(state, playerId)} reconnected.`;
      return;
    }
    state.absentSince[playerId] = Date.now();
    state.message = `${nameOf(state, playerId)} disconnected — forfeits in ${Math.round(FORFEIT_GRACE_MS / 1000)}s unless they return.`;
  },

  /** Land an unanswered ball, end a countdown or pause, forfeit a player past grace. */
  tick(state) {
    if (state.phase !== 'PLAYING') return;
    const now = Date.now();

    const expired = state.players.filter(
      (id) => state.absentSince[id] !== undefined && now - state.absentSince[id]! >= FORFEIT_GRACE_MS,
    );
    if (expired.length > 0) {
      if (expired.length === state.players.length) {
        finish(state, 'Both players left the match.');
        return;
      }
      const leaver = expired[0]!;
      const winner = opponentOf(state, leaver);
      finish(state, `${nameOf(state, leaver)} left the match. ${nameOf(state, winner)} wins by forfeit.`, winner);
      return;
    }

    if (state.stage === 'flight') {
      const ball = state.ball;
      if (ball && now >= ball.startedAt + ball.durationMs) decide(state, 'missed', null);
      return;
    }
    if (state.stageUntil === null || now < state.stageUntil) return;
    if (state.afterPause === 'finish') {
      finish(state, 'All balls played. Highest score wins.');
      return;
    }
    if (state.nextServerId) serve(state, state.nextServerId);
  },

  nextDelayMs(state) {
    if (state.phase !== 'PLAYING') return null;
    const deadlines = Object.values(state.absentSince).map((since) => since + FORFEIT_GRACE_MS);
    if (state.stage === 'flight' && state.ball) deadlines.push(state.ball.startedAt + state.ball.durationMs);
    else if (state.stageUntil !== null) deadlines.push(state.stageUntil);
    if (deadlines.length === 0) return null;
    return Math.max(0, Math.min(...deadlines) - Date.now());
  },

  isOver(state): GameResult | null {
    if (state.phase !== 'GAME_OVER') return null;
    const scores: Record<string, number> = {};
    for (const userId of state.players) scores[userId] = state.scores[userId] ?? 0;
    if (Object.keys(state.concepts).length === 0) return { outcome: 'cancelled', scores };
    return { outcome: state.winnerId ? 'decided' : 'draw', scores };
  },
};
