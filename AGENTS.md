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
`shoot` / `block` actions. Never send a blocker the shot's concept id or study-language word while
the ball is in flight — only its meaning. Run `npm test` in `server/` after changing the rules.
