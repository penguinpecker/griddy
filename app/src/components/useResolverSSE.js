// useResolverSSE.js
// Drop-in hook for the Griddy frontend — connects to the resolver SSE stream
// Falls back to RPC polling if SSE disconnects
//
// Usage in TheGrid.js:
//   import { useResolverSSE } from './useResolverSSE';
//   
//   // Inside your component:
//   const { connected, lastEvent } = useResolverSSE({
//     url: 'https://YOUR-RAILWAY-URL/events',
//     onRoundResolved: (data) => {
//       // data = { roundId, skipped, winningCell, players, txHash }
//       // Trigger your existing refreshRoundState() or equivalent
//       refreshRoundState();
//     },
//     onCellPicked: (data) => {
//       // data = { roundId, player, cell }
//       // Update heatmap live without polling
//       setCellCounts(prev => {
//         const next = [...prev];
//         next[data.cell] = (next[data.cell] || 0) + 1;
//         return next;
//       });
//     },
//   });

import { useEffect, useRef, useState, useCallback } from 'react';

const RECONNECT_DELAY = 3000; // 3s between reconnect attempts
const MAX_RECONNECTS = 20;    // give up after 20 tries (1 min)

export function useResolverSSE({ url, onRoundResolved, onCellPicked, onBonusRound, enabled = true }) {
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState(null);
  const esRef = useRef(null);
  const reconnectCount = useRef(0);
  const reconnectTimer = useRef(null);

  // Stable refs for callbacks so we don't re-create EventSource on every render
  const onRoundResolvedRef = useRef(onRoundResolved);
  const onCellPickedRef = useRef(onCellPicked);
  const onBonusRoundRef = useRef(onBonusRound);
  useEffect(() => { onRoundResolvedRef.current = onRoundResolved; }, [onRoundResolved]);
  useEffect(() => { onCellPickedRef.current = onCellPicked; }, [onCellPicked]);
  useEffect(() => { onBonusRoundRef.current = onBonusRound; }, [onBonusRound]);

  const connect = useCallback(() => {
    if (!url || !enabled) return;
    
    // Clean up existing
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    console.log(`[SSE] Connecting to ${url}...`);
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener('connected', (e) => {
      const data = JSON.parse(e.data);
      console.log(`[SSE] ✓ Connected — current round: ${data.round}`);
      setConnected(true);
      reconnectCount.current = 0; // reset on success
      setLastEvent({ type: 'connected', data, time: Date.now() });
    });

    es.addEventListener('round_resolved', (e) => {
      const data = JSON.parse(e.data);
      console.log(`[SSE] round_resolved:`, data);
      setLastEvent({ type: 'round_resolved', data, time: Date.now() });
      onRoundResolvedRef.current?.(data);
    });

    es.addEventListener('cell_picked', (e) => {
      const data = JSON.parse(e.data);
      // Don't log every pick — can be noisy
      setLastEvent({ type: 'cell_picked', data, time: Date.now() });
      onCellPickedRef.current?.(data);
    });

    es.addEventListener('bonus_round', (e) => {
      const data = JSON.parse(e.data);
      console.log(`[SSE] 🔥 BONUS ROUND:`, data);
      setLastEvent({ type: 'bonus_round', data, time: Date.now() });
      onBonusRoundRef.current?.(data);
    });

    es.onerror = () => {
      console.warn(`[SSE] Connection lost`);
      setConnected(false);
      es.close();
      esRef.current = null;

      // Auto-reconnect with backoff
      if (reconnectCount.current < MAX_RECONNECTS) {
        reconnectCount.current++;
        const delay = RECONNECT_DELAY * Math.min(reconnectCount.current, 5); // max 15s
        console.log(`[SSE] Reconnecting in ${delay/1000}s (attempt ${reconnectCount.current}/${MAX_RECONNECTS})`);
        reconnectTimer.current = setTimeout(connect, delay);
      } else {
        console.warn(`[SSE] Max reconnects reached — falling back to RPC polling`);
      }
    };
  }, [url, enabled]);

  useEffect(() => {
    connect();
    return () => {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
      }
    };
  }, [connect]);

  return { connected, lastEvent };
}
