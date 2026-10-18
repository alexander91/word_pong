import { useCallback, useEffect, useRef, useState } from 'react';
import {
  joinMatch, type GameSession, type MatchConnection, type TranslatorBridge,
} from '@memdecks/mp-client';
import type { MatchHandoff } from '@memdecks/mp-types';
import type { BallView, GameState, HandCard, HistoryRow, PlayerView, VolleyView } from '../types';
import { WordAudio } from '../audio/cardAudio';
import { Splash } from '../App';

interface Props {
  handoff: MatchHandoff;
  session: GameSession;
  /** The host bridge, for the end-of-match result report and the Play Again / Exit buttons. */
  bridge: TranslatorBridge;
}

/** Local deadline for the current stage, anchored when its view arrived (no server-clock skew). */
interface StageClock {
  key: string;
  deadline: number;
  duration: number;
  startedAt: number;
}

/** How long the outcome animation runs once a volley is decided. */
const RESULT_ANIM_MS = 900;

const SOUND_PREF_KEY = 'word-pong:sound';

function readSoundPref(): boolean {
  try { return localStorage.getItem(SOUND_PREF_KEY) === 'on'; } catch { return false; }
}

const stageKey = (v: VolleyView) => `${v.number}:${v.stage}`;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Re-render every animation frame while `active`; returns the current `performance.now()`. */
function useFrameNow(active: boolean): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const loop = () => { setNow(performance.now()); frame = requestAnimationFrame(loop); };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [active]);
  return now;
}

export default function Game({ handoff, session, bridge }: Props) {
  const [state, setState] = useState<GameState | null>(null);
  const [connError, setConnError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [clock, setClock] = useState<StageClock | null>(null);
  const connRef = useRef<MatchConnection | null>(null);
  const audioRef = useRef<WordAudio | null>(null);
  const lastSoundToken = useRef(0);
  const prevKeyRef = useRef<string | null>(null);
  // Pronunciation is opt-in: silent until the player turns it on (remembered per browser).
  const [soundOn, setSoundOn] = useState(readSoundPref);
  const soundOnRef = useRef(soundOn);
  const toggleSound = useCallback(() => {
    setSoundOn((on) => {
      const next = !on;
      soundOnRef.current = next;
      try { localStorage.setItem(SOUND_PREF_KEY, next ? 'on' : 'off'); } catch { /* storage blocked */ }
      if (!next) audioRef.current?.stop();
      return next;
    });
  }, []);

  useEffect(() => {
    audioRef.current = new WordAudio(session);
    return () => { audioRef.current?.dispose(); audioRef.current = null; };
  }, [session]);

  // Connect to the operator's mp-runtime with the signed handoff ticket.
  useEffect(() => {
    const conn = joinMatch<GameState>(handoff, {
      onState: (next) => {
        setState(next);
        setConnError(null);
        const v = next.volley;
        if (v) {
          const key = stageKey(v);
          const now = performance.now();
          setClock((current) => ({
            key,
            deadline: now + v.remainingMs,
            duration: v.durationMs,
            // A re-broadcast of the same stage keeps its original start (animations stay smooth).
            startedAt: current?.key === key ? current.startedAt : now,
          }));
          if (prevKeyRef.current !== key) {
            prevKeyRef.current = key;
            setPendingId(null);
          }
        }
        // One-shot pronunciation: play the cued word when the sound token advances.
        if (next.sound.token > lastSoundToken.current) {
          lastSoundToken.current = next.sound.token;
          if (soundOnRef.current) void audioRef.current?.play(next.sound.audio);
        }
      },
      onError: ({ message }) => setConnError(message),
      onConnectError: (err) => setConnError(err.message),
    });
    connRef.current = conn;
    return () => { conn.disconnect(); connRef.current = null; };
  }, [handoff]);

  // Tell the host the match finished — the platform treats `game:result` as the finished signal.
  // Driven off the state phase so a player who reconnects onto a finished match still reports.
  const reportedRef = useRef(false);
  useEffect(() => {
    if (!state || state.phase !== 'GAME_OVER' || reportedRef.current) return;
    reportedRef.current = true;
    const scores: Record<string, number> = {};
    for (const player of state.players) scores[player.id] = player.score;
    bridge.reportResult({
      outcome: !state.winnerId ? 'draw' : state.winnerId === state.you ? 'won' : 'lost',
      scores,
    });
  }, [state, bridge]);

  const volley = state?.phase === 'PLAYING' ? state.volley : null;
  const actionable =
    !!volley && !pendingId &&
    ((volley.role === 'shooter' && volley.stage === 'aim') || (volley.role === 'blocker' && volley.stage === 'flight'));

  const act = useCallback((card: HandCard) => {
    if (!volley || !actionable) return;
    setPendingId(card.id);
    connRef.current?.sendAction(volley.role === 'shooter' ? 'shoot' : 'block', { cardId: card.id });
  }, [volley, actionable]);

  // Keyboard: 1/2, ←/→ or A/D pick the left / right card.
  useEffect(() => {
    if (!volley || !actionable) return;
    const onKey = (event: KeyboardEvent) => {
      const index = ['1', 'ArrowLeft', 'a', 'A'].includes(event.key) ? 0
        : ['2', 'ArrowRight', 'd', 'D'].includes(event.key) ? 1 : -1;
      const card = index >= 0 ? volley.hand[index] : undefined;
      if (!card) return;
      event.preventDefault();
      act(card);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [volley, actionable, act]);

  if (!state) {
    return <Splash subtitle={connError ?? 'Waiting for your opponent…'} />;
  }

  const me = state.players.find((p) => p.id === state.you);
  const opponent = state.players.find((p) => p.id !== state.you);
  const shown = state.volley;
  const gameOver = state.phase === 'GAME_OVER';

  return (
    <div className="game">
      <Scoreboard me={me} opponent={opponent} volley={shown} soundOn={soundOn} onToggleSound={toggleSound} />
      <StageTimer volley={volley} clock={clock} />

      <div className="court">
        <OpponentPaddle volley={shown} opponent={opponent} />
        <Field volley={shown} clock={clock} names={state.players} />
        <MyPaddle volley={shown} pendingId={pendingId} actionable={actionable} onPick={act} />
      </div>

      <StatusLine state={state} opponent={opponent} connError={connError} />

      {gameOver && (
        <GameOver
          state={state}
          onPlay={(row) => void audioRef.current?.play(row.audio)}
          onRematch={() => bridge.rematch()}
          onExit={() => bridge.close()}
        />
      )}
    </div>
  );
}

// ── header ──────────────────────────────────────────────────────────────────

function Scoreboard({ me, opponent, volley, soundOn, onToggleSound }: {
  me: PlayerView | undefined;
  opponent: PlayerView | undefined;
  volley: VolleyView | null;
  soundOn: boolean;
  onToggleSound: () => void;
}) {
  return (
    <header className="scoreboard">
      <div className="score-side is-me">
        <span className="score-name">{me?.name ?? 'You'}</span>
        <span className="score-value">{me?.score ?? 0}</span>
      </div>
      <div className="score-mid">
        <span className="score-mid-label">Shot</span>
        <span className="score-mid-value">{volley ? `${volley.number}/${volley.total}` : '–'}</span>
        <button
          type="button"
          className={`sound-toggle ${soundOn ? 'is-on' : ''}`}
          onClick={onToggleSound}
          aria-pressed={soundOn}
          title={soundOn ? 'Turn pronunciation off' : 'Turn pronunciation on'}
        >
          {soundOn ? '🔊' : '🔇'}
        </button>
      </div>
      <div className="score-side is-opponent">
        <span className="score-value">{opponent?.score ?? 0}</span>
        <span className="score-name">
          {opponent?.name ?? 'Opponent'}
          {opponent && !opponent.present && <em className="score-away"> · away</em>}
        </span>
      </div>
    </header>
  );
}

/** Countdown bar for the shooter's aim window and the blocker's flight window. */
function StageTimer({ volley, clock }: { volley: VolleyView | null; clock: StageClock | null }) {
  const running = !!volley && !!clock && (volley.stage === 'aim' || volley.stage === 'flight');
  const now = useFrameNow(running);
  if (!running || !clock) return <div className="stage-timer is-idle" />;
  const fraction = clock.duration > 0 ? clamp01((clock.deadline - now) / clock.duration) : 0;
  const mine = (volley.role === 'shooter' && volley.stage === 'aim') || (volley.role === 'blocker' && volley.stage === 'flight');
  return (
    <div className={`stage-timer ${mine ? 'is-mine' : ''} ${fraction < 0.3 ? 'is-low' : ''}`}>
      <div className="stage-timer-bar" style={{ transform: `scaleX(${fraction})` }} />
    </div>
  );
}

// ── court ───────────────────────────────────────────────────────────────────

function OpponentPaddle({ volley, opponent }: { volley: VolleyView | null; opponent: PlayerView | undefined }) {
  const count = volley?.hand.length ?? 2;
  const decided = volley?.stage === 'result';
  // Both players hold the same concepts, so the opponent's pick can be shown from our own hand.
  const raised = decided && volley.role === 'shooter' && volley.blockId
    ? volley.hand.find((c) => c.id === volley.blockId)
    : undefined;
  const thinking =
    !!volley && ((volley.role === 'blocker' && volley.stage === 'aim') || (volley.role === 'shooter' && volley.stage === 'flight'));
  // The opponent's fired card has left their paddle — it is the ball.
  const fired = volley?.ball?.from === 'opponent';
  return (
    <div className={`paddle paddle-opponent ${thinking ? 'is-thinking' : ''}`} aria-label={`${opponent?.name ?? 'Opponent'}'s cards`}>
      {Array.from({ length: count }, (_, index) => {
        const showRaised = index === 0 && raised;
        const correct = showRaised && volley?.outcome === 'blocked';
        return (
          <div
            key={index}
            className={[
              'word-card is-back',
              showRaised ? `is-raised ${correct ? 'is-correct' : 'is-wrong'}` : '',
              fired && index === 0 ? 'is-empty' : '',
            ].filter(Boolean).join(' ')}
          >
            {showRaised ? <span className="card-word">{raised.word}</span> : <span className="card-back-mark">?</span>}
          </div>
        );
      })}
    </div>
  );
}

function MyPaddle({ volley, pendingId, actionable, onPick }: {
  volley: VolleyView | null;
  pendingId: string | null;
  actionable: boolean;
  onPick: (card: HandCard) => void;
}) {
  if (!volley) return <div className="paddle paddle-me" />;
  const decided = volley.stage === 'result';
  const mode = volley.role === 'shooter' ? 'shoot' : 'block';
  return (
    <div className={`paddle paddle-me ${actionable ? `is-${mode}-ready` : ''}`}>
      {volley.hand.map((card, index) => {
        const isShot = card.id === volley.shotId;
        const isBlock = card.id === volley.blockId;
        const classes = [
          'word-card',
          actionable ? 'is-actionable' : '',
          pendingId === card.id ? 'is-pending' : '',
          volley.role === 'shooter' && isShot && !decided ? 'is-fired' : '',
          decided && isShot ? 'is-correct' : '',
          decided && isBlock && !isShot ? 'is-wrong' : '',
          decided && !isShot && !isBlock ? 'is-dim' : '',
        ].filter(Boolean).join(' ');
        return (
          <button
            key={card.id}
            type="button"
            className={classes}
            disabled={!actionable}
            onClick={() => onPick(card)}
            aria-label={`${mode === 'shoot' ? 'Shoot' : 'Block with'} ${card.word}`}
          >
            <span className="card-key">{index + 1}</span>
            <span className="card-word">{card.word}</span>
            {card.transliteration && <span className="card-translit">{card.transliteration}</span>}
            {card.prompt && <span className="card-prompt">{card.prompt}</span>}
          </button>
        );
      })}
    </div>
  );
}

function Field({ volley, clock, names }: { volley: VolleyView | null; clock: StageClock | null; names: PlayerView[] }) {
  const nameOf = (id: string | undefined) => names.find((p) => p.id === id)?.name ?? 'Player';
  return (
    <div className="field">
      <div className="net" />
      {volley?.stage === 'ready' && (
        <ReadyCountdown
          clock={clock}
          label={volley.role === 'shooter' ? 'You serve first' : `${nameOf(volley.shooterId)} serves first`}
        />
      )}
      {volley?.stage === 'aim' && (
        <div className="field-hint">
          {volley.role === 'shooter'
            ? <>Your serve — <strong>tap a word</strong> to shoot it</>
            : <>{nameOf(volley.shooterId)} is aiming…</>}
        </div>
      )}
      {volley?.ball && clock && <Ball volley={volley} ball={volley.ball} clock={clock} />}
      {volley?.stage === 'result' && <ResultBanner volley={volley} blockerName={nameOf(volley.blockerId)} />}
    </div>
  );
}

function ReadyCountdown({ clock, label }: { clock: StageClock | null; label: string }) {
  const now = useFrameNow(!!clock);
  const seconds = clock ? Math.max(1, Math.ceil((clock.deadline - now) / 1000)) : 3;
  return (
    <div className="ready">
      <div className="ready-label">{label}</div>
      <div key={seconds} className="ready-count">{seconds}</div>
    </div>
  );
}

/**
 * The word in flight. Position runs 0 (shooter's paddle) → 1 (blocker's paddle) over the flight
 * window; once decided it bounces back (blocked), punches through (wrong), or drops (missed).
 */
function Ball({ volley, ball, clock }: { volley: VolleyView; ball: BallView; clock: StageClock }) {
  const decided = volley.stage === 'result';
  const now = useFrameNow(true);
  const lastPos = useRef(0);
  const seed = (volley.number * 1.7) % (Math.PI * 2);

  let pos: number;
  let opacity = 1;
  if (!decided) {
    pos = clock.duration > 0 ? clamp01(1 - (clock.deadline - now) / clock.duration) : 0;
    lastPos.current = pos;
  } else {
    const r = clamp01((now - clock.startedAt) / RESULT_ANIM_MS);
    const reach = Math.min(1, r / 0.25);
    const after = clamp01((r - 0.25) / 0.75);
    const toPaddle = lastPos.current + (1 - lastPos.current) * reach;
    if (volley.outcome === 'blocked') {
      pos = r < 0.25 ? toPaddle : 1 - after * 0.85;
    } else if (volley.outcome === 'wrong') {
      pos = r < 0.25 ? toPaddle : 1 + after * 0.12;
      opacity = 1 - after * 0.75;
    } else {
      pos = 1 + r * 0.06;
      opacity = 1 - r * 0.75;
    }
  }

  const y = ball.from === 'opponent' ? pos : 1 - pos;
  const x = 50 + Math.sin(pos * Math.PI * 2 + seed) * 16;
  // The blocker reads the meaning; the shooter tracks the word they fired.
  const label = volley.role === 'blocker' ? ball.prompt : ball.word;
  return (
    <div
      className={`ball ${decided ? `is-${volley.outcome}` : ''}`}
      style={{ top: `${y * 100}%`, left: `${x}%`, opacity }}
    >
      <span className="ball-label">{label}</span>
    </div>
  );
}

function ResultBanner({ volley, blockerName }: { volley: VolleyView; blockerName: string }) {
  const iBlocked = volley.role === 'blocker';
  const shot = volley.hand.find((c) => c.id === volley.shotId);
  const title =
    volley.outcome === 'blocked' ? (iBlocked ? 'Blocked! +1' : `${blockerName} blocked it`)
      : volley.outcome === 'wrong' ? 'Wrong word'
        : iBlocked ? 'Too slow!' : `${blockerName} missed`;
  return (
    <div className={`result-banner is-${volley.outcome}`}>
      <div className="result-title">{title}</div>
      {shot && (
        <div className="result-pair">
          <span className="result-word">{shot.word}</span>
          <span className="result-eq">=</span>
          <span className="result-prompt">{shot.prompt}</span>
        </div>
      )}
    </div>
  );
}

// ── footer + overlay ────────────────────────────────────────────────────────

function StatusLine({ state, opponent, connError }: { state: GameState; opponent: PlayerView | undefined; connError: string | null }) {
  const v = state.volley;
  let text = state.message;
  if (state.phase === 'PLAYING' && v?.role === 'blocker' && v.stage === 'flight' && v.ball?.prompt) {
    text = `Incoming! Hit back the word for “${v.ball.prompt}”`;
  } else if (state.phase === 'PLAYING' && v?.role === 'shooter' && v.stage === 'flight') {
    text = `${opponent?.name ?? 'Opponent'} is blocking…`;
  }
  return (
    <footer className={`status ${connError ? 'is-error' : ''}`}>
      {connError ?? text}
    </footer>
  );
}

function GameOver({ state, onPlay, onRematch, onExit }: {
  state: GameState;
  onPlay: (row: HistoryRow) => void;
  onRematch: () => void;
  onExit: () => void;
}) {
  const winner = state.players.find((p) => p.id === state.winnerId);
  const cancelled = state.history.length === 0;
  const title = cancelled ? 'No match' : !winner ? 'Draw' : winner.id === state.you ? 'You win!' : `${winner.name} wins`;
  const myBlocks = state.history.filter((row) => row.blockerId === state.you);
  const correct = myBlocks.filter((row) => row.outcome === 'blocked').length;
  return (
    <div className="overlay">
      <div className="overlay-card">
        <div className={`overlay-title ${winner?.id === state.you ? 'is-win' : ''}`}>{title}</div>
        {cancelled ? (
          <p className="overlay-text">{state.message}</p>
        ) : (
          <>
            <div className="overlay-scores">
              {state.players.map((p) => (
                <span key={p.id} className={p.id === state.you ? 'is-me' : ''}>{p.name} <strong>{p.score}</strong></span>
              ))}
            </div>
            <p className="overlay-text">You blocked {correct} of {myBlocks.length}. {state.message}</p>
            <ul className="review">
              {myBlocks.map((row) => (
                <li key={row.number} className={`review-row is-${row.outcome}`}>
                  <span className="review-mark">{row.outcome === 'blocked' ? '✓' : '✗'}</span>
                  <span className="review-word">{row.word}</span>
                  <span className="review-prompt">{row.prompt}</span>
                  {row.audio && (
                    <button type="button" className="review-sound" onClick={() => onPlay(row)} aria-label={`Play ${row.word}`}>
                      🔊
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="overlay-actions">
          <button type="button" className="btn btn-primary" onClick={onRematch} autoFocus>Play again</button>
          <button type="button" className="btn btn-ghost" onClick={onExit}>Exit</button>
        </div>
      </div>
    </div>
  );
}
