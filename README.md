# word_pong
Fast paced pvp word studying

A two-player word duel on the Translator / memdecks stack (same stack as Mirror Decks):
authoritative `@memdecks/mp-runtime` server, React + Vite client, and the players' own
Translator cards.

## How to play

1. Two players join a match. Both players' decks are pooled into one set of words, keyed by
   meaning, so players studying different languages can play each other.
2. Each shot, **both players get the same two cards**, each shown in their own study language.
3. **The shooter** taps one of their two words to shoot it across the court.
4. The ball flies at **the blocker** showing the word's *meaning* (in the blocker's own
   language). Before it lands, the blocker taps the card with the matching word to hit it back.
5. **Correct block: +1 point for the blocker.** A wrong card or a missed ball scores nothing.
   There are no minus points.
6. Then the roles swap: the blocker shoots next, the shooter blocks.
7. After every player has shot the agreed number of times (default 10 each), the highest score
   wins. The end screen lists every word you had to block, with pronunciation.

Timers keep the pace up: the shooter has 10 s to aim (then a random card flies), and the blocker
has the ball's flight time (8 s / 6 s / 4 s for relaxed / normal / fast). Keys `1`/`2`
(or ←/→, A/D) pick the left/right card.

Match settings (lobby): **Shots per player** 5 / 10 / 15, **Ball speed** relaxed / normal / fast.
A match needs at least 6 words playable in every player's language.

## Layout

- `server/` — `src/module.ts` is the whole rule set (a `GameModule`); `src/server.ts` starts
  the mp-runtime. `npm test` builds and runs `rules-smoke.mjs`, which plays matches against
  the module directly.
- `client/` — `src/pages/Game.tsx` renders the court from the server's per-player view and
  sends `shoot` / `block` actions.

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
