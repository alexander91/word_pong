/**
 * Entry point. Runs Word Pong as a standalone mp-runtime server: the SDK owns transport,
 * the match lobby, ticket verification, card provisioning, and broadcasting. This game only
 * ever runs a match the platform (or the emulator) already formed.
 *
 * Env (see ./config/env which loads .env into process.env):
 *   PORT, CLIENT_ORIGINS, TRANSLATOR_API_BASE,
 *   and one of MATCH_JWKS_URL (prod) / MATCH_TICKET_SECRET (dev).
 *
 * Cards come from the runtime's default provider, which normalizes `/api/cards` rows —
 * including pairs without English — into SDK `Card`s.
 */
import './config/env';
import { createMultiplayerServer } from '@memdecks/mp-runtime';
import { wordPongModule } from './module';

createMultiplayerServer({ game: wordPongModule });
