'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { AppTopBar } from '@/components/shared/AppTopBar';
import { BracketButton } from '@/components/shared/OtherHUD';
import DuelCard from '@/components/shared/DuelCard';
import { useActiveDuels } from '@/hooks/useActiveDuels';
import { useDuelMarkets } from '@/hooks/useDuelMarkets';
import { MARKET_ACCENT, MARKET_GLYPH, type MarketName } from '@/lib/marketKind';

/**
 * Every fight running right now.
 *
 * WHY THIS PAGE EXISTS. The lobby used to stack one full-width card per live fight,
 * which works for one and buries everything else past three — with six rings full,
 * the queue board, the standings and the creator were all below the fold. The lobby
 * now shows four and links here, so it stays an index and this is the place that
 * scales.
 *
 * It is deliberately just the grid: no creator, no standings, no ledger. Somebody
 * arriving here has already decided they want to watch something.
 */
export default function AllLiveDuelsPage() {
  const { duels, isLoading, error, maxActiveDuels } = useActiveDuels();

  const markets = useDuelMarkets(
    duels.map(({ duelId, duel }) => ({ duelId, simulated: duel.simulated })),
  );

  /** How many fights each market is running, for the summary line. */
  const byMarket = useMemo(() => {
    const counts = new Map<MarketName, number>();
    for (const { duelId } of duels) {
      const m = markets.get(duelId.toString());
      if (m) counts.set(m, (counts.get(m) ?? 0) + 1);
    }
    return counts;
  }, [duels, markets]);

  return (
    <div className="app-floor col" style={{ minHeight: '100vh' }}>
      <AppTopBar />

      <section className="shell-pad col gap-16" style={{ paddingTop: 32, paddingBottom: 56 }}>
        <div className="sect-head">
          <span className="sect-head-num">§ LIVE</span>
          <span className="sect-head-title">EVERY FIGHT RUNNING</span>
          <span className="sect-head-meta">
            {isLoading
              ? 'reading the arena…'
              : `${duels.length} of ${maxActiveDuels} rings busy`}
          </span>
        </div>

        {/* A per-market tally, so the shape of what is running is legible before
            reading a single card. Only markets that actually have a fight appear —
            a row of zeroes says nothing. */}
        {byMarket.size > 0 && (
          <div className="row ai-c gap-12" style={{ flexWrap: 'wrap' }}>
            {(['EVENTS', 'PERPS', 'SPOT', 'PRACTICE'] as MarketName[])
              .filter((m) => byMarket.has(m))
              .map((m) => (
                <span
                  key={m}
                  className="t-mono t-xs t-up"
                  style={{
                    color: MARKET_ACCENT[m],
                    border: `1px solid ${MARKET_ACCENT[m]}`,
                    background: `color-mix(in srgb, ${MARKET_ACCENT[m]} 12%, transparent)`,
                    padding: '3px 8px',
                    borderRadius: 2,
                    letterSpacing: '0.1em',
                  }}
                >
                  <span aria-hidden="true">{MARKET_GLYPH[m]} </span>
                  {m} · {byMarket.get(m)}
                </span>
              ))}
          </div>
        )}

        {error ? (
          <div className="card pad-24 col ai-c gap-8" role="alert">
            <span className="t-mono t-sm" style={{ color: 'var(--loss)' }}>
              Could not read the arena
            </span>
            <span className="t-mono t-xs t-dim">{error.message}</span>
          </div>
        ) : isLoading ? (
          <div className="card pad-24 col ai-c gap-8">
            <span className="t-mono t-xs t-dim">Reading every ring…</span>
          </div>
        ) : duels.length === 0 ? (
          /* Distinct from an error on purpose: an empty arena is a normal state and
             must not read as a failure. */
          <div
            className="card pad-24 col ai-c gap-16"
            style={{ borderStyle: 'dashed', borderColor: 'var(--text-faint)' }}
          >
            <span className="t-display" style={{ fontSize: 48, color: 'var(--text-faint)', lineHeight: 1 }}>◌</span>
            <div className="col ai-c gap-4">
              <span className="t-mono t-sm" style={{ color: 'var(--text-dim)' }}>ARENA IS DARK</span>
              <span className="t-xs t-dim" style={{ textAlign: 'center' }}>
                Nothing is running — the lobby is where a fight starts
              </span>
            </div>
            <Link href="/duel">
              <BracketButton variant="primary">TO THE LOBBY →</BracketButton>
            </Link>
          </div>
        ) : (
          <div className="live-grid">
            {duels.map(({ duelId, duel }) => (
              <DuelCard
                key={duelId.toString()}
                duelId={duelId}
                fighterAIndex={duel.fighterA}
                fighterBIndex={duel.fighterB}
                market={markets.get(duelId.toString())}
              />
            ))}
          </div>
        )}

        <div className="row ai-c jc-c" style={{ paddingTop: 8 }}>
          <Link href="/duel">
            <BracketButton variant="ghost">← BACK TO LOBBY</BracketButton>
          </Link>
        </div>
      </section>
    </div>
  );
}
