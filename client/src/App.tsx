import { useEffect, useState } from 'react';
import { initGame, type TranslatorBridge } from '@memdecks/mp-client';
import Game from './pages/Game';

export default function App() {
  const [loading, setLoading] = useState(true);
  // The whole bridge is kept, not just its session: `rematch()` / `close()` drive the
  // game-over buttons and `reportResult()` tells the host the match actually finished.
  const [bridge, setBridge] = useState<TranslatorBridge | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      // Handshake with the Translator host: send `game:ready` and await `translator:init`.
      const next = await initGame();
      if (!active) return;
      setBridge(next);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, []);

  if (loading) return <Splash subtitle="Connecting to the Translator…" />;

  const session = bridge?.session ?? null;
  const handoff = session?.match;
  if (!bridge || !session || !handoff) {
    return <Splash subtitle="Open this game from the Translator app to start a match." />;
  }

  return <Game handoff={handoff} session={session} bridge={bridge} />;
}

export function Splash({ subtitle }: { subtitle: string }) {
  return (
    <div className="splash">
      <h1 className="logo"><span className="logo-ball" aria-hidden="true" />Word Pong</h1>
      <p className="splash-subtitle">{subtitle}</p>
    </div>
  );
}
