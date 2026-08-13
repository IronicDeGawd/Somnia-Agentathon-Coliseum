'use client';

import React, { useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { formatUnits } from 'viem';
import { useAccount, useReadContract } from 'wagmi';
import { AppTopBar } from '@/components/shared/AppTopBar';
import { FighterAvatar } from '@/components/shared/FighterAvatar';
import { BracketButton } from '@/components/shared/OtherHUD';
import { useFighters } from '@/hooks/useFighters';
import { CONTRACT_ADDRESSES, ABIS } from '@/lib/contracts';
import { useContractSubscription } from '@/hooks/useContractSubscription';

// ─── Pool mask bits ───────────────────────────────────────────────────────────
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

function parseFullDuel(raw: readonly unknown[]) {
  return {
    fighterA:               Number(raw[0]),
    fighterB:               Number(raw[1]),
    turns:                  Number(raw[6]),
    poolMask:               Number(raw[7]),
    status:                 Number(raw[8]),
    initialUsdsoPerFighter: raw[9] as bigint,
  };
}

// Use the shared Matchmaker ABI. The local copy this replaced declared
// MatchStarted with duelId last and unindexed; the contract emits it first and
// indexed, so the signature hashed to a different topic0 and never matched.

// ─── Pulse animation ──────────────────────────────────────────────────────────
const pulseStyle = `
  @keyframes preduel-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%       { opacity: 0.5; transform: scale(0.92); }
  }
  @keyframes preduel-spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }
`;

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PreDuelPage() {
  const router = useRouter();
  const params = useParams();
  const { address } = useAccount();
  const duelIdStr = String(params?.id ?? '0');
  const duelIdBig = BigInt(duelIdStr);

  const { fighters, isLoading: fightersLoading } = useFighters();

  // Read the duel from the Arena to get current status + fighter info
  const { data: duelRaw, isLoading: duelLoading } = useReadContract({
    address: CONTRACT_ADDRESSES.Arena,
    abi: ABIS.Arena,
    functionName: 'duels',
    args: [duelIdBig],
    query: {
      enabled: duelIdBig > BigInt(0),
      refetchInterval: 4_000,
      refetchIntervalInBackground: true,
    },
  });

  const duel = duelRaw ? parseFullDuel(duelRaw as readonly unknown[]) : null;

  // If duel is already active, go straight to the arena
  useEffect(() => {
    if (duel && duel.status === ARENA_STATUS_ACTIVE) {
      router.replace(`/duel/${duelIdStr}`);
    }
  }, [duel, duelIdStr, router]);

  // Watch MatchStarted — redirect as soon as this duel fires
  useContractSubscription({
    address: CONTRACT_ADDRESSES.Matchmaker,
    abi: ABIS.Matchmaker,
    eventName: 'MatchStarted',
    args: { duelId: duelIdBig },
    onLogs() {
      router.replace(`/duel/${duelIdStr}`);
    },
  });

  const fighterA = duel ? fighters.find((f) => f.index === duel.fighterA) : null;
  const fighterB = duel ? fighters.find((f) => f.index === duel.fighterB) : null;

  const deposit = duel
    ? Number(formatUnits(duel.initialUsdsoPerFighter, 18)).toFixed(2)
    : '—';

  const tierLabel = duel && duel.poolMask > 0 ? poolTierLabel(duel.poolMask) : '—';
  const turns = duel?.turns ?? 0;

  const isLoading = duelLoading || fightersLoading;
  const dataReady = !!duel && !!fighterA && !!fighterB;

  const avatarA = fighterA
    ? { id: fighterA.dicebearSeed, name: fighterA.name, hex: fighterA.hex, rank: 'S' as const, tier: 'FIGHTER', seedBottts: fighterA.dicebearSeed }
    : null;
  const avatarB = fighterB
    ? { id: fighterB.dicebearSeed, name: fighterB.name, hex: fighterB.hex, rank: 'S' as const, tier: 'FIGHTER', seedBottts: fighterB.dicebearSeed }
    : null;

  return (
    <div className="col" style={{ minHeight: '100vh', background: 'var(--bg-deep)' }}>
      <style>{pulseStyle}</style>
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
            § MATCHMAKING · DUEL #{duelIdStr}
          </span>
        </div>
        <div className="row gap-8 ai-c">
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: 'var(--gold)',
              animation: 'preduel-pulse 1.4s ease-in-out infinite',
              display: 'inline-block',
            }}
          />
          <span className="t-mono t-xs" style={{ color: 'var(--gold)', letterSpacing: '0.18em' }}>
            WAITING FOR OPPONENT
          </span>
        </div>
      </div>

      <div className="shell-pad col gap-32 ai-c" style={{ paddingTop: 96, paddingBottom: 96 }}>

        {/* Big headline. Uses fp-display — the editorial face every other screen
            sets a fighter's name in (landing hero, profile, result). This page
            was the only one still on the smaller t-display scale, which is why
            it read flatter than the rest of the app. */}
        <div className="col ai-c gap-8">
          <span className="eyebrow" style={{ color: 'var(--text-dim)' }}>YOU ARE IN THE QUEUE</span>
          <h1
            className="fp-display"
            style={{
              fontSize: 'clamp(44px, 7vw, 96px)',
              letterSpacing: '0.04em',
              lineHeight: 1,
              textAlign: 'center',
              color: 'var(--text)',
              margin: 0,
            }}
          >
            {dataReady ? (
              <span style={{ color: fighterA!.hex, textShadow: `0 0 50px ${fighterA!.hex}` }}>
                {fighterA!.name}
              </span>
            ) : (
              <span style={{ color: 'var(--text-dim)' }}>LOADING…</span>
            )}
          </h1>
          <span className="t-mono t-sm t-dim" style={{ textAlign: 'center' }}>
            Match will start automatically when an opponent joins.
          </span>
        </div>

        {/* Fighter card + waiting slot */}
        <div className="row gap-32 ai-c" style={{ width: '100%', maxWidth: 960, justifyContent: 'center', flexWrap: 'wrap' }}>

          {/* Your fighter */}
          <div
            className="card col ai-c gap-16"
            style={{
              flex: 1,
              padding: 32,
              minWidth: 'min(100%, 280px)',
              borderColor: fighterA?.hex ?? 'var(--border)',
              boxShadow: dataReady ? `0 0 32px ${fighterA!.hex}33` : 'none',
            }}
          >
            <div
              className="row ai-c gap-8"
              style={{
                padding: '6px 14px',
                background: dataReady ? `${fighterA!.hex}22` : 'var(--bg-stage)',
                border: `1px solid ${dataReady ? fighterA!.hex + '55' : 'var(--border)'}`,
              }}
            >
              <span className="t-display t-up" style={{ fontSize: 11, letterSpacing: '0.2em', color: dataReady ? fighterA!.hex : 'var(--text-dim)' }}>
                YOUR FIGHTER
              </span>
            </div>

            {dataReady && avatarA ? (
              <>
                <FighterAvatar fighter={avatarA} context="card" size={160} state="winning" />
                <div className="col ai-c gap-4">
                  <span
                    className="t-display t-up"
                    style={{ fontSize: 20, letterSpacing: '0.1em', color: fighterA!.hex, lineHeight: 1 }}
                  >
                    {fighterA!.name}
                  </span>
                  <span className="t-mono t-xs t-dim" style={{ fontStyle: 'italic' }}>
                    &ldquo;{fighterA!.tagline}&rdquo;
                  </span>
                </div>
              </>
            ) : (
              <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span className="t-mono t-xs t-faint">LOADING…</span>
              </div>
            )}
          </div>

          {/* VS divider */}
          <div className="col ai-c gap-8" style={{ flexShrink: 0 }}>
            <span
              className="t-display"
              style={{
                fontSize: 48,
                lineHeight: 1,
                color: 'var(--text-faint)',
                letterSpacing: '0.02em',
              }}
            >
              VS
            </span>
          </div>

          {/* Opponent waiting slot */}
          <div
            className="card col ai-c gap-16"
            style={{
              flex: 1,
              padding: 32,
              minWidth: 'min(100%, 280px)',
              borderColor: 'var(--border)',
              borderStyle: 'dashed',
              opacity: 0.7,
            }}
          >
            <div
              className="row ai-c gap-8"
              style={{
                padding: '6px 14px',
                background: 'var(--bg-stage)',
                border: '1px solid var(--border)',
              }}
            >
              <span className="t-display t-up" style={{ fontSize: 11, letterSpacing: '0.2em', color: 'var(--text-faint)' }}>
                OPPONENT
              </span>
            </div>

            <div
              style={{
                width: 160,
                height: 160,
                borderRadius: '50%',
                border: '2px dashed var(--border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <span
                style={{
                  width: 32,
                  height: 32,
                  border: '3px solid var(--text-faint)',
                  borderTopColor: 'var(--gold)',
                  borderRadius: '50%',
                  display: 'inline-block',
                  animation: 'preduel-spin 1s linear infinite',
                }}
              />
            </div>

            <div className="col ai-c gap-4">
              <span className="t-mono t-xs t-faint" style={{ textAlign: 'center' }}>
                Waiting for a challenger…
              </span>
            </div>
          </div>
        </div>

        {/* Duel details. Every other screen labels its sections with a § header;
            this page had none, so it sat outside the rest of the app's rhythm. */}
        <div className="sect-head" style={{ width: '100%', maxWidth: 960 }}>
          <span className="sect-head-num">§ 01</span>
          <span className="sect-head-title">YOUR ENTRY</span>
          <span className="sect-head-meta">escrowed on-chain until the duel starts or you cancel</span>
        </div>

        <div className="card pad-24 row gap-24 ai-c" style={{ width: '100%', maxWidth: 960, flexWrap: 'wrap' }}>
          <div className="col gap-2">
            <span className="eyebrow">TIER</span>
            <span className="t-num" style={{ fontSize: 18, color: 'var(--gold)' }}>
              {turns > 0 ? `${turns} ROUNDS` : '—'}
            </span>
          </div>
          <span style={{ height: 32, width: 1, background: 'var(--border)' }} />
          <div className="col gap-2">
            <span className="eyebrow">POOLS</span>
            <span className="t-num" style={{ fontSize: 18 }}>{tierLabel}</span>
          </div>
          <span style={{ height: 32, width: 1, background: 'var(--border)' }} />
          <div className="col gap-2">
            <span className="eyebrow">DEPOSITED</span>
            <span className="t-num" style={{ fontSize: 18, color: 'var(--gain)' }}>{deposit} USDso</span>
          </div>
        </div>

        {/* Cancel button */}
        <div className="row gap-16 ai-c">
          <BracketButton
            variant="ghost"
            onClick={() => router.push('/duel')}
          >
            ← BACK TO LOBBY
          </BracketButton>
        </div>

      </div>
    </div>
  );
}
