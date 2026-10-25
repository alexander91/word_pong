/** Mirrors the server's `viewFor` output (the `mp:state` payload). */

export type GamePhase = 'PLAYING' | 'GAME_OVER';
export type Stage = 'ready' | 'flight' | 'pause';
export type Outcome = 'hit' | 'wrong' | 'missed';

/** Pronunciation source: the player's own card, or a word spoken by text. */
export type AudioRef = { cardId: string } | { text: string; lang: string };

export interface PlayerView {
  id: string;
  name: string;
  score: number;
  present: boolean;
}

export interface HandCard {
  /** Opaque concept id. */
  id: string;
  /** The word in this viewer's study language. */
  word: string;
  transliteration?: string;
  /** The meaning in the viewer's own language — only sent once the ball is decided. */
  prompt?: string;
  partOfSpeech: string;
  audio?: AudioRef;
}

/**
 * The ball, from this viewer's side of the table. Its position runs 0 (sender's end) → 1
 * (receiver's end) along `travel(elapsed / duration)`, starting at `startPos`; sideways it moves
 * from `startX` to `endX` (0–100) on the same curve.
 */
export interface BallView {
  id: number;
  direction: 'incoming' | 'outgoing';
  /** `returned` = the last ball, hit back with no one left to receive it. */
  state: 'flying' | 'returned' | 'missed';
  startPos: number;
  startX: number;
  endX: number;
  durationMs: number;
  /** Time since it left, when the server sent this view. */
  elapsedMs: number;
  /** Where along its path it was decided (1 = it reached the receiver untouched). */
  contactPos: number | null;
  /** Incoming: the meaning to answer. Outgoing: the word you sent it with. */
  label?: string;
}

export interface ResultView {
  ball: number;
  outcome: Outcome;
  /** How long ago it was decided, when the server sent this view. */
  ageMs: number;
  /** The right card and the one swung — only on your own result. */
  target?: HandCard;
  picked?: HandCard;
}

export interface HistoryRow {
  number: number;
  receiverId: string;
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
  stage: Stage;
  stageRemainingMs: number;
  nextServerId: string | null;
  ballNumber: number;
  totalBalls: number;
  hand: HandCard[];
  opponentHandCount: number;
  ball: BallView | null;
  myResult: ResultView | null;
  opponentResult: ResultView | null;
  winnerId: string | null;
  message: string;
  sound: SoundCue;
  history: HistoryRow[];
}
