// Rules test for the Word Pong GameModule: drives matches directly, no sockets.
// Run with `npm test` (builds first).
import assert from 'node:assert/strict';
import { wordPongModule as game } from './dist/module.js';

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

/** Fast-forward the current stage's clock and tick once. */
function elapse(state) {
  state.volley.until = 0;
  game.tick(state);
}

/** The shooter's hand card that is NOT the shot (a wrong block). */
const otherCard = (state, playerId) => state.volley.hands[playerId].find((id) => id !== state.volley.shotId);

// ── a correct block scores the blocker, then roles swap ──
{
  const s = await fresh();
  assert.equal(s.phase, 'PLAYING');
  assert.equal(s.totalVolleys, 20);
  assert.equal(s.volley.stage, 'ready');
  assert.equal(s.volley.shooterId, 'u1');
  assert.equal(s.volley.blockerId, 'u2');
  // Both players hold the same two concepts.
  assert.equal(s.volley.hands.u1.length, 2);
  assert.deepEqual([...s.volley.hands.u1].sort(), [...s.volley.hands.u2].sort());

  // No shooting before the serve countdown ends.
  const [shot] = s.volley.hands.u1;
  game.applyAction(s, 'u1', { action: 'shoot', payload: { cardId: shot } });
  assert.equal(s.volley.stage, 'ready');
  elapse(s);
  assert.equal(s.volley.stage, 'aim');

  // The blocker cannot shoot; the shooter can.
  game.applyAction(s, 'u2', { action: 'shoot', payload: { cardId: shot } });
  assert.equal(s.volley.stage, 'aim');
  game.applyAction(s, 'u1', { action: 'shoot', payload: { cardId: shot } });
  assert.equal(s.volley.stage, 'flight');
  assert.equal(s.volley.shotId, shot);

  // In flight the blocker sees only the meaning, never the shot id or the word; their hand
  // shows only study-language words.
  const blockerView = game.viewFor(s, 'u2');
  assert.equal(blockerView.volley.shotId, null);
  assert.equal(blockerView.volley.ball.from, 'opponent');
  assert.equal(typeof blockerView.volley.ball.prompt, 'string');
  assert.equal(blockerView.volley.ball.word, undefined);
  assert(blockerView.volley.hand.every((card) => card.prompt === undefined));
  const shooterView = game.viewFor(s, 'u1');
  assert.equal(shooterView.volley.ball.from, 'me');
  assert.equal(shooterView.volley.ball.prompt, undefined);
  assert.equal(shooterView.volley.shotId, shot);

  game.applyAction(s, 'u2', { action: 'block', payload: { cardId: shot } });
  assert.equal(s.volley.stage, 'result');
  assert.equal(s.volley.outcome, 'blocked');
  assert.deepEqual(s.scores, { u1: 0, u2: 1 });
  // Once decided, both sides see everything.
  const revealed = game.viewFor(s, 'u1');
  assert.equal(revealed.volley.outcome, 'blocked');
  assert.equal(revealed.volley.blockId, shot);
  assert(revealed.volley.hand.every((card) => typeof card.prompt === 'string'));
  // The blocker hears the word they had to find.
  assert.equal(game.viewFor(s, 'u2').sound.token, 1);

  elapse(s);
  assert.equal(s.volley.number, 2);
  assert.equal(s.volley.stage, 'aim');
  assert.equal(s.volley.shooterId, 'u2');
  assert.equal(s.volley.blockerId, 'u1');
}

// ── a wrong block and a missed ball score nothing (no minus points) ──
{
  const s = await fresh();
  elapse(s); // ready → aim
  game.applyAction(s, 'u1', { action: 'shoot', payload: { cardId: s.volley.hands.u1[0] } });
  game.applyAction(s, 'u2', { action: 'block', payload: { cardId: otherCard(s, 'u2') } });
  assert.equal(s.volley.outcome, 'wrong');
  assert.deepEqual(s.scores, { u1: 0, u2: 0 });

  elapse(s); // → volley 2, u2 serves
  game.applyAction(s, 'u2', { action: 'shoot', payload: { cardId: s.volley.hands.u2[1] } });
  elapse(s); // the ball lands untouched
  assert.equal(s.volley.outcome, 'missed');
  assert.deepEqual(s.scores, { u1: 0, u2: 0 });
  // Blocking after the volley is decided changes nothing.
  game.applyAction(s, 'u1', { action: 'block', payload: { cardId: s.volley.shotId } });
  assert.deepEqual(s.scores, { u1: 0, u2: 0 });
}

// ── an idle shooter has a random card fired for them ──
{
  const s = await fresh();
  elapse(s); // ready → aim
  elapse(s); // aim runs out
  assert.equal(s.volley.stage, 'flight');
  assert.equal(s.volley.autoShot, true);
  assert(s.volley.hands.u1.includes(s.volley.shotId));
}

// ── a full match: settings decide its length, highest score wins ──
{
  const s = await fresh({ settings: { shots: 5, speed: 'fast' } });
  assert.equal(s.totalVolleys, 10);
  assert.equal(s.flightMs, 4000);
  elapse(s);
  while (s.phase === 'PLAYING') {
    const { shooterId, blockerId } = s.volley;
    game.applyAction(s, shooterId, { action: 'shoot', payload: { cardId: s.volley.hands[shooterId][0] } });
    // Ben always blocks right, Ann always picks the other card.
    const pickId = blockerId === 'u2' ? s.volley.shotId : otherCard(s, blockerId);
    game.applyAction(s, blockerId, { action: 'block', payload: { cardId: pickId } });
    elapse(s);
  }
  assert.equal(s.history.length, 10);
  assert.deepEqual(s.scores, { u1: 0, u2: 5 });
  assert.equal(s.winnerId, 'u2');
  assert.deepEqual(game.isOver(s), { outcome: 'decided', scores: { u1: 0, u2: 5 } });
  const review = game.viewFor(s, 'u1').history;
  assert.equal(review.length, 10);
  assert(review.every((row) => row.word && row.prompt));
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
  elapse(s);
  const annCards = game.viewFor(s, 'u1').volley.hand.map((c) => c.word);
  const benCards = game.viewFor(s, 'u2').volley.hand.map((c) => c.word);
  assert(annCards.every((w) => w.startsWith('ru')), annCards.join());
  assert(benCards.every((w) => w.startsWith('el')), benCards.join());
  // Own cards are pronounced by card id; translated words by text.
  const annAudio = game.viewFor(s, 'u1').volley.hand.map((c) => c.audio);
  assert(annAudio.every((a) => a && ('cardId' in a || a.lang === 'ru')));
}

// ── two meanings that look identical to a player never share a volley ──
{
  const cards = deck('ru', 8);
  cards[1].translations.ru.word = 'ru0'; // word0 and word1 are both "ru0" in Russian
  const s = await fresh({ cards: { u1: cards, u2: cards } });
  const [a, b] = Object.values(s.concepts).filter((c) => c.wordByLang.ru.word === 'ru0').map((c) => c.id);
  for (let i = 0; i < 40 && s.phase === 'PLAYING'; i += 1) {
    const hand = s.volley.hands.u1;
    assert(!(hand.includes(a) && hand.includes(b)), `volley ${s.volley.number} dealt two "ru0" cards`);
    if (s.volley.stage === 'ready') elapse(s);
    elapse(s); // aim → auto shot
    elapse(s); // flight → missed
    elapse(s); // result → next
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
