'use client';

import Link from 'next/link';
import { formatUnits } from 'viem';
import { useDuelState } from '@/hooks/useDuelState';
import { useFighters } from '@/hooks/useFighters';
// The roster's colours have ONE home. This file kept its own copy of all six,
// which is how a colour changes in one place and not another.
import { FIGHTER_VISUAL_MAP } from '@/lib/fighters';
import { MARKET_ACCENT, MARKET_GLYPH, type MarketName } from '@/lib/marketKind';

interface DuelCardProps {
  duelId: bigint;
  fighterAIndex: number;
  fighterBIndex: number;
  /**
   * Which game this fight is playing. Absent while it is still being read, and the
   * badge is then simply not drawn — an unlabelled card is better than a wrong one,
   * and a spot fight mislabelled as practice would misrepresent real money as mock.
   */
  market?: MarketName;
}


function getStatusLabel(status: number): string {
  switch (status) {
    case 1: return 'ACTIVE';
    case 2: return 'FINALIZING';
    case 3: return 'RESOLVED';
    default: return 'PENDING';
  }
}

export default function DuelCard({ duelId, fighterAIndex, fighterBIndex, market }: DuelCardProps) {
  const { duel, totalBetsA, totalBetsB, hasBets, shareA, shareB, currentRound, isActive, isLoading } = useDuelState(duelId);
  const { fighters } = useFighters();

  const fighterA = fighters.find(f => f.index === fighterAIndex);
  const fighterB = fighters.find(f => f.index === fighterBIndex);

  const hexA = FIGHTER_VISUAL_MAP[fighterAIndex]?.hex ?? 'var(--fighter-a)';
  const hexB = FIGHTER_VISUAL_MAP[fighterBIndex]?.hex ?? 'var(--fighter-b)';

  const totalTurns = duel?.turns ?? 0;
  const status = duel?.status ?? 0;
  const statusLabel = getStatusLabel(status);

  const totalPot = totalBetsA + totalBetsB;
  const totalPotFormatted = formatUnits(totalPot, 18);
  const potDisplay = parseFloat(totalPotFormatted).toFixed(2);

  const nameA = fighterA?.name ?? `Fighter #${fighterAIndex}`;
  const nameB = fighterB?.name ?? `Fighter #${fighterBIndex}`;

  return (
    <Link href={`/duel/${duelId.toString()}`} style={{ textDecoration: 'none', display: 'block' }}>
      <div className="card" style={{ cursor: 'pointer', transition: 'border-color 0.15s' }}>
        <div className="col gap-12 pad-16">

          {/* Header row: which game, the duel number, and whether it is running.
              THE MARKET WAS MISSING ENTIRELY. Every card looked alike, so a card
              could not tell you whether it was watching real coin books, a
              prediction, a margin position or a mock — which is the single most
              important thing about a fight, and the one thing the lobby's own
              picker makes a point of. Coloured to match that picker, so the badge
              and the button that starts that game agree. */}
          <div className="row ai-c jc-sb" style={{ gap: 8 }}>
            <span className="row ai-c" style={{ gap: 8, minWidth: 0 }}>
              {market && (
                <span
                  className="t-mono t-xs t-up"
                  style={{
                    color: MARKET_ACCENT[market],
                    border: `1px solid ${MARKET_ACCENT[market]}`,
                    background: `color-mix(in srgb, ${MARKET_ACCENT[market]} 12%, transparent)`,
                    padding: '1px 6px',
                    borderRadius: 2,
                    letterSpacing: '0.1em',
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                  }}
                >
                  <span aria-hidden="true">{MARKET_GLYPH[market]} </span>{market}
                </span>
              )}
              <span className="t-mono t-xs t-dim" style={{ whiteSpace: 'nowrap' }}>#{duelId.toString()}</span>
            </span>
            <span
              className={`chip${isActive ? ' chip-live' : ''}`}
              style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              {isActive && <span className="dot dot-a pulse" style={{ width: '6px', height: '6px', borderRadius: '50%' }} />}
              <span className="t-xs t-mono t-up">{statusLabel}</span>
            </span>
          </div>

          {/* Fighter names row */}
          <div className="row ai-c gap-8">
            <span
              className="t-mono t-sm t-up"
              style={{ color: hexA, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {nameA}
            </span>
            <span className="t-mono t-dim" style={{ fontSize: '10px', flexShrink: 0 }}>VS</span>
            <span
              className="t-mono t-sm t-up"
              style={{ color: hexB, flex: 1, textAlign: 'right', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {nameB}
            </span>
          </div>

          {/* The line between the corners.
              A card of four stacked rows in one flat colour reads as a list entry
              rather than a contest, and the matchup — the thing the card is about —
              had nothing marking it off from the numbers below.

              Not a plain divider: it runs from THIS fight's two fighter colours, so
              the rule under a Degen/Whale card is a different rule from the one
              under a Quant/Contrarian card. That motif is already the house's — the
              brand underline and every section header use a corner-to-corner
              gradient — so it belongs rather than being invented here.

              Faded at both ends so it reads as a hairline drawn under the names, not
              a band separating two halves of a table. */}
          <div
            aria-hidden="true"
            style={{
              height: 1,
              background: `linear-gradient(90deg, transparent, ${hexA} 15%, ${hexB} 85%, transparent)`,
              opacity: 0.55,
            }}
          />

          {/* THE BETTING LINE — the split of the pot, and only when there is one.
              This used to render the Bookmaker's `currentOdds`, which no code
              maintains: both setters are owner-only, so it reads [0, 0] for every
              duel on chain and every card showed "0% / 0%" above a bar with no
              width on either side. Two zeroes are not a line; they are the absence
              of one, and saying so is the honest version.

              Where there ARE bets, the share of the pot IS the line — this is a
              parimutuel book, so a side's share of the stakes is its implied
              chance. No oracle needed. */}
          {hasBets ? (
            <div className="col gap-4">
              <div
                style={{
                  height: '4px',
                  borderRadius: '2px',
                  overflow: 'hidden',
                  background: 'var(--border)',
                  display: 'flex',
                }}
              >
                <div style={{ width: `${shareA}%`, background: hexA, transition: 'width 0.3s' }} />
                <div style={{ width: `${shareB}%`, background: hexB, transition: 'width 0.3s' }} />
              </div>
              <div className="row jc-sb">
                <span className="t-xs t-mono" style={{ color: hexA }}>{Math.round(shareA)}%</span>
                <span className="t-xs t-mono" style={{ color: hexB }}>{Math.round(shareB)}%</span>
              </div>
            </div>
          ) : (
            <span className="t-xs t-mono t-faint" style={{ letterSpacing: '0.12em' }}>
              NO BETS YET
            </span>
          )}

          {/* Footer row: round progress + pot */}
          <div className="row ai-c jc-sb">
            <span className="t-xs t-dim t-mono">
              {/* ROUNDS, not callbacks. There are two callbacks per round — one move
                  per fighter — so this printed "RND 18 / 9" on a nine-round fight. */}
              {isLoading ? '—' : `RND ${currentRound} / ${totalTurns}`}
            </span>
            {/* An empty pot is stated once, above, rather than twice as "0.00 USDso". */}
            {hasBets && (
              <span className="t-xs t-mono" style={{ color: 'var(--gold)' }}>
                {potDisplay} <span className="t-faint">USDso</span>
              </span>
            )}
          </div>

        </div>
      </div>
    </Link>
  );
}
