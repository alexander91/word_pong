/**
 * Word Pong — the GameModule the mp-runtime drives. The runtime owns transport, lobby, auth,
 * card provisioning, and broadcasting; this file is the rules.
 *
 * Two players, one shared pool of word concepts. Every volley both players are dealt the SAME
 * two concepts, each in their own study language. The shooter fires one of them across the
 * court; it flies at the blocker showing its meaning (in the blocker's own language), and the
 * blocker has until it lands to hit it back with the matching card. A correct block scores the
 * blocker a point; a wrong card or a missed ball scores nothing — there are no minus points.
 * Then the roles swap: the blocker serves the next volley. The match ends after every player
 * has served the agreed number of shots; the highest score wins.
 *
 * Cross-language: concepts are keyed by their English word, so a Greek learner can block a
 * Russian learner's shot — each sees the concept in their own study language.
 *
 * `playerId` throughout is the stable per-match userId (survives reconnects).
 */
import type { CardTranslation, GameModule, GameResult, MatchContext } from '@memdecks/mp-types';
import { pick, shuffled } from './random';

/** Cards each player holds per volley — the shooter picks one, the blocker must find it. */
const HAND_SIZE = 2;
/** Fewest distinct concepts a match needs, pooled from both decks. */
const MIN_CONCEPTS = 6;
/** Countdown before the very first serve, so both players are looking at the court. */
const READY_MS = 2_500;
/** How long the shooter may aim before a random card is fired for them. */
const AIM_MS = 10_000;
/** How long a volley's outcome stays on screen before the next serve. */
const RESULT_MS = 2_600;
/** How long a disconnected player may stay away before forfeiting the match. */
const FORFEIT_GRACE_MS = 30_000;
const DEFAULT_SHOTS_PER_PLAYER = 10;
/** Ball flight time = the blocker's window to answer. */
const SPEEDS = { relaxed: 8_000, normal: 6_000, fast: 4_000 } as const;
type Speed = keyof typeof SPEEDS;

type Phase = 'PLAYING' | 'GAME_OVER';
type Stage = 'ready' | 'aim' | 'flight' | 'result';
type Outcome = 'blocked' | 'wrong' | 'missed';

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

interface Volley {
  /** 1-based. */
  number: number;
  shooterId: string;
  blockerId: string;
  /** Concept ids in each player's hand. Same concepts, independently shuffled order. */
  hands: Record<string, string[]>;
  stage: Stage;
  /** Epoch ms when the current stage ends. */
  until: number;
  shotId: string | null;
  blockId: string | null;
  outcome: Outcome | null;
  /** The shooter ran out of aiming time and a random card was fired for them. */
  autoShot: boolean;
}

interface VolleyRecord {
  number: number;
  shooterId: string;
  blockerId: string;
  conceptId: string;
  blockId: string | null;
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
  /** Concept ids not yet dealt this cycle; refilled (reshuffled) when it runs dry. */
  queue: string[];
  scores: Record<string, number>;
  volley: Volley | null;
  totalVolleys: number;
  flightMs: number;
  history: VolleyRecord[];
  phase: Phase;
  winnerId: string | null;
  message: string;
  sound: Record<string, SoundCue>;
  /** Epoch ms when a player disconnected mid-match; cleared on return. */
  absentSince: Record<string, number>;
}

export type PongAction =
  | { action: 'shoot'; payload?: { cardId?: string } }
  | { action: 'block'; payload?: { cardId?: string } };

// ── language + concept helpers ────────────────────────────────────────────────

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

/** Two concepts can share a volley only if no player would see them as the same word — on the
 *  card (study language) or on the ball (base language). */
function distinguishable(state: PongState, a: Concept, b: Concept): boolean {
  for (const playerId of state.players) {
    const lang = state.studyLanguages[playerId] ?? '';
    const base = state.baseLanguages[playerId] ?? 'en';
    if (normalize(wordFor(a, lang)?.word ?? '') === normalize(wordFor(b, lang)?.word ?? '')) return false;
    if (normalize(promptFor(a, base)) === normalize(promptFor(b, base))) return false;
  }
  return true;
}

/** Deal the next volley's concepts: mutually distinguishable, cycling the whole pool before
 *  any concept repeats. */
function drawHand(state: PongState): string[] {
  const all = Object.keys(state.concepts);
  const hand: string[] = [];
  const fits = (id: string) =>
    !hand.includes(id) && hand.every((h) => distinguishable(state, state.concepts[h]!, state.concepts[id]!));
  while (hand.length < HAND_SIZE) {
    if (state.queue.length === 0) state.queue = shuffled(all.filter((id) => !hand.includes(id)));
    const index = state.queue.findIndex(fits);
    if (index >= 0) {
      hand.push(state.queue.splice(index, 1)[0]!);
      continue;
    }
    // Nothing left in this cycle fits next to the cards already dealt: reach into the full pool.
    const fallback = shuffled(all).find(fits) ?? shuffled(all).find((id) => !hand.includes(id));
    if (!fallback) break;
    hand.push(fallback);
  }
  return hand;
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

// ── volley flow ───────────────────────────────────────────────────────────────

function startVolley(state: PongState, number: number, shooterId: string, stage: 'ready' | 'aim'): void {
  const blockerId = opponentOf(state, shooterId);
  if (!blockerId) return;
  const dealt = drawHand(state);
  const hands: Record<string, string[]> = {};
  for (const playerId of state.players) hands[playerId] = shuffled(dealt);
  state.volley = {
    number,
    shooterId,
    blockerId,
    hands,
    stage,
    until: Date.now() + (stage === 'ready' ? READY_MS : AIM_MS),
    shotId: null,
    blockId: null,
    outcome: null,
    autoShot: false,
  };
  state.message = stage === 'ready' ? `${nameOf(state, shooterId)} serves first.` : `${nameOf(state, shooterId)} is aiming…`;
}

function shoot(state: PongState, playerId: string, cardId: string, auto = false): void {
  const v = state.volley;
  if (state.phase !== 'PLAYING' || !v || v.stage !== 'aim' || v.shooterId !== playerId) return;
  if (!v.hands[playerId]?.includes(cardId)) return;
  v.shotId = cardId;
  v.autoShot = auto;
  v.stage = 'flight';
  v.until = Date.now() + state.flightMs;
  cue(state, playerId, cardId);
  state.message = auto
    ? `${nameOf(state, playerId)} ran out of time — a random word flies!`
    : `${nameOf(state, playerId)} shoots!`;
}

function block(state: PongState, playerId: string, cardId: string): void {
  const v = state.volley;
  if (state.phase !== 'PLAYING' || !v || v.stage !== 'flight' || v.blockerId !== playerId) return;
  if (!v.hands[playerId]?.includes(cardId)) return;
  v.blockId = cardId;
  resolveVolley(state, cardId === v.shotId ? 'blocked' : 'wrong');
}

function resolveVolley(state: PongState, outcome: Outcome): void {
  const v = state.volley;
  if (!v || !v.shotId) return;
  v.outcome = outcome;
  v.stage = 'result';
  v.until = Date.now() + RESULT_MS;
  if (outcome === 'blocked') state.scores[v.blockerId] = (state.scores[v.blockerId] ?? 0) + 1;
  state.history.push({
    number: v.number,
    shooterId: v.shooterId,
    blockerId: v.blockerId,
    conceptId: v.shotId,
    blockId: v.blockId,
    outcome,
  });
  // The blocker hears the word they had to find, right or wrong.
  cue(state, v.blockerId, v.shotId);
  const blocker = nameOf(state, v.blockerId);
  state.message =
    outcome === 'blocked' ? `${blocker} blocked it! +1`
      : outcome === 'wrong' ? `${blocker} hit back the wrong word.`
        : `${blocker} missed the ball.`;
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
  if (state.volley && state.volley.stage !== 'result') state.volley = null;
}

function nextVolley(state: PongState): void {
  const v = state.volley;
  if (!v) return;
  if (v.number >= state.totalVolleys) {
    finish(state, 'All shots played. Highest score wins.');
    return;
  }
  // Roles swap: the blocker serves next.
  startVolley(state, v.number + 1, v.blockerId, 'aim');
}

function readSettings(settings: Record<string, unknown>): { shots: number; flightMs: number } {
  const shots = Number(settings.shots);
  const speed = String(settings.speed ?? 'normal');
  return {
    shots: Number.isInteger(shots) && shots > 0 && shots <= 50 ? shots : DEFAULT_SHOTS_PER_PLAYER,
    flightMs: speed in SPEEDS ? SPEEDS[speed as Speed] : SPEEDS.normal,
  };
}

// ── module ────────────────────────────────────────────────────────────────────

export const wordPongModule: GameModule<PongState, PongAction> = {
  manifest: {
    id: 'word-pong',
    title: 'Word Pong',
    minPlayers: 2,
    maxPlayers: 2,
    settingsSchema: [
      {
        key: 'shots',
        label: 'Shots per player',
        type: 'select',
        default: DEFAULT_SHOTS_PER_PLAYER,
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
    const { shots, flightMs } = readSettings(ctx.settings);

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
      queue: [],
      scores,
      volley: null,
      totalVolleys: shots * players.length,
      flightMs,
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

    state.phase = 'PLAYING';
    startVolley(state, 1, players[0]!, 'ready');
    return state;
  },

  applyAction(state, playerId, action) {
    const cardId = action.payload?.cardId;
    if (typeof cardId !== 'string') return;
    if (action.action === 'shoot') shoot(state, playerId, cardId);
    else if (action.action === 'block') block(state, playerId, cardId);
  },

  viewFor(state, playerId) {
    const lang = state.studyLanguages[playerId] ?? '';
    const base = state.baseLanguages[playerId] ?? 'en';
    const v = state.volley;
    const role = !v ? null : v.shooterId === playerId ? ('shooter' as const) : ('blocker' as const);
    const revealed = v?.stage === 'result';

    const cardView = (conceptId: string, withPrompt: boolean) => {
      const concept = state.concepts[conceptId];
      if (!concept) return null;
      const translation = wordFor(concept, lang);
      const audio = audioFor(state, concept, playerId);
      return {
        id: conceptId,
        word: translation?.word ?? concept.english,
        ...(translation?.transliteration ? { transliteration: translation.transliteration } : {}),
        // The meaning is the answer — only shown once the volley is decided.
        ...(withPrompt ? { prompt: promptFor(concept, base) } : {}),
        partOfSpeech: concept.partOfSpeech,
        ...(audio ? { audio } : {}),
      };
    };

    const hand = (v?.hands[playerId] ?? [])
      .map((id) => cardView(id, revealed))
      .filter((card) => card !== null);

    // What rides on the ball: the shooter sees the word they fired; the blocker sees only its
    // meaning until the volley is decided.
    let ball: Record<string, unknown> | null = null;
    if (v?.shotId && (v.stage === 'flight' || v.stage === 'result')) {
      const shot = state.concepts[v.shotId];
      if (shot) {
        const showWord = role === 'shooter' || revealed;
        const showPrompt = role === 'blocker' || revealed;
        ball = {
          from: role === 'shooter' ? 'me' : 'opponent',
          ...(showWord ? { word: wordFor(shot, lang)?.word ?? shot.english } : {}),
          ...(showPrompt ? { prompt: promptFor(shot, base) } : {}),
        };
      }
    }

    const now = Date.now();
    const stageDuration = !v ? 0
      : v.stage === 'ready' ? READY_MS
        : v.stage === 'aim' ? AIM_MS
          : v.stage === 'flight' ? state.flightMs
            : RESULT_MS;

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
      volley: v
        ? {
          number: v.number,
          total: state.totalVolleys,
          stage: v.stage,
          role,
          shooterId: v.shooterId,
          blockerId: v.blockerId,
          remainingMs: Math.max(0, v.until - now),
          durationMs: stageDuration,
          hand,
          // Each side learns the other's pick only once it can no longer help them.
          shotId: role === 'shooter' || revealed ? v.shotId : null,
          blockId: role === 'blocker' || revealed ? v.blockId : null,
          outcome: revealed ? v.outcome : null,
          autoShot: v.autoShot,
          ball,
        }
        : null,
      winnerId: state.winnerId,
      message: state.message,
      sound: state.sound[playerId] ?? { token: 0 },
      // The end-of-match review: every shot, in this player's languages.
      history: state.phase === 'GAME_OVER'
        ? state.history.map((record) => {
          const card = cardView(record.conceptId, true);
          return {
            number: record.number,
            shooterId: record.shooterId,
            blockerId: record.blockerId,
            outcome: record.outcome,
            ...(card ? { word: card.word, prompt: card.prompt ?? '' } : { word: '', prompt: '' }),
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

  /** Advance the volley clock; forfeit a disconnected player past grace. */
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

    const v = state.volley;
    if (!v || now < v.until) return;
    switch (v.stage) {
      case 'ready':
        v.stage = 'aim';
        v.until = now + AIM_MS;
        state.message = `${nameOf(state, v.shooterId)} is aiming…`;
        return;
      case 'aim': {
        const random = pick(v.hands[v.shooterId] ?? []);
        if (random) shoot(state, v.shooterId, random, true);
        return;
      }
      case 'flight':
        resolveVolley(state, 'missed');
        return;
      case 'result':
        nextVolley(state);
        return;
    }
  },

  nextDelayMs(state) {
    if (state.phase !== 'PLAYING') return null;
    const deadlines = Object.values(state.absentSince).map((since) => since + FORFEIT_GRACE_MS);
    if (state.volley) deadlines.push(state.volley.until);
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
