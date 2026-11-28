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
  assert.equal(s.wordLimit, 100);
  assert.equal(s.pointsToWin, 5);
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
  // The server watches the same meaning fly away, so Ann sees what Ben is being asked.
  const annView = game.viewFor(s, 'u1');
  assert.equal(annView.ball.direction, 'outgoing');
  assert.equal(annView.ball.label, s.concepts[target(s)].english);
  assert(!JSON.stringify(annView.ball).includes(target(s)));

  // Only the receiver can swing.
  game.applyAction(s, 'u1', { action: 'hit', payload: { cardId: s.hands.u1[0] } });
  assert.equal(s.ball.number, 1);

  age(s, 0.5);
  const hitWith = target(s);
  const oldHand = [...s.hands.u2];
  swing(s, hitWith);
  // A return scores nothing: points only come from the other player's misses.
  assert.deepEqual(s.scores, { u1: 0, u2: 0 });
  // Straight back, no pause: ball 2 is already flying at Ann, leaving from where Ben hit it.
  assert.equal(s.stage, 'flight');
  assert.equal(s.ball.number, 2);
  assert.equal(s.ball.fromId, 'u2');
  assert.equal(s.ball.toId, 'u1');
  const contact = travel(0.5); // ball 1 started at the far end
  assert(Math.abs(s.ball.startPos - (1 - contact)) < 0.02, `return starts at the contact point (${s.ball.startPos})`);
  // Ben got a fresh pair and, on the ball going away, the meaning Ann now has to answer.
  assert.notDeepEqual(s.hands.u2, oldHand);
  const after = game.viewFor(s, 'u2');
  assert.equal(after.ball.direction, 'outgoing');
  assert.equal(after.ball.label, s.concepts[target(s)].english);
  assert.equal(game.viewFor(s, 'u1').ball.label, after.ball.label);
  assert.equal(after.myResult.outcome, 'hit');
  assert.equal(after.myResult.target.prompt, s.concepts[hitWith].english);
  assert.equal(game.viewFor(s, 'u1').opponentResult.outcome, 'hit');
  assert.equal(game.viewFor(s, 'u1').opponentResult.target, undefined);
  // He hears the word he hit.
  assert.equal(after.sound.token, 1);
}

// ── a wrong card or a late swing is a point to the other player; the word comes back later ──
{
  const s = await fresh();
  elapse(s); // Ann serves to Ben
  const missedWord = target(s);
  swing(s, wrongCard(s));
  assert.deepEqual(s.scores, { u1: 1, u2: 0 });
  assert.match(s.message, /Point to Ann/);
  assert.equal(s.stage, 'pause');
  assert.equal(s.ball.outcome, 'wrong');
  const benView = game.viewFor(s, 'u2');
  assert.equal(benView.myResult.outcome, 'wrong');
  assert.equal(benView.myResult.target.prompt, s.concepts[missedWord].english);
  assert.equal(benView.ball.state, 'missed');
  assert(s.queues.u2.includes(missedWord), 'a missed word is queued for another try');

  // Swinging during the pause does nothing.
  game.applyAction(s, 'u2', { action: 'hit', payload: { cardId: s.hands.u2[0] } });
  assert.deepEqual(s.scores, { u1: 1, u2: 0 });

  elapse(s); // pause over: Ben, who missed, serves ball 2 to Ann
  assert.equal(s.ball.number, 2);
  assert.equal(s.ball.fromId, 'u2');
  assert.equal(s.ball.startPos, 0);
  elapse(s); // Ann lets it land
  assert.equal(s.ball.outcome, 'missed');
  assert.equal(s.ball.contactPos, 1);
  assert.deepEqual(s.scores, { u1: 1, u2: 1 });
  assert.equal(game.viewFor(s, 'u1').players[1].score, 1);
}

/** Play until the match ends; `answer(receiverId)` says whether that receiver hits. */
function playOut(s, answer) {
  const receivers = [];
  while (s.phase === 'PLAYING') {
    if (s.stage !== 'flight') { elapse(s); continue; }
    receivers.push(s.ball.toId);
    swing(s, answer(s.ball.toId, s.ball.number) ? target(s) : wrongCard(s));
  }
  return receivers;
}

// ── first to the target wins: the ball alternates, the setting decides how many points ──
{
  const s = await fresh({ settings: { points: 3, speed: 'fast' } });
  assert.equal(s.pointsToWin, 3);
  assert.equal(s.flightMs, 4000);
  // Ben always hits, Ann always swings the other card: every one of Ann's balls is Ben's point.
  const receivers = playOut(s, (id) => id === 'u2');
  assert.deepEqual(receivers, ['u2', 'u1', 'u2', 'u1', 'u2', 'u1']);
  assert.equal(s.history.length, 6);
  assert.deepEqual(s.scores, { u1: 0, u2: 3 });
  assert.equal(s.winnerId, 'u2');
  assert.equal(s.message, 'Ben wins 3–0.');
  assert.deepEqual(game.isOver(s), { outcome: 'decided', scores: { u1: 0, u2: 3 } });
  const review = game.viewFor(s, 'u1').history.filter((row) => row.receiverId === 'u1');
  assert.equal(review.length, 3);
  assert(review.every((row) => row.word && row.prompt && row.outcome === 'wrong'));
}

// ── an unknown points setting falls back to 5 ──
{
  const s = await fresh({ settings: { points: 'lots' } });
  assert.equal(s.pointsToWin, 5);
  assert.equal(game.viewFor(s, 'u1').pointsToWin, 5);
  assert.equal(game.viewFor(s, 'u1').wordLimit, 100);
}

// ── 100 words with nobody missing is a draw; the last word is returned to nobody ──
{
  const s = await fresh();
  const receivers = playOut(s, () => true);
  assert.equal(receivers.length, 100);
  assert.equal(s.ball.number, 100);
  assert.equal(game.viewFor(s, 'u1').ball, null); // the table is cleared at game over
  assert.deepEqual(s.scores, { u1: 0, u2: 0 });
  assert.equal(s.winnerId, null);
  assert.equal(s.message, '100 words played. Draw at 0–0.');
  assert.equal(game.isOver(s).outcome, 'draw');
}

// ── at the word limit the leader wins, even short of the target ──
{
  const s = await fresh({ settings: { points: 10 } });
  // Ben misses the first ball, then nobody misses again.
  const receivers = playOut(s, (id, number) => number !== 1);
  assert.equal(receivers.length, 100);
  assert.deepEqual(s.scores, { u1: 1, u2: 0 });
  assert.equal(s.winnerId, 'u1');
  assert.equal(s.message, '100 words played. Ann wins 1–0.');
}

// ── the last word missed still scores before the match ends ──
{
  const s = await fresh();
  elapse(s);
  s.wordLimit = 2;
  swing(s, target(s)); // Ben returns ball 1
  swing(s, wrongCard(s)); // Ann misses ball 2, the last one
  assert.deepEqual(s.scores, { u1: 0, u2: 1 });
  assert.equal(s.afterPause, 'finish');
  elapse(s);
  assert.equal(s.phase, 'GAME_OVER');
  assert.equal(s.winnerId, 'u2');
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

  // Ben reads meanings in German: the ball at him asks in German, while Ann watches the same
  // question leave in English — never Ben's Greek word.
  const t = await fresh({
    players: [
      { userId: 'u1', name: 'Ann', seat: 0, language: 'ru' },
      { userId: 'u2', name: 'Ben', seat: 1, language: 'el', baseLanguage: 'de' },
    ],
    cards: { u1: deck('ru', 4), u2: deck('el', 4, 2) },
    translate,
  });
  elapse(t); // Ann serves to Ben
  const asked = t.concepts[target(t)];
  assert.equal(game.viewFor(t, 'u2').ball.label, `de:${asked.english}`);
  assert.equal(game.viewFor(t, 'u1').ball.label, asked.english);
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
  // Every ball lands untouched; a long match keeps dealing for all 40 balls.
  const s = await fresh({ cards: { u1: cards, u2: cards }, settings: { points: 21 } });
  const [a, b] = Object.values(s.concepts).filter((c) => c.wordByLang.ru.word === 'ru0').map((c) => c.id);
  for (let i = 0; i < 40; i += 1) {
    assert.equal(s.phase, 'PLAYING');
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
