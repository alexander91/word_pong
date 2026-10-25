// Rules test for the Word Pong GameModule: drives matches directly, no sockets.
// Run with `npm test` (builds first).
import assert from 'node:assert/strict';
import { wordPongModule as game, travel } from './dist/module.js';

const deck = (lang, count, offset = 0) =>
  Array.from({ length: count }, (_, i) => ({
    id: `${lang}-card-${i + offset}`,
    english: `word${i + offset}`,
    partOfSpeech: 'noun',
    translations: { [lang]: { word: `${lang}${i + offset}` } },
  }));

const roster = (a = 'ru', b = 'ru') => [
  { userId: 'u1', name: 'Ann', seat: 0, language: a },
  { userId: 'u2', name: 'Ben', seat: 1, language: b },
];

async function fresh({ settings = {}, cards = { u1: deck('ru', 10), u2: deck('ru', 10) }, players = roster(), translate } = {}) {
  return game.createMatch({ matchId: 'rules', players, cards, settings, ...(translate ? { translate } : {}) });
}

/** End the countdown / pause, or land the ball in flight untouched. */
function elapse(state) {
  if (state.stage === 'flight') state.ball.startedAt = Date.now() - state.ball.durationMs - 1;
  else state.stageUntil = Date.now() - 1;
  game.tick(state);
}

/** Move the ball in flight to `progress` of its travel time. */
function age(state, timeFraction) {
  state.ball.startedAt = Date.now() - state.ball.durationMs * timeFraction;
}

const target = (s) => s.ball.targetId;
const wrongCard = (s) => s.hands[s.ball.toId].find((id) => id !== s.ball.targetId);
const swing = (s, cardId) => game.applyAction(s, s.ball.toId, { action: 'hit', payload: { cardId } });

// ── the serve, a hit, and the reflection that follows without a pause ──
{
  const s = await fresh();
  assert.equal(s.phase, 'PLAYING');
  assert.equal(s.stage, 'ready');
  assert.equal(s.totalBalls, 20);
  assert.equal(s.hands.u1.length, 2);
  assert.equal(s.hands.u2.length, 2);
  elapse(s); // countdown over: Ann serves
  assert.equal(s.stage, 'flight');
  assert.equal(s.ball.number, 1);
  assert.equal(s.ball.fromId, 'u1');
  assert.equal(s.ball.toId, 'u2');
  assert(s.hands.u2.includes(target(s)), 'the ball carries one of the receiver\'s cards');

  // The receiver sees only the meaning; never the target id or its study-language word.
  const benView = game.viewFor(s, 'u2');
  assert.equal(benView.ball.direction, 'incoming');
  assert.equal(benView.ball.label, s.concepts[target(s)].english);
  assert(!JSON.stringify(benView.ball).includes(target(s)));
  assert(benView.hand.every((card) => card.prompt === undefined));
  // The server sees a plain ball leave (it was a serve, nothing was hit).
  const annView = game.viewFor(s, 'u1');
  assert.equal(annView.ball.direction, 'outgoing');
  assert.equal(annView.ball.label, undefined);

  // Only the receiver can swing.
  game.applyAction(s, 'u1', { action: 'hit', payload: { cardId: s.hands.u1[0] } });
  assert.equal(s.ball.number, 1);

  age(s, 0.5);
  const hitWith = target(s);
  const oldHand = [...s.hands.u2];
  swing(s, hitWith);
  assert.deepEqual(s.scores, { u1: 0, u2: 1 });
  // Straight back, no pause: ball 2 is already flying at Ann, leaving from where Ben hit it.
  assert.equal(s.stage, 'flight');
  assert.equal(s.ball.number, 2);
  assert.equal(s.ball.fromId, 'u2');
  assert.equal(s.ball.toId, 'u1');
  assert.equal(s.ball.carriedId, hitWith);
  const contact = travel(0.5); // ball 1 started at the far end
  assert(Math.abs(s.ball.startPos - (1 - contact)) < 0.02, `return starts at the contact point (${s.ball.startPos})`);
  // Ben got a fresh pair and sees his hit word on the ball going away, plus his feedback.
  assert.notDeepEqual(s.hands.u2, oldHand);
  const after = game.viewFor(s, 'u2');
  assert.equal(after.ball.direction, 'outgoing');
  assert.equal(after.ball.label, s.concepts[hitWith].wordByLang.ru.word);
  assert.equal(after.myResult.outcome, 'hit');
  assert.equal(after.myResult.target.prompt, s.concepts[hitWith].english);
  assert.equal(game.viewFor(s, 'u1').opponentResult.outcome, 'hit');
  assert.equal(game.viewFor(s, 'u1').opponentResult.target, undefined);
  // He hears the word he hit.
  assert.equal(after.sound.token, 1);
}

// ── a wrong card or a late swing scores nothing, the right word comes back later ──
{
  const s = await fresh();
  elapse(s); // Ann serves to Ben
  const missedWord = target(s);
  swing(s, wrongCard(s));
  assert.deepEqual(s.scores, { u1: 0, u2: 0 });
  assert.equal(s.stage, 'pause');
  assert.equal(s.ball.outcome, 'wrong');
  const benView = game.viewFor(s, 'u2');
  assert.equal(benView.myResult.outcome, 'wrong');
  assert.equal(benView.myResult.target.prompt, s.concepts[missedWord].english);
  assert.equal(benView.ball.state, 'missed');
  assert(s.queues.u2.includes(missedWord), 'a missed word is queued for another try');

  // Swinging during the pause does nothing.
  game.applyAction(s, 'u2', { action: 'hit', payload: { cardId: s.hands.u2[0] } });
  assert.deepEqual(s.scores, { u1: 0, u2: 0 });

  elapse(s); // pause over: Ben, who missed, serves ball 2 to Ann
  assert.equal(s.ball.number, 2);
  assert.equal(s.ball.fromId, 'u2');
  assert.equal(s.ball.startPos, 0);
  elapse(s); // Ann lets it land
  assert.equal(s.ball.outcome, 'missed');
  assert.equal(s.ball.contactPos, 1);
  assert.deepEqual(s.scores, { u1: 0, u2: 0 });
}

// ── a full match: the ball alternates, settings decide its length, highest score wins ──
{
  const s = await fresh({ settings: { shots: 5, speed: 'fast' } });
  assert.equal(s.totalBalls, 10);
  assert.equal(s.flightMs, 4000);
  elapse(s);
  const receivers = [];
  while (s.phase === 'PLAYING') {
    if (s.stage !== 'flight') { elapse(s); continue; }
    receivers.push(s.ball.toId);
    // Ben always hits, Ann always swings the other card.
    swing(s, s.ball.toId === 'u2' ? target(s) : wrongCard(s));
  }
  assert.deepEqual(receivers, ['u2', 'u1', 'u2', 'u1', 'u2', 'u1', 'u2', 'u1', 'u2', 'u1']);
  assert.equal(s.history.length, 10);
  assert.deepEqual(s.scores, { u1: 0, u2: 5 });
  assert.equal(s.winnerId, 'u2');
  assert.deepEqual(game.isOver(s), { outcome: 'decided', scores: { u1: 0, u2: 5 } });
  const review = game.viewFor(s, 'u1').history.filter((row) => row.receiverId === 'u1');
  assert.equal(review.length, 5);
  assert(review.every((row) => row.word && row.prompt && row.outcome === 'wrong'));
}

// ── cross-language: decks pool by English, gaps are translated, each sees their own language ──
{
  const translate = async (words, langs) => {
    const out = {};
    for (const w of words) {
      out[w] = {};
      for (const l of langs) out[w][l] = { word: `${l}:${w}` };
    }
    return out;
  };
  const s = await fresh({
    players: roster('ru', 'el'),
    cards: { u1: deck('ru', 4), u2: deck('el', 4, 2) }, // overlap on word2, word3
    translate,
  });
  assert.equal(s.phase, 'PLAYING');
  assert.equal(Object.keys(s.concepts).length, 6);
  const annCards = game.viewFor(s, 'u1').hand.map((c) => c.word);
  const benCards = game.viewFor(s, 'u2').hand.map((c) => c.word);
  assert(annCards.every((w) => w.startsWith('ru')), annCards.join());
  assert(benCards.every((w) => w.startsWith('el')), benCards.join());
  // Own cards are pronounced by card id; translated words by text.
  const annAudio = game.viewFor(s, 'u1').hand.map((c) => c.audio);
  assert(annAudio.every((a) => a && ('cardId' in a || a.lang === 'ru')));
}

// ── the table is turned around for seat 1, so the ball's sideways path is mirrored ──
{
  const s = await fresh();
  elapse(s);
  const a = game.viewFor(s, 'u1').ball;
  const b = game.viewFor(s, 'u2').ball;
  assert.equal(a.startX + b.startX, 100);
  assert.equal(a.endX + b.endX, 100);
}

// ── two meanings that look identical to a player never share their hand ──
{
  const cards = deck('ru', 8);
  cards[1].translations.ru.word = 'ru0'; // word0 and word1 are both "ru0" in Russian
  const s = await fresh({ cards: { u1: cards, u2: cards } });
  const [a, b] = Object.values(s.concepts).filter((c) => c.wordByLang.ru.word === 'ru0').map((c) => c.id);
  for (let i = 0; i < 40 && s.phase === 'PLAYING'; i += 1) {
    for (const player of ['u1', 'u2']) {
      const hand = s.hands[player];
      assert(!(hand.includes(a) && hand.includes(b)), `ball ${s.ball?.number} dealt ${player} two "ru0" cards`);
    }
    elapse(s);
  }
}

// ── too few words: the match is cancelled up front ──
{
  const s = await fresh({ cards: { u1: deck('ru', 3), u2: deck('ru', 2) } });
  assert.equal(s.phase, 'GAME_OVER');
  assert.equal(game.isOver(s).outcome, 'cancelled');
}

// ── a player who stays away past the grace period forfeits ──
{
  const s = await fresh();
  elapse(s);
  game.onPresenceChange(s, 'u1', false);
  assert.equal(game.viewFor(s, 'u2').players[0].present, false);
  s.absentSince.u1 = Date.now() - 31_000;
  game.tick(s);
  assert.equal(s.phase, 'GAME_OVER');
  assert.equal(s.winnerId, 'u2');
}

console.log('word-pong rules: all checks passed');
