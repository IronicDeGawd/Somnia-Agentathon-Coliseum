'use client';

import React, { useReducer, useEffect } from 'react';
import Link from 'next/link';
import { useRouter, useParams } from 'next/navigation';
import { useAccount, useReadContract } from 'wagmi';
import { formatUnits } from 'viem';
import { AppTopBar } from '@/components/shared/AppTopBar';
import { FighterAvatar } from '@/components/shared/FighterAvatar';
import { BracketButton, Chip } from '@/components/shared/OtherHUD';
import SettlePanel from '@/components/shared/SettlePanel';
import { useDuelState } from '@/hooks/useDuelState';
import { simReducer, makeInitialSim } from '@/lib/simulation';
import { FIGHTERS, FIGHTER_VISUAL_MAP } from '@/lib/fighters';
import { fmtTime } from '@/lib/format';
import { CONTRACT_ADDRESSES, ABIS } from '@/lib/contracts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtUsdso(raw: bigint): string {
  return `$${Number(formatUnits(raw, 18)).toFixed(2)}`;
}

function fmtUsdsoNum(raw: bigint): number {
  return Number(formatUnits(raw, 18));
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ResultPage() {
  const router = useRouter();
  const params = useParams();
  const rawId = String(params?.id ?? '0');
  const duelId = BigInt(rawId || '0');

  const { address: userAddress } = useAccount();

  // ── On-chain duel state ───────────────────────────────────────────────────
  const { duel, isLoading, currentTurn } = useDuelState(duelId);

  // Read the full Arena tuple to get fighterA / fighterB indexes.
  // Tuple: (fighterA, fighterB, creator, startBlock, lastTurnBlock,
  //         completedCallbacks, turns, poolMask, status,
  //         initialUsdsoPerFighter, lastAction, fundsRecovered, winnerSlot)
  const { data: duelRaw } = useReadContract({
    address: CONTRACT_ADDRESSES.Arena,
    abi: ABIS.Arena,
    functionName: 'duels',
    args: [duelId],
    query: { enabled: duelId > BigInt(0) },
  });

  const fighterAIndex = duelRaw ? Number(duelRaw[0]) : undefined;
  const fighterBIndex = duelRaw ? Number(duelRaw[1]) : undefined;

  // ── Simulation (visual fallback while loading) ────────────────────────────
  const [sim, dispatch] = useReducer(simReducer, makeInitialSim());
  useEffect(() => {
    const clock = setInterval(() => dispatch({ type: 'TICK' }), 1000);
    return () => clearInterval(clock);
  }, []);

  // ── Derived display values ────────────────────────────────────────────────
  const isResolved = duel?.status === 3;
  const isCreator =
    !!userAddress &&
    !!duel?.creator &&
    duel.creator.toLowerCase() === userAddress.toLowerCase();

  // winnerSlot: 0 = fighterA, 1 = fighterB, 255 = unset
  const winnerSlotNum = isResolved && duel ? duel.winnerSlot : null;
  const winnerFighterIndex =
    winnerSlotNum === 0 ? fighterAIndex : winnerSlotNum === 1 ? fighterBIndex : undefined;
  const loserFighterIndex =
    winnerSlotNum === 0 ? fighterBIndex : winnerSlotNum === 1 ? fighterAIndex : undefined;

  // Visual identity from FIGHTER_VISUAL_MAP (keyed by contract index 0–5)
  const winnerVisual =
    winnerFighterIndex !== undefined ? FIGHTER_VISUAL_MAP[winnerFighterIndex] : null;
  const loserVisual =
    loserFighterIndex !== undefined ? FIGHTER_VISUAL_MAP[loserFighterIndex] : null;

  // Fall back to sim outcome while loading / before resolution
  const simWinnerId: 'degen' | 'whale' = sim.degen.pnl >= sim.whale.pnl ? 'degen' : 'whale';
  const winnerId = winnerVisual ? winnerVisual.id : simWinnerId;
  const loserId = loserVisual ? loserVisual.id : (winnerId === 'degen' ? 'whale' : 'degen');

  const winnerFighter = FIGHTERS[winnerId];
  const loserFighter = FIGHTERS[loserId];
  const winnerHex = winnerFighter?.hex ?? winnerVisual?.hex ?? 'var(--gold)';

  // On-chain balances when resolved; sim numbers otherwise
  const winnerBalance: bigint | null =
    isResolved && duel
      ? winnerSlotNum === 0 ? duel.quoteBalanceA : duel.quoteBalanceB
      : null;
  const loserBalance: bigint | null =
    isResolved && duel
      ? winnerSlotNum === 0 ? duel.quoteBalanceB : duel.quoteBalanceA
      : null;

  const wPnlDisplay = winnerBalance !== null
    ? fmtUsdso(winnerBalance)
    : `$${Math.abs(winnerId === 'degen' ? sim.degen.pnl : sim.whale.pnl).toFixed(2)}`;
  const lPnlDisplay = loserBalance !== null
    ? fmtUsdso(loserBalance)
    : `$${Math.abs(loserId === 'degen' ? sim.degen.pnl : sim.whale.pnl).toFixed(2)}`;

  const turns = duel?.turns ?? 15;

  return (
    <div className="col">
      <AppTopBar />

      {/* Status strip */}
      <div
        className="row ai-c jc-sb"
        style={{ padding: '14px 32px', borderBottom: '1px solid var(--border)', background: 'var(--bg-stage)' }}
      >
        <div className="row gap-12 ai-c">
          <span className="t-mono t-xs" style={{ letterSpacing: '0.28em', color: 'var(--text-faint)' }}>
            § POST-DUEL · DUEL #{rawId}
          </span>
          <span style={{ height: 12, width: 1, background: 'var(--border)' }} />
          {isLoading ? (
            <Chip variant="gold">LOADING…</Chip>
          ) : isResolved ? (
            <Chip variant="gold">★ SETTLED · ON-CHAIN</Chip>
          ) : (
            <Chip variant="win">LIVE</Chip>
          )}
        </div>
        <span className="t-mono t-xs t-dim" style={{ letterSpacing: '0.18em' }}>
          NEXT BOUT IN <span className="t-num" style={{ color: 'var(--gold)' }}>{fmtTime(sim.countdown)}</span>
        </span>
      </div>

      {/* Winner reveal — bare section, no card chrome */}
      <section style={{ position: 'relative', padding: '64px 32px 48px', overflow: 'hidden' }}>
        <div className="col ai-c gap-16" style={{ position: 'relative', maxWidth: 1200, margin: '0 auto' }}>
          <div className="row gap-16 ai-c">
            <span style={{ height: 1, width: 80, background: 'var(--gold)' }} />
            <span className="eyebrow" style={{ color: 'var(--gold)', letterSpacing: '0.42em' }}>
              {isLoading ? 'LOADING…' : isResolved ? '★ WINNER ★' : '★ RESULT PENDING ★'}
            </span>
            <span style={{ height: 1, width: 80, background: 'var(--gold)' }} />
          </div>

          <div className="vs-pop" style={{ filter: `drop-shadow(0 0 60px ${winnerHex})` }}>
            <FighterAvatar fighter={winnerId} context="card" size={220} state="victory" />
          </div>

          <h1
            className="fp-display"
            style={{
              fontSize: 'clamp(56px, 8vw, 96px)',
              letterSpacing: '0.06em',
              lineHeight: 1,
              textAlign: 'center',
              margin: 0,
              color: winnerHex,
              textShadow: `0 0 60px ${winnerHex}`,
              whiteSpace: 'nowrap',
            }}
          >
            {winnerFighter?.name ?? (isLoading ? 'LOADING…' : 'UNKNOWN')}
          </h1>

          <div className="row gap-32 ai-c" style={{ marginTop: 24 }}>
            <div className="col ai-c gap-2">
              <span className="eyebrow">FINAL PORTFOLIO</span>
              <span className="t-num text-win" style={{ fontSize: 32, whiteSpace: 'nowrap' }}>
                {wPnlDisplay}
              </span>
            </div>
            <span style={{ height: 36, width: 1, background: 'var(--border)' }} />
            <div className="col ai-c gap-2">
              <span className="eyebrow">TURNS COMPLETED</span>
              <span className="t-num text-win" style={{ fontSize: 32, whiteSpace: 'nowrap' }}>
                {isResolved ? turns : currentTurn} / {turns}
              </span>
            </div>
            <span style={{ height: 36, width: 1, background: 'var(--border)' }} />
            <div className="col ai-c gap-2">
              <span className="eyebrow">METHOD</span>
              <span
                className="t-display t-up"
                style={{ fontSize: 18, color: 'var(--text)', letterSpacing: '0.12em', whiteSpace: 'nowrap' }}
              >
                {isResolved ? 'PNL on mid mark prices · finalizeDuel' : 'Duel in progress'}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* § 01 FINAL TAPE */}
      <section className="shell-pad col gap-16" style={{ paddingTop: 16, paddingBottom: 40 }}>
        <div className="sect-head">
          <span className="sect-head-num">§ 01</span>
          <span className="sect-head-title">FINAL TAPE</span>
          <span className="sect-head-meta">{turns} rounds settled · {sim.spectators} bettors</span>
        </div>

        <div className="row gap-16" style={{ alignItems: 'stretch' }}>
          {/* Winner card */}
          <div className="card flex-1 col gap-12 pad-24">
            <div className="row jc-sb ai-c">
              <div className="row gap-12 ai-c">
                <FighterAvatar fighter={winnerId} context="mini" size={40} />
                <div className="col gap-2">
                  <Chip variant="win">★ WON</Chip>
                  <span
                    className="t-display t-up"
                    style={{ color: winnerHex, fontSize: 18, letterSpacing: '0.12em' }}
                  >
                    {winnerFighter?.name ?? 'Fighter A'}
                  </span>
                </div>
              </div>
              <span className="t-num text-win" style={{ fontSize: 28 }}>{wPnlDisplay}</span>
            </div>
            <hr className="divider" />
            <div className="row jc-sb t-mono t-xs t-dim">
              <span>Last mark snapshot</span>
              <span className="t-num text-win">{isResolved ? 'on-chain' : 'pending'}</span>
            </div>
            <div className="row jc-sb t-mono t-xs t-dim">
              <span>Per-round detail</span>
              <span className="t-num t-dim">via indexer</span>
            </div>
            <div className="row jc-sb t-mono t-xs t-dim">
              <span>Fighter index</span>
              <span className="t-num" style={{ color: 'var(--text)' }}>
                {winnerFighterIndex !== undefined ? `#${winnerFighterIndex}` : '—'}
              </span>
            </div>
          </div>

          {/* Loser card — opacity 0.7 */}
          <div className="card flex-1 col gap-12 pad-24" style={{ opacity: 0.7 }}>
            <div className="row jc-sb ai-c">
              <div className="row gap-12 ai-c">
                <FighterAvatar fighter={loserId} context="mini" size={40} />
                <div className="col gap-2">
                  <Chip variant="loss">LOST</Chip>
                  <span
                    className="t-display t-up"
                    style={{ color: loserFighter?.hex ?? 'var(--text-dim)', fontSize: 18, letterSpacing: '0.12em' }}
                  >
                    {loserFighter?.name ?? 'Fighter B'}
                  </span>
                </div>
              </div>
              <span className="t-num text-loss" style={{ fontSize: 28 }}>{lPnlDisplay}</span>
            </div>
            <hr className="divider" />
            <div className="row jc-sb t-mono t-xs t-dim">
              <span>Last mark snapshot</span>
              <span className="t-num text-win">{isResolved ? 'on-chain' : 'pending'}</span>
            </div>
            <div className="row jc-sb t-mono t-xs t-dim">
              <span>Per-round detail</span>
              <span className="t-num t-dim">via indexer</span>
            </div>
            <div className="row jc-sb t-mono t-xs t-dim">
              <span>Fighter index</span>
              <span className="t-num" style={{ color: 'var(--text)' }}>
                {loserFighterIndex !== undefined ? `#${loserFighterIndex}` : '—'}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* § 02 SETTLEMENT */}
      <section className="shell-pad col gap-16" style={{ paddingTop: 16, paddingBottom: 40 }}>
        <div className="sect-head">
          <span className="sect-head-num">§ 02</span>
          <span className="sect-head-title">SETTLEMENT</span>
          <span className="sect-head-meta">
            {isCreator
              ? 'you created this duel · recover funds below'
              : 'settle bets or recover winnings'}
          </span>
        </div>

        <SettlePanel duelId={duelId} isCreator={isCreator} />
      </section>

      {/* Action row — centered horizontal */}
      <section className="shell-pad" style={{ paddingTop: 16, paddingBottom: 80 }}>
        <div className="row gap-12 ai-c jc-c">
          <Link href={`/duel/${rawId}`}>
            <BracketButton>WATCH REPLAY</BracketButton>
          </Link>
          <BracketButton variant="gold">SHARE CARD ⤴</BracketButton>
          <BracketButton variant="primary" onClick={() => router.push('/duel')}>
            NEXT BOUT →
          </BracketButton>
        </div>
      </section>
    </div>
  );
}
