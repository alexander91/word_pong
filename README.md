# word_pong
Fast paced pvp word studying

A two-player word rally on the Translator / memdecks stack (same stack as Mirror Decks):
authoritative `@memdecks/mp-runtime` server, React + Vite client, and the players' own
Translator cards.

## How to play

1. Two players join a match. Both players' decks are pooled into one set of words, keyed by
   meaning, so players studying different languages can play each other.
2. Each player holds **two cards**, shown in their own study language. Point at a card to see its
   transliteration.
3. The ball flies at you carrying the *meaning* of one of your two cards (in your own language).
   Before it reaches your end of the table, tap the card with the matching word: the card swings
   out to the ball.
4. **Right card:** the ball bounces straight back to your opponent — already carrying the
   meaning of one of *their* cards. No pause: it is a rally.
5. **Wrong card, or too late: a point to your opponent.** Your note shows the word you needed;
   that word comes back a few balls later. Then you serve the next ball.
6. Either way you get a fresh pair the moment your ball is decided.
7. **First to 5 points wins** (3 / 5 / 10 in the lobby). A match also stops after **100 words**:
   the leader wins, and level scores — say a rally nobody missed — are a draw. The end screen
   lists every ball you had to answer, with pronunciation (turn it on with the speaker button).

The ball's flight time is the answer window (8 s / 6 s / 4 s for relaxed / normal / fast). It is
over the net quickly and slows down on your side. Keys `1`/`2` (or ←/→, A/D) swing the left/right
card.

Match settings (lobby): **Play to** 3 / 5 / 10 points, **Ball speed** relaxed / normal / fast.
A match needs at least 6 words playable in every player's language.

## Layout

- `server/` — `src/module.ts` is the whole rule set (a `GameModule`); `src/server.ts` starts
  the mp-runtime. `npm test` builds and runs `rules-smoke.mjs`, which plays matches against
  the module directly.
- `client/` — `src/pages/Game.tsx` renders the table from the server's per-player view and
  sends `hit` actions. It draws the ball on the same `travel` curve as the server.

## Local development and testing

Launch through the local Translator emulator (sibling `Translator_emulator` checkout). The game
client cannot run as a playable standalone page: it needs the platform handshake, signed match
tickets, card provisioning, and two-player match formation.

```powershell
cmd /c .claude\run-emulator.cmd
```

Open **http://localhost:4106** to play. It starts the platform on 4106, the game server on 4006,
and the client on 5178 (ports are registered in `memdecks_data/ports.json`). Both players appear
side by side in one tab. Ctrl+C stops the whole stack.

Set `EMULATOR_DIR` first if the emulator checkout lives elsewhere. To try a cross-language match,
set `EMU_PLAYERS` before launching, e.g. `$env:EMU_PLAYERS="ru,el"`.
