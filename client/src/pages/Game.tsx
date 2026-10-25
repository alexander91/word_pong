import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
  joinMatch, type GameSession, type MatchConnection, type TranslatorBridge,
} from '@memdecks/mp-client';
import type { MatchHandoff } from '@memdecks/mp-types';
import type { BallView, GameState, HandCard, HistoryRow, PlayerView, ResultView } from '../types';
import { WordAudio } from '../audio/cardAudio';
import { Splash } from '../App';
import Potato from '../Potato';

interface Props {
  handoff: MatchHandoff;
  session: GameSession;
  /** The host bridge, for the end-of-match result report and the Play Again / Exit buttons. */
  bridge: TranslatorBridge;
}

/** Local timing for the ball on screen, anchored when its view arrived (no server-clock skew). */
interface BallAnchor {
  id: number;
  /** `performance.now()` at which it leaves (held a moment after a hit, see CONTACT_MS). */
  start: number;
  /** `performance.now()` at which its miss / last return starts playing out (0 while flying). */
  decidedAt: number;
}

/** Where the ball was when you swung: it waits there for your card instead of flying on. */
interface Frozen {
  id: number;
  x: number;
  y: number;
}

interface Point {
  x: number;
  y: number;
}

/** A card swinging out to meet the ball. Drawn above the page so it outlives the hand being
 *  redealt the moment the server hears about the swing. */
interface Swing {
  key: string;
  side: 'me' | 'opponent';
  word?: string;
  from: DOMRect;
  /** The point on the ball the card's facing edge travels to. */
  to: Point;
}

interface Burst {
  key: string;
  at: Point;
  outcome: 'hit' | 'wrong';
}

/** How long a swinging card takes to reach the ball; the ball waits there for it. */
const CONTACT_MS = 200;
/** A missed ball rolling off the end of the table. */
const AFTERMATH_MS = 650;
/** How long your "hit / wrong" note stays up. */
const CHIP_MS = 2_000;
const SOUND_PREF_KEY = 'word-pong:sound';

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
/** The server's `travel` curve: fast over the net, slowing as it reaches the receiver. */
const travel = (t: number) => 0.45 * clamp01(t) + 0.55 * (1 - (1 - clamp01(t)) ** 3);

function readSoundPref(): boolean {
  try { return localStorage.getItem(SOUND_PREF_KEY) === 'on'; } catch { return false; }
}

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

/** Where the ball is on the table: x in %, y as a 0 (far end) → 1 (your end) fraction. */
function ballGeometry(ball: BallView, anchor: BallAnchor, now: number, frozen: Frozen | null) {
  if (frozen && frozen.id === ball.id && ball.state === 'flying') return { x: frozen.x, y: frozen.y, opacity: 1 };
  let pos: number;
  let x: number;
  let opacity = 1;
  if (ball.state === 'flying') {
    const progress = travel((now - anchor.start) / ball.durationMs);
    pos = ball.startPos + (1 - ball.startPos) * progress;
    x = ball.startX + (ball.endX - ball.startX) * progress;
  } else {
    const contact = ball.contactPos ?? 1;
    const span = 1 - ball.startPos || 1;
    const atContact = ball.startX + (ball.endX - ball.startX) * clamp01((contact - ball.startPos) / span);
    const r = clamp01((now - anchor.decidedAt) / AFTERMATH_MS);
    if (ball.state === 'missed') {
      // Past the receiver and off the end of the table.
      pos = contact + 0.2 * r;
      x = atContact + (ball.endX - ball.startX) * 0.2 * r;
      opacity = 1 - r;
    } else {
      // The last ball, hit back with nobody left to receive it.
      pos = contact - (contact + 0.05) * r;
      x = atContact + (50 - atContact) * 0.3 * r;
      opacity = 1 - 0.8 * r;
    }
  }
  return { x, y: ball.direction === 'incoming' ? pos : 1 - pos, opacity };
}

export default function Game({ handoff, session, bridge }: Props) {
  const [state, setState] = useState<GameState | null>(null);
  const [connError, setConnError] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<BallAnchor | null>(null);
  const [stageDeadline, setStageDeadline] = useState(0);
  const [frozen, setFrozen] = useState<Frozen | null>(null);
  const [swungBall, setSwungBall] = useState<number | null>(null);
  const [swungCardId, setSwungCardId] = useState<string | null>(null);
  const [swings, setSwings] = useState<Swing[]>([]);
  const [bursts, setBursts] = useState<Burst[]>([]);
  const [chip, setChip] = useState<ResultView | null>(null);
  // Pronunciation is opt-in: silent until the player turns it on (remembered per browser).
  const [soundOn, setSoundOn] = useState(readSoundPref);
  const soundOnRef = useRef(soundOn);
  const connRef = useRef<MatchConnection | null>(null);
  const audioRef = useRef<WordAudio | null>(null);
  const lastSoundToken = useRef(0);
  const ballRef = useRef<HTMLDivElement | null>(null);
  const myCardRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const opponentCardRefs = useRef<Array<HTMLDivElement | null>>([]);
  const seenResults = useRef({ mine: 0, theirs: 0 });

  useEffect(() => {
    audioRef.current = new WordAudio(session);
    return () => { audioRef.current?.dispose(); audioRef.current = null; };
  }, [session]);

  // Connect to the operator's mp-runtime with the signed handoff ticket.
  useEffect(() => {
    const conn = joinMatch<GameState>(handoff, {
      onState: (next) => {
        const now = performance.now();
        setState(next);
        setConnError(null);
        setStageDeadline(now + next.stageRemainingMs);
        const ball = next.ball;
        if (ball) {
          setAnchor((current) => {
            if (current && current.id === ball.id) {
              if (ball.state === 'flying' || current.decidedAt) return current;
              // Hold a swung-at ball where it was struck until the card gets there.
              return { ...current, decidedAt: now + ((ball.contactPos ?? 1) < 1 ? CONTACT_MS : 0) };
            }
            // A return leaves from where it was hit — once the hitting card has reached it.
            const hold = ball.startPos > 0 && ball.elapsedMs < CONTACT_MS ? CONTACT_MS : 0;
            return {
              id: ball.id,
              start: now - ball.elapsedMs + hold,
              decidedAt: ball.state === 'flying' ? 0 : now,
            };
          });
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

  const toggleSound = useCallback(() => {
    setSoundOn((on) => {
      const next = !on;
      soundOnRef.current = next;
      try { localStorage.setItem(SOUND_PREF_KEY, next ? 'on' : 'off'); } catch { /* storage blocked */ }
      if (!next) audioRef.current?.stop();
      return next;
    });
  }, []);

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

  const removeSwing = useCallback((key: string) => setSwings((all) => all.filter((s) => s.key !== key)), []);
  const removeBurst = useCallback((key: string) => setBursts((all) => all.filter((b) => b.key !== key)), []);

  // Freshly decided balls: your note, a flash where the ball was struck, and — on your screen —
  // the opponent's card swinging out to meet the ball.
  useLayoutEffect(() => {
    if (!state) return;
    const ballRect = ballRef.current?.getBoundingClientRect();
    const ballCenter = ballRect && { x: ballRect.left + ballRect.width / 2, y: ballRect.top + ballRect.height / 2 };

    const mine = state.myResult;
    if (mine && mine.ball !== seenResults.current.mine) {
      seenResults.current.mine = mine.ball;
      if (mine.ageMs < 1_500) {
        setChip(mine);
        if (mine.outcome !== 'missed' && ballCenter) {
          setBursts((all) => [...all, { key: `me-${mine.ball}`, at: ballCenter, outcome: mine.outcome === 'hit' ? 'hit' : 'wrong' }]);
        }
      }
    }

    const theirs = state.opponentResult;
    if (theirs && theirs.ball !== seenResults.current.theirs) {
      seenResults.current.theirs = theirs.ball;
      const cards = opponentCardRefs.current.filter((el): el is HTMLDivElement => !!el);
      const card = cards[Math.floor(Math.random() * cards.length)];
      if (theirs.ageMs < 1_500 && theirs.outcome !== 'missed' && ballRect && ballCenter && card) {
        setSwings((all) => [...all, {
          key: `opp-${theirs.ball}`,
          side: 'opponent',
          from: card.getBoundingClientRect(),
          to: { x: ballCenter.x, y: ballRect.top },
        }]);
        setBursts((all) => [...all, { key: `opp-${theirs.ball}`, at: ballCenter, outcome: theirs.outcome === 'hit' ? 'hit' : 'wrong' }]);
      }
    }
  }, [state]);

  useEffect(() => {
    if (!chip) return;
    const timer = setTimeout(() => setChip(null), Math.max(0, CHIP_MS - chip.ageMs));
    return () => clearTimeout(timer);
  }, [chip]);

  // A fresh pair is dealt the moment a ball is decided: none of it has been swung yet.
  const handKey = state?.hand.map((card) => card.id).join(',') ?? '';
  useEffect(() => setSwungCardId(null), [handKey]);

  const ball = state?.phase === 'PLAYING' ? state.ball : null;
  const canSwing =
    !!state && state.stage === 'flight' && !!ball && ball.direction === 'incoming' &&
    ball.state === 'flying' && swungBall !== ball.id && anchor?.id === ball.id;

  /** Swing a card at the incoming ball: the card flies out to wherever the ball is now. */
  const swing = useCallback((card: HandCard, cardEl: HTMLElement | null) => {
    if (!canSwing || !ball || !anchor) return;
    const geometry = ballGeometry(ball, anchor, performance.now(), null);
    setFrozen({ id: ball.id, x: geometry.x, y: geometry.y });
    setSwungBall(ball.id);
    setSwungCardId(card.id);
    const ballRect = ballRef.current?.getBoundingClientRect();
    if (cardEl && ballRect) {
      setSwings((all) => [...all, {
        key: `me-${ball.id}`,
        side: 'me',
        word: card.word,
        from: cardEl.getBoundingClientRect(),
        to: { x: ballRect.left + ballRect.width / 2, y: ballRect.bottom },
      }]);
    }
    connRef.current?.sendAction('hit', { cardId: card.id });
  }, [canSwing, ball, anchor]);

  // Keyboard: 1/2, ←/→ or A/D swing the left / right card.
  useEffect(() => {
    if (!canSwing || !state) return;
    const onKey = (event: KeyboardEvent) => {
      const index = ['1', 'ArrowLeft', 'a', 'A'].includes(event.key) ? 0
        : ['2', 'ArrowRight', 'd', 'D'].includes(event.key) ? 1 : -1;
      const card = index >= 0 ? state.hand[index] : undefined;
      if (!card) return;
      event.preventDefault();
      swing(card, myCardRefs.current[index] ?? null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canSwing, state, swing]);

  if (!state) {
    return <Splash subtitle={connError ?? 'Waiting for your opponent…'} />;
  }

  const me = state.players.find((p) => p.id === state.you);
  const opponent = state.players.find((p) => p.id !== state.you);
  const nameOf = (id: string | null) => state.players.find((p) => p.id === id)?.name ?? 'Player';
  const playing = state.phase === 'PLAYING';
  const waitingOnOpponent = playing && state.stage === 'flight' && ball?.direction === 'outgoing';

  return (
    <div className="game">
      <Potato />
      <Scoreboard
        me={me}
        opponent={opponent}
        ballNumber={state.ballNumber}
        totalBalls={state.totalBalls}
        soundOn={soundOn}
        onToggleSound={toggleSound}
      />

      <div className="arena">
        <div className={`paddle paddle-opponent ${waitingOnOpponent ? 'is-thinking' : ''}`} aria-label={`${opponent?.name ?? 'Opponent'}'s cards`}>
          {Array.from({ length: state.opponentHandCount || 2 }, (_, index) => (
            <div key={index} ref={(el) => { opponentCardRefs.current[index] = el; }} className="word-card is-back" />
          ))}
        </div>

        <div className="table">
          <div className="table-centerline" />
          <div className="net" />
          {playing && state.stage === 'ready' && (
            <ReadyCountdown
              deadline={stageDeadline}
              label={state.nextServerId === state.you ? 'You serve first' : `${nameOf(state.nextServerId)} serves first`}
            />
          )}
          {ball && anchor?.id === ball.id && <Ball ballRef={ballRef} ball={ball} anchor={anchor} frozen={frozen} />}
        </div>

        <div className={`paddle paddle-me ${canSwing ? 'is-ready' : ''}`}>
          {state.hand.map((card, index) => (
            <button
              key={card.id}
              ref={(el) => { myCardRefs.current[index] = el; }}
              type="button"
              className={`word-card ${canSwing ? 'is-actionable' : ''} ${swungCardId === card.id ? 'is-swung' : ''}`}
              disabled={!canSwing}
              onClick={(event) => swing(card, event.currentTarget)}
              aria-label={`Hit with ${card.word}`}
            >
              <span className="card-key">{index + 1}</span>
              <span className="card-word">{card.word}</span>
              {card.transliteration && <span className="card-translit">{card.transliteration}</span>}
            </button>
          ))}
        </div>
      </div>

      <StatusLine state={state} opponent={opponent} connError={connError} chip={chip} />

      <div className="fx-layer" aria-hidden="true">
        {swings.map((s) => <SwingGhost key={s.key} swing={s} onDone={removeSwing} />)}
        {bursts.map((b) => (
          <span
            key={b.key}
            className={`burst is-${b.outcome}`}
            style={{ left: b.at.x, top: b.at.y, animationDelay: `${CONTACT_MS}ms` }}
            onAnimationEnd={() => removeBurst(b.key)}
          />
        ))}
      </div>

      {state.phase === 'GAME_OVER' && (
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

function Scoreboard({ me, opponent, ballNumber, totalBalls, soundOn, onToggleSound }: {
  me: PlayerView | undefined;
  opponent: PlayerView | undefined;
  ballNumber: number;
  totalBalls: number;
  soundOn: boolean;
  onToggleSound: () => void;
}) {
  return (
    <header className="scoreboard">
      <div className="score-side is-me">
        <span className="score-name">{me?.name ?? 'You'}</span>
        <span key={me?.score} className="score-value">{me?.score ?? 0}</span>
      </div>
      <div className="score-mid">
        <span className="score-mid-label">Ball</span>
        <span className="score-mid-value">{ballNumber > 0 ? `${ballNumber} / ${totalBalls}` : `– / ${totalBalls}`}</span>
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
        <span key={opponent?.score} className="score-value">{opponent?.score ?? 0}</span>
        <span className="score-name">
          {opponent?.name ?? 'Opponent'}
          {opponent && !opponent.present && <em className="score-away"> · away</em>}
        </span>
      </div>
    </header>
  );
}

// ── table ───────────────────────────────────────────────────────────────────

function ReadyCountdown({ deadline, label }: { deadline: number; label: string }) {
  const now = useFrameNow(true);
  const seconds = Math.max(1, Math.ceil((deadline - now) / 1000));
  return (
    <div className="ready">
      <div className="ready-label">{label}</div>
      <div key={seconds} className="ready-count">{seconds}</div>
    </div>
  );
}

function Ball({ ballRef, ball, anchor, frozen }: {
  ballRef: RefObject<HTMLDivElement>;
  ball: BallView;
  anchor: BallAnchor;
  frozen: Frozen | null;
}) {
  const now = useFrameNow(true);
  const { x, y, opacity } = ballGeometry(ball, anchor, now, frozen);
  const classes = ['ball', ball.label ? '' : 'is-plain', ball.direction === 'incoming' ? 'is-incoming' : 'is-outgoing', `is-${ball.state}`];
  return (
    <div
      ref={ballRef}
      className={classes.filter(Boolean).join(' ')}
      style={{ left: `${x}%`, top: `${y * 100}%`, opacity }}
    >
      {ball.label && <span className="ball-label">{ball.label}</span>}
    </div>
  );
}

/** Your note after each ball: the word you needed, and what you swung if it was wrong. */
function ResultChip({ result }: { result: ResultView }) {
  const { target, picked, outcome } = result;
  if (!target) return null;
  return (
    <div className={`result-chip is-${outcome}`} role="status">
      {outcome === 'hit' && <span className="chip-head">+1</span>}
      {outcome === 'wrong' && picked && (
        <span className="chip-line is-wrong">
          <s>{picked.word}</s> <span className="chip-meaning">{picked.prompt}</span>
        </span>
      )}
      {outcome === 'missed' && <span className="chip-head">Too late</span>}
      <span className="chip-line">
        <strong>{target.word}</strong> <span className="chip-meaning">{target.prompt}</span>
      </span>
    </div>
  );
}

/** A card flying out to meet the ball and falling back. Its facing edge travels to `to`. */
function SwingGhost({ swing, onDone }: { swing: Swing; onDone: (key: string) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { from, to, side } = swing;
    const edgeY = side === 'me' ? from.top : from.bottom;
    const dx = to.x - (from.left + from.width / 2);
    const dy = to.y - edgeY;
    const tilt = side === 'me' ? -7 : 7;
    const animation = el.animate(
      [
        { transform: 'translate(0, 0) rotate(0) scale(1)', opacity: 1 },
        { transform: `translate(${dx}px, ${dy}px) rotate(${tilt}deg) scale(0.72)`, opacity: 1, offset: 0.4 },
        { transform: `translate(${dx * 0.3}px, ${dy * 0.3}px) rotate(0) scale(0.8)`, opacity: 0 },
      ],
      { duration: CONTACT_MS / 0.4, easing: 'cubic-bezier(.2, .7, .3, 1)' },
    );
    animation.onfinish = () => onDone(swing.key);
    return () => animation.cancel();
  }, [swing, onDone]);
  const { from, side } = swing;
  return (
    <div
      ref={ref}
      className={`swing word-card ${side === 'me' ? 'is-mine' : 'is-back'}`}
      style={{
        left: from.left,
        top: from.top,
        width: from.width,
        height: from.height,
        transformOrigin: side === 'me' ? 'center top' : 'center bottom',
      }}
    >
      {swing.word && <span className="card-word">{swing.word}</span>}
    </div>
  );
}

// ── footer + overlay ────────────────────────────────────────────────────────

/** Under your cards: your note on the last ball while it is fresh, otherwise what is going on.
 *  It sits here rather than on the table so it never covers the ball. */
function StatusLine({ state, opponent, connError, chip }: {
  state: GameState;
  opponent: PlayerView | undefined;
  connError: string | null;
  chip: ResultView | null;
}) {
  const ball = state.ball;
  let text = state.message;
  if (state.phase === 'PLAYING' && state.stage === 'flight' && ball?.state === 'flying') {
    text = ball.direction === 'incoming'
      ? `Hit it with the word for “${ball.label ?? '…'}”`
      : `${opponent?.name ?? 'Opponent'} is answering…`;
  }
  return (
    <footer className={`status ${connError ? 'is-error' : ''}`}>
      {connError ?? (chip?.target ? <ResultChip result={chip} /> : text)}
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
  const mine = state.history.filter((row) => row.receiverId === state.you);
  const hits = mine.filter((row) => row.outcome === 'hit').length;
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
            <p className="overlay-text">You hit {hits} of {mine.length} balls.</p>
            <ul className="review">
              {mine.map((row) => (
                <li key={row.number} className={`review-row is-${row.outcome}`}>
                  <span className="review-mark">{row.outcome === 'hit' ? '✓' : '✗'}</span>
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
