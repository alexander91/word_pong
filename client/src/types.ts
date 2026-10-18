/** Mirrors the server's `viewFor` output (the `mp:state` payload). */

export type GamePhase = 'PLAYING' | 'GAME_OVER';
export type Stage = 'ready' | 'aim' | 'flight' | 'result';
export type Outcome = 'blocked' | 'wrong' | 'missed';
export type Role = 'shooter' | 'blocker';

/** Pronunciation source: the player's own card, or a word spoken by text. */
export type AudioRef = { cardId: string } | { text: string; lang: string };

export interface PlayerView {
  id: string;
  name: string;
  score: number;
  present: boolean;
}

export interface HandCard {
  /** Concept id — the same on both players' hands. */
  id: string;
  /** The word in this viewer's study language. */
  word: string;
  transliteration?: string;
  /** The meaning in the viewer's own language — only sent once the volley is decided. */
  prompt?: string;
  partOfSpeech: string;
  audio?: AudioRef;
}

export interface BallView {
  /** Who fired it, from this viewer's side of the table. */
  from: 'me' | 'opponent';
  /** The study-language word (shooter, or anyone once decided). */
  word?: string;
  /** Its meaning in the viewer's language (blocker, or anyone once decided). */
  prompt?: string;
}

export interface VolleyView {
  number: number;
  total: number;
  stage: Stage;
  role: Role | null;
  shooterId: string;
  blockerId: string;
  /** Time left in the current stage when the server sent this view. */
  remainingMs: number;
  durationMs: number;
  hand: HandCard[];
  shotId: string | null;
  blockId: string | null;
  outcome: Outcome | null;
  autoShot: boolean;
  ball: BallView | null;
}

export interface HistoryRow {
  number: number;
  shooterId: string;
  blockerId: string;
  outcome: Outcome;
  word: string;
  prompt: string;
  audio?: AudioRef;
}

/** One-shot pronunciation cue: play `audio` whenever `token` increments. */
export interface SoundCue {
  token: number;
  audio?: AudioRef;
}

export interface GameState {
  phase: GamePhase;
  you: string;
  studyLanguage: string | null;
  players: PlayerView[];
  volley: VolleyView | null;
  winnerId: string | null;
  message: string;
  sound: SoundCue;
  history: HistoryRow[];
}
