# Repository launch rule

Always launch this game through the local Translator emulator. Do not start the game server or
Vite client directly: a standalone client cannot receive the platform handshake or signed match
ticket required to enter a match.

From the repository root, run `.claude\run-emulator.cmd`. It starts the complete two-player stack
and serves the playable emulator shell at `http://localhost:4106` (game server 4006, client 5178 —
see `memdecks_data/ports.json`).

Before launching, stop existing listeners on ports 4106, 4006, and 5178. Keep the emulator process
running for the user's test session; Ctrl+C stops the complete stack.

# Rules live on the server

`server/src/module.ts` is authoritative. The client only renders `viewFor` output and sends
`hit` actions. Never send the receiver the ball's target id or its study-language word while the
ball is in flight — only its meaning. The ball's `travel` curve exists twice (server
`module.ts`, client `Game.tsx`); change both together. Run `npm test` in `server/` after
changing the rules.

# Look

A table-tennis table seen from above, not an arcade: blue table, white lines and net, a white
ball, cards with a red rubber edge (yours) or black rubber backs (theirs). Sound stays off unless
the player turns pronunciation on.
