'use client';

import React from 'react';
import Link from 'next/link';
import { useRouter, useParams } from 'next/navigation';
import { useAccount, useReadContract, usePublicClient } from 'wagmi';
import { formatUnits, parseAbiItem } from 'viem';
import { useEffect, useState } from 'react';
import { AppTopBar } from '@/components/shared/AppTopBar';
import { FighterAvatar } from '@/components/shared/FighterAvatar';
import { BracketButton, Chip } from '@/components/shared/OtherHUD';
import SettlePanel from '@/components/shared/SettlePanel';
import { useDuelState } from '@/hooks/useDuelState';
import { useDuelTranscript } from '@/hooks/useDuelTranscript';
import { FIGHTERS, FIGHTER_VISUAL_MAP } from '@/lib/fighters';
import { CONTRACT_ADDRESSES, ABIS, BOOKMAKER_DEPLOY_BLOCK } from '@/lib/contracts';
import { getLogsChunked, duelToBlock } from '@/lib/logs';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtUsdso(raw: bigint): string {
  const n = Number(formatUnits(raw, 18));
  // Sub-cent (but non-zero) values show 4 decimals so they don't read as "0.00".
  const decimals = n > 0 && n < 0.01 ? 4 : 2;
  return `$${n.toFixed(decimals)}`;
}

// DuelResolved event for backfill
const DUEL_RESOLVED_EVENT = parseAbiItem(
  'event DuelResolved(uint256 indexed duelId, uint8 indexed winnerFighterId, uint256 valueA, uint256 valueB)',
);

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ResultPage() {
  const router = useRouter();
  const params = useParams();
  const rawId = String(params?.id ?? '0');
  const duelId = BigInt(rawId || '0');

  const { address: userAddress } = useAccount();
  const publicClient = usePublicClient();

  // ── On-chain duel state ───────────────────────────────────────────────────
  const { duel, isLoading, currentTurn } = useDuelState(duelId);

  // Read the full Arena tuple to get fighterA / fighterB indexes.
  const { data: duelRaw } = useReadContract({
    address: CONTRACT_ADDRESSES.Arena,
    abi: ABIS.Arena,
    functionName: 'duels',
    args: [duelId],
    query: { enabled: duelId > BigInt(0) },
  });

  const fighterAIndex = duelRaw ? Number(duelRaw[0]) : undefined;
  const fighterBIndex = duelRaw ? Number(duelRaw[1]) : undefined;

  // ── Move-by-move transcript (FighterMove / FighterMoveFailed events) ───────
  const duelStartBlock = duelRaw ? (duelRaw[3] as unknown as bigint) : undefined;
  const duelTurns = duelRaw ? Number(duelRaw[6]) : 3;
  const duelLastTurnBlock = duelRaw ? (duelRaw[4] as unknown as bigint) : undefined;
  const { entries: transcript } = useDuelTranscript(duelId, duelStartBlock, duelTurns, duelLastTurnBlock);

  const fighterNameOf = (fid: number): string => {
    const v = FIGHTER_VISUAL_MAP[fid];
    return v ? (FIGHTERS[v.id]?.name ?? `FIGHTER #${fid}`) : `FIGHTER #${fid}`;
  };
  const fighterHexOf = (fid: number): string => FIGHTER_VISUAL_MAP[fid]?.hex ?? 'var(--text)';

  // ── Matchmaker check (PvP duel detection) ─────────────────────────────────
  const { data: matchData } = useReadContract({
    address: CONTRACT_ADDRESSES.Matchmaker,
    abi: ABIS.Matchmaker,
    functionName: 'matches',
    args: [duelId],
    query: { enabled: duelId > BigInt(0) },
  });

  const matchPlayerA = matchData ? (matchData[0] as `0x${string}`) : undefined;
  const isMatchmakerDuel =
    !!matchPlayerA &&
    matchPlayerA !== '0x0000000000000000000000000000000000000000';

  // ── DuelResolved event backfill → real final valueA / valueB ─────────────
  const [resolvedValueA, setResolvedValueA] = useState<bigint | null>(null);
  const [resolvedValueB, setResolvedValueB] = useState<bigint | null>(null);

  useEffect(() => {
    if (!publicClient || duelId <= BigInt(0)) return;
    let cancelled = false;
    void (async () => {
      try {
        const fromBlock = duelRaw ? (duelRaw[3] as unknown as bigint) : BOOKMAKER_DEPLOY_BLOCK;
        const turns = duelRaw ? Number(duelRaw[6]) : 3;
        const lastTurnBlock = duelRaw ? (duelRaw[4] as unknown as bigint) : undefined;
        const logs = await getLogsChunked(publicClient, {
          address: CONTRACT_ADDRESSES.Arena,
          event: DUEL_RESOLVED_EVENT,
          args: { duelId },
          fromBlock,
          toBlock: duelToBlock(fromBlock, turns, lastTurnBlock),
        }) as { args: { valueA?: bigint; valueB?: bigint } }[];
        if (cancelled || logs.length === 0) return;
        // Take the latest DuelResolved log for this duel
        const last = logs[logs.length - 1];
        const args = last.args as { valueA?: bigint; valueB?: bigint };
        if (args.valueA !== undefined) setResolvedValueA(args.valueA);
        if (args.valueB !== undefined) setResolvedValueB(args.valueB);
      } catch {
        // Non-fatal — show "—" in the UI
      }
    })();
    return () => { cancelled = true; };
  }, [publicClient, duelId, duelRaw]);

  // ── Derived display values ────────────────────────────────────────────────
  const isResolved = duel?.status === 3;

  const isCreator =
    !isMatchmakerDuel &&
    !!userAddress &&
    !!duel?.creator &&
    duel.creator.toLowerCase() === userAddress.toLowerCase();

  // winnerSlot: 0 = fighterA, 1 = fighterB
  const winnerSlotNum = isResolved && duel ? duel.winnerSlot : null;
  const winnerFighterIndex =
    winnerSlotNum === 0 ? fighterAIndex : winnerSlotNum === 1 ? fighterBIndex : undefined;
  const loserFighterIndex =
    winnerSlotNum === 0 ? fighterBIndex : winnerSlotNum === 1 ? fighterAIndex : undefined;

  const winnerVisual =
    winnerFighterIndex !== undefined ? FIGHTER_VISUAL_MAP[winnerFighterIndex] : null;
  const loserVisual =
    loserFighterIndex !== undefined ? FIGHTER_VISUAL_MAP[loserFighterIndex] : null;

  const winnerId = winnerVisual ? winnerVisual.id : 'degen';
  const loserId  = loserVisual  ? loserVisual.id  : 'whale';

  const winnerFighter = FIGHTERS[winnerId];
  const loserFighter  = FIGHTERS[loserId];
  const winnerHex = winnerVisual?.hex ?? winnerFighter?.hex ?? 'var(--gold)';

  // Real final portfolio values from DuelResolved event
  const winnerFinalValue: bigint | null =
    isResolved && resolvedValueA !== null && resolvedValueB !== null
      ? (winnerSlotNum === 0 ? resolvedValueA : resolvedValueB)
      : null;
  const loserFinalValue: bigint | null =
    isResolved && resolvedValueA !== null && resolvedValueB !== null
      ? (winnerSlotNum === 0 ? resolvedValueB : resolvedValueA)
      : null;

  const wValueDisplay = winnerFinalValue !== null ? fmtUsdso(winnerFinalValue) : '—';
  const lValueDisplay = loserFinalValue  !== null ? fmtUsdso(loserFinalValue)  : '—';

  const turns = duel?.turns ?? 0;

  // ── Not-resolved state ────────────────────────────────────────────────────
  if (!isLoading && (!duel || duel.status === 0)) {
    return (
      <div className="col">
        <AppTopBar />
        <div className="col ai-c jc-c" style={{ flex: 1, gap: 16, padding: 96, textAlign: 'center' }}>
          <span className="t-display t-up" style={{ fontSize: 28, color: 'var(--text-faint)', letterSpacing: '0.14em' }}>
            NO DUEL FOUND
          </span>
          <span className="t-mono t-sm t-dim">Duel #{rawId} does not exist on-chain.</span>
          <Link href="/duel"><BracketButton variant="ghost">← BACK TO LOBBY</BracketButton></Link>
        </div>
      </div>
    );
  }

  if (!isLoading && duel && duel.status !== 3) {
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
            <Chip variant="win">IN PROGRESS</Chip>
          </div>
        </div>
        <div className="col ai-c jc-c" style={{ flex: 1, gap: 16, padding: 96, textAlign: 'center' }}>
          <span className="t-display t-up" style={{ fontSize: 28, color: 'var(--text-faint)', letterSpacing: '0.14em' }}>
            DUEL NOT RESOLVED YET
          </span>
          <span className="t-mono t-sm t-dim">
            Round {currentTurn} of {turns} — check back after all turns complete and finalizeDuel is called.
          </span>
          <Link href={`/duel/${rawId}`}>
            <BracketButton>WATCH LIVE →</BracketButton>
          </Link>
        </div>
      </div>
    );
  }

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
      </div>

      {/* Winner reveal */}
      <section style={{ position: 'relative', padding: '96px 32px 64px', overflow: 'hidden' }}>
        <div className="col ai-c gap-16" style={{ position: 'relative', maxWidth: 1320, margin: '0 auto' }}>
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
            {isLoading ? 'LOADING…' : (winnerFighter?.name ?? 'UNKNOWN')}
          </h1>

          <div className="row gap-32 ai-c" style={{ marginTop: 24, flexWrap: 'wrap', justifyContent: 'center' }}>
            <div className="col ai-c gap-2">
              <span className="eyebrow">FINAL PORTFOLIO</span>
              <span className="t-num text-win" style={{ fontSize: 32, whiteSpace: 'nowrap' }}>
                {wValueDisplay}
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
                style={{ fontSize: 18, color: 'var(--text)', letterSpacing: '0.12em' }}
              >
                {isResolved ? 'PNL on mid mark prices · finalizeDuel' : 'Duel in progress'}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* § 01 FINAL TAPE */}
      <section className="shell-pad col gap-16" style={{ paddingTop: 32, paddingBottom: 56 }}>
        <div className="sect-head">
          <span className="sect-head-num">§ 01</span>
          <span className="sect-head-title">FINAL TAPE</span>
          <span className="sect-head-meta">{turns} rounds settled · DuelResolved on-chain</span>
        </div>

        <div className="row gap-16" style={{ alignItems: 'stretch', flexWrap: 'wrap' }}>
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
              <span className="t-num text-win" style={{ fontSize: 28 }}>{wValueDisplay}</span>
            </div>
            <hr className="divider" />
            <div className="row jc-sb t-mono t-xs t-dim">
              <span>Final value source</span>
              <span className="t-num text-win">{isResolved ? 'DuelResolved event' : 'pending'}</span>
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

          {/* Loser card */}
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
              <span className="t-num text-loss" style={{ fontSize: 28 }}>{lValueDisplay}</span>
            </div>
            <hr className="divider" />
            <div className="row jc-sb t-mono t-xs t-dim">
              <span>Final value source</span>
              <span className="t-num text-win">{isResolved ? 'DuelResolved event' : 'pending'}</span>
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
      <section className="shell-pad col gap-16" style={{ paddingTop: 32, paddingBottom: 56 }}>
        <div className="sect-head">
          <span className="sect-head-num">§ 02</span>
          <span className="sect-head-title">SETTLEMENT</span>
          <span className="sect-head-meta">
            {isMatchmakerDuel
              ? 'pvp matchmaker duel · claim your winnings below'
              : isCreator
              ? 'you created this duel · recover funds below'
              : 'settle bets or recover winnings'}
          </span>
        </div>

        <SettlePanel
          duelId={duelId}
          isCreator={isCreator}
          matchmakerDuel={isMatchmakerDuel}
          winnerName={winnerFighter?.name}
          loserName={loserFighter?.name}
          winnerColor={winnerHex}
          loserColor={loserFighter?.hex}
        />
      </section>

      {/* § 03 FIGHT TAPE — move-by-move transcript */}
      {transcript.length > 0 && (
        <section className="shell-pad col gap-16" style={{ paddingTop: 32, paddingBottom: 56 }}>
          <div className="sect-head">
            <span className="sect-head-num">§ 03</span>
            <span className="sect-head-title">FIGHT TAPE</span>
            <span className="sect-head-meta">{transcript.length} moves · FighterMove events on-chain</span>
          </div>
          <div className="card pad-24 col">
            {transcript.map((e, i) => (
              <div
                key={i}
                className="row ai-c t-mono t-sm"
                style={{
                  gap: 16,
                  padding: '8px 0',
                  borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                }}
              >
                <span className="t-dim" style={{ width: 48, flexShrink: 0 }}>R{e.round}</span>
                <span style={{ color: fighterHexOf(e.fighterId), flex: 1, letterSpacing: '0.04em' }}>
                  {fighterNameOf(e.fighterId)}
                </span>
                <span
                  className="t-num"
                  style={{ color: e.failed ? 'var(--text-faint)' : 'var(--text)', textAlign: 'right' }}
                >
                  {e.failed ? `— ${e.reason || 'no move'}` : e.action}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Action row */}
      <section className="shell-pad" style={{ paddingTop: 48, paddingBottom: 120 }}>
        <div className="row gap-12 ai-c jc-c" style={{ flexWrap: 'wrap' }}>
          <BracketButton variant="gold">SHARE CARD ⤴</BracketButton>
          <BracketButton variant="primary" onClick={() => router.push('/duel')}>
            NEXT BOUT →
          </BracketButton>
        </div>
      </section>
    </div>
  );
}
