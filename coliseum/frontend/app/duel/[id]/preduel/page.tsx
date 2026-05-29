'use client';

import React, { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { formatUnits } from 'viem';
import { useReadContract } from 'wagmi';
import { AppTopBar } from '@/components/shared/AppTopBar';
import { FighterAvatar } from '@/components/shared/FighterAvatar';
import { Meter } from '@/components/shared/Meter';
import { BracketButton, Chip } from '@/components/shared/OtherHUD';
import BetPanel from '@/components/shared/BetPanel';
import { useDuelState } from '@/hooks/useDuelState';
import { useFighters } from '@/hooks/useFighters';
import { fmtTime } from '@/lib/format';
import { CONTRACT_ADDRESSES, ABIS } from '@/lib/contracts';
import type { FighterData } from '@/hooks/useFighters';

// ─── Pool mask bits (mirrors ArenaTypes) ─────────────────────────────────────
const POOL_BIT_SOMI = 0x01;
const POOL_BIT_WETH = 0x02;
const POOL_BIT_WBTC = 0x04;

const ARENA_STATUS_ACTIVE = 1;

function poolTierLabel(poolMask: number): string {
  const tokens: string[] = [];
  if (poolMask & POOL_BIT_SOMI) tokens.push('SOMI');
  if (poolMask & POOL_BIT_WETH) tokens.push('WETH');
  if (poolMask & POOL_BIT_WBTC) tokens.push('WBTC');
  return tokens.length > 0 ? tokens.join(' · ') : '—';
}

// ─── Full duel tuple (real ABI field order) ───────────────────────────────────
// Arena.duels returns:
//   0  fighterA         uint8
//   1  fighterB         uint8
//   2  creator          address
//   3  startBlock       uint256
//   4  lastTurnBlock    uint256
//   5  completedCallbacks uint16
//   6  turns            uint16
//   7  poolMask         uint8
//   8  status           uint8
//   9  initialUsdsoPerFighter uint256
//  10  lastAction       uint8[2]
//  11  fundsRecovered   bool
//  12  winnerSlot       uint8

interface FullDuel {
  fighterA: number;
  fighterB: number;
  creator: `0x${string}`;
  turns: number;
  poolMask: number;
  status: number;
  initialUsdsoPerFighter: bigint;
  winnerSlot: number;
}

function parseFullDuel(raw: readonly unknown[]): FullDuel {
  return {
    fighterA:               Number(raw[0]),
    fighterB:               Number(raw[1]),
    creator:                raw[2] as `0x${string}`,
    turns:                  Number(raw[6]),
    poolMask:               Number(raw[7]),
    status:                 Number(raw[8]),
    initialUsdsoPerFighter: raw[9] as bigint,
    winnerSlot:             Number(raw[12]),
  };
}

// ─── Corner card ─────────────────────────────────────────────────────────────

interface CornerProps {
  fighter: FighterData;
  side: 'a' | 'b';
  oddsPercent: string;
}

function Corner({ fighter, side, oddsPercent }: CornerProps) {
  const hex = fighter.hex;
  const cornerLabel = side === 'a' ? 'RED CORNER' : 'BLUE CORNER';

  const avatarFighter = {
    id: fighter.dicebearSeed,
    name: fighter.name,
    hex: fighter.hex,
    rank: 'S' as const,
    tier: 'FIGHTER',
    seedBottts: fighter.dicebearSeed,
  };

  return (
    <div
      className={`card ${side === 'a' ? 'glow-a' : 'glow-b'}`}
      style={{
        flex: 1,
        borderColor: hex,
        overflow: 'hidden',
        transform: side === 'a' ? 'translateX(-12px)' : 'translateX(12px)',
        opacity: 0,
        animation: `${side === 'a' ? 'slideInLeft' : 'slideInRight'} 600ms cubic-bezier(.34,1.56,.64,1) both`,
      }}
    >
      {/* Ribbon header */}
      <div
        className="row ai-c jc-sb"
        style={{
          padding: '10px 16px',
          background: `linear-gradient(${side === 'a' ? 90 : 270}deg, ${hex}22, transparent 70%)`,
          borderBottom: `1px solid ${hex}55`,
        }}
      >
        <div className="row gap-8 ai-c">
          <span
            style={{
              width: 22,
              height: 22,
              background: hex,
              color: '#0a0612',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: 'var(--fnt-display)',
              fontWeight: 700,
              fontSize: 14,
            }}
          >
            {side === 'a' ? 'A' : 'B'}
          </span>
          <span
            className="t-display t-up"
            style={{ fontSize: 13, color: hex, letterSpacing: '0.18em', whiteSpace: 'nowrap' }}
          >
            {cornerLabel}
          </span>
        </div>
        <span className="chip" style={{ color: hex, borderColor: hex }}>{oddsPercent}%</span>
      </div>

      {/* Portrait + name + tagline */}
      <div className="col gap-16 ai-c" style={{ padding: 24 }}>
        <FighterAvatar fighter={avatarFighter} context="card" size={220} state="winning" />
        <div className="col ai-c gap-4">
          <span
            className="t-display t-up"
            style={{ fontSize: 24, letterSpacing: '0.1em', color: hex, lineHeight: 1, whiteSpace: 'nowrap' }}
          >
            {fighter.name}
          </span>
          <span className="t-mono t-sm t-dim" style={{ fontStyle: 'italic', whiteSpace: 'nowrap' }}>
            &ldquo;{fighter.tagline}&rdquo;
          </span>
        </div>
      </div>

      {/* Meters */}
      <div className="col gap-10" style={{ padding: '0 24px 16px' }}>
        <div className="row jc-sb ai-c">
          <span className="label-tiny">AGGRESSION</span>
          <Meter value={fighter.aggression} side={side} />
        </div>
        <div className="row jc-sb ai-c">
          <span className="label-tiny">PATIENCE</span>
          <Meter value={fighter.patience} side={side} />
        </div>
        <div className="row jc-sb ai-c">
          <span className="label-tiny">RISK</span>
          <Meter value={fighter.risk} side={side} />
        </div>
      </div>

      {/* Footer */}
      <div
        className="row jc-sb ai-c"
        style={{
          padding: '12px 24px',
          borderTop: '1px solid var(--border)',
          background: 'var(--bg-stage)',
        }}
      >
        <div className="col gap-2">
          <span className="label-tiny">WIN ODDS</span>
          <span className="t-num t-sm" style={{ color: hex }}>{oddsPercent}%</span>
        </div>
        <span className="t-mono t-xs t-dim">{side === 'a' ? 'FIGHTER A' : 'FIGHTER B'}</span>
      </div>
    </div>
  );
}

function CornerSkeleton({ side }: { side: 'a' | 'b' }) {
  return (
    <div
      className="card"
      style={{ flex: 1, overflow: 'hidden', opacity: 0.4 }}
    >
      <div style={{ padding: 24, height: 400, background: 'var(--bg-card)' }} />
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PreDuelPage() {
  const router = useRouter();
  const params = useParams();
  const duelIdStr = String(params?.id ?? '1');
  const duelIdBig = BigInt(duelIdStr);

  // Full duel read with correct field mapping
  const { data: duelRaw, isLoading: duelLoading } = useReadContract({
    address: CONTRACT_ADDRESSES.Arena,
    abi: ABIS.Arena,
    functionName: 'duels',
    args: [duelIdBig],
    query: {
      enabled: duelIdBig > BigInt(0),
      refetchInterval: 10_000,
    },
  });

  // Odds + bet totals from useDuelState
  const { odds, totalBetsA, totalBetsB } = useDuelState(duelIdBig);

  const { fighters, isLoading: fightersLoading } = useFighters();

  const [t, setT] = useState(30);

  const fullDuel = duelRaw ? parseFullDuel(duelRaw as readonly unknown[]) : null;

  // Auto-redirect if duel is already Active
  useEffect(() => {
    if (fullDuel && fullDuel.status === ARENA_STATUS_ACTIVE) {
      router.push(`/duel/${duelIdStr}`);
    }
  }, [fullDuel, duelIdStr, router]);

  // Countdown timer — navigate when it hits 0
  useEffect(() => {
    if (t <= 0) {
      router.push(`/duel/${duelIdStr}`);
      return;
    }
    const id = setTimeout(() => setT((x) => x - 1), 1000);
    return () => clearTimeout(id);
  }, [t, duelIdStr, router]);

  // Resolve fighter data from on-chain fighter indexes
  const fighterA = fullDuel ? fighters.find((f) => f.index === fullDuel.fighterA) : null;
  const fighterB = fullDuel ? fighters.find((f) => f.index === fullDuel.fighterB) : null;

  // Pot = initialUsdsoPerFighter * 2
  const pot = fullDuel
    ? Number(formatUnits(fullDuel.initialUsdsoPerFighter * BigInt(2), 18)).toFixed(2)
    : '—';

  const totalBetPool = Number(formatUnits(totalBetsA + totalBetsB, 18)).toFixed(2);

  // Odds display
  const oddsAPercent = odds ? (odds.degenBps / 100).toFixed(1) : '—';
  const oddsBPercent = odds ? (odds.whaleBps  / 100).toFixed(1) : '—';

  const turns    = fullDuel?.turns    ?? 15;
  const poolMask = fullDuel?.poolMask ?? 0;
  const tierLabel = poolMask > 0 ? poolTierLabel(poolMask) : '—';

  const isActive   = fullDuel?.status === ARENA_STATUS_ACTIVE;
  const dataReady  = !duelLoading && !fightersLoading && !!fullDuel && !!fighterA && !!fighterB;

  return (
    <div className="col" style={{ minHeight: '100vh', background: 'var(--bg-deep)' }}>
      <AppTopBar />

      {/* Status strip */}
      <div
        className="row ai-c jc-sb"
        style={{
          padding: '14px 32px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-stage)',
        }}
      >
        <div className="row gap-12 ai-c">
          <span
            className="t-mono t-xs"
            style={{ letterSpacing: '0.28em', color: 'var(--text-faint)' }}
          >
            § PRE-DUEL · DUEL #{duelIdStr}
          </span>
          <span style={{ height: 12, width: 1, background: 'var(--border)' }} />
          <Chip variant="gold">▸ MAIN EVENT</Chip>
          {tierLabel !== '—' && (
            <>
              <span style={{ height: 12, width: 1, background: 'var(--border)' }} />
              <span className="t-mono t-xs t-dim">{tierLabel}</span>
            </>
          )}
        </div>
        <div className="row gap-12 ai-c">
          <span className="label-tiny">BETS OPEN WHILE DUEL ACTIVE — odds locked at placement</span>
          <span
            className="t-num"
            style={{ fontSize: 24, color: t <= 10 ? 'var(--loss)' : 'var(--gold)' }}
          >
            {fmtTime(t)}
          </span>
        </div>
      </div>

      <div className="shell-pad col gap-24" style={{ paddingTop: 32, paddingBottom: 32 }}>

        {/* Marquee headline */}
        <div className="col ai-c gap-4">
          <span className="eyebrow" style={{ color: 'var(--text-dim)' }}>TALE OF THE TAPE</span>
          <h1
            className="fp-display"
            style={{
              fontSize: 'clamp(48px, 7vw, 84px)',
              letterSpacing: '0.04em',
              lineHeight: 1,
              textAlign: 'center',
              margin: '8px 0',
              color: 'var(--text)',
            }}
          >
            {dataReady ? (
              <>
                <span className="text-a">{fighterA!.name}</span>
                <span style={{ color: 'var(--text-faint)', margin: '0 16px' }}>vs</span>
                <span className="text-b">{fighterB!.name}</span>
              </>
            ) : (
              <span style={{ color: 'var(--text-dim)' }}>LOADING…</span>
            )}
          </h1>
        </div>

        {/* Corner cards w/ gradient VS */}
        <div className="row gap-24 ai-c" style={{ alignItems: 'stretch' }}>
          {dataReady ? (
            <Corner fighter={fighterA!} side="a" oddsPercent={oddsAPercent} />
          ) : (
            <CornerSkeleton side="a" />
          )}

          <div className="col ai-c gap-12" style={{ width: 80, justifyContent: 'center' }}>
            <span
              className="t-display vs-pop"
              style={{
                fontSize: 80,
                lineHeight: 1,
                background: 'linear-gradient(180deg, var(--fighter-a), var(--fighter-b))',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
              }}
            >
              VS
            </span>
            <span className="t-mono t-xs t-faint" style={{ textAlign: 'center' }}>
              BEST OF<br />{turns} ROUNDS
            </span>
          </div>

          {dataReady ? (
            <Corner fighter={fighterB!} side="b" oddsPercent={oddsBPercent} />
          ) : (
            <CornerSkeleton side="b" />
          )}
        </div>

        {/* Bet panel — only when duel is active and data is ready */}
        {dataReady && isActive && (
          <BetPanel
            duelId={duelIdBig}
            fighterAName={fighterA!.name}
            fighterBName={fighterB!.name}
          />
        )}

        {/* Bottom strip */}
        <div className="card pad-16 row jc-sb ai-c">
          <div className="row gap-24 ai-c">
            <div className="col gap-2">
              <span className="eyebrow">PURSE</span>
              <span className="t-num text-gold" style={{ fontSize: 22 }}>{pot} USDso</span>
            </div>
            <span style={{ height: 32, width: 1, background: 'var(--border)' }} />
            <div className="col gap-2">
              <span className="eyebrow">BET POOL</span>
              <span className="t-num" style={{ fontSize: 22 }}>{totalBetPool} USDso</span>
            </div>
            <span style={{ height: 32, width: 1, background: 'var(--border)' }} />
            <div className="col gap-2">
              <span className="eyebrow">TIER</span>
              <span className="t-num" style={{ fontSize: 16 }}>{tierLabel}</span>
            </div>
          </div>
          <BracketButton variant="primary" onClick={() => router.push(`/duel/${duelIdStr}`)}>
            SKIP TO ARENA →
          </BracketButton>
        </div>

      </div>
    </div>
  );
}
