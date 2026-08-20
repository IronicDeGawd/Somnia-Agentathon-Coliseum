'use client';

import React from 'react';
import Link from 'next/link';
import { useRouter, useParams } from 'next/navigation';
import { useAccount, useReadContract, useReadContracts, usePublicClient } from 'wagmi';
import { formatUnits, parseAbiItem } from 'viem';
import { useEffect, useState } from 'react';
import { AppTopBar } from '@/components/shared/AppTopBar';
import { FighterAvatar } from '@/components/shared/FighterAvatar';
import { BracketButton, Chip } from '@/components/shared/OtherHUD';
import SettlePanel from '@/components/shared/SettlePanel';
import { useDuelState } from '@/hooks/useDuelState';
import { useDuelTranscript, type TranscriptEntry } from '@/hooks/useDuelTranscript';
import { useDuelSlots } from '@/hooks/useDuelSlots';
import { FIGHTERS, FIGHTER_VISUAL_MAP } from '@/lib/fighters';
import { CONTRACT_ADDRESSES, ABIS, BOOKMAKER_DEPLOY_BLOCK, DRAW_SLOT, DUEL_HISTORY_DEPLOYED } from '@/lib/contracts';
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
  const duelSlots = useDuelSlots(duelId);

  // WHICH GAME THIS WAS. The page showed a winner, a portfolio and a move tape and
  // never once said whether the fight was coins, predictions or perpetuals — so a
  // tape reading "BUY SIMPOOLWETH" was the only clue, and only to someone who
  // already knew the codebase.
  //
  // Read off what the fight actually traded rather than from anything stored: a
  // perp slot makes it perps, a labelled question makes it predictions, and the
  // simulated flag separates the practice ring from the real coin books.
  const marketName = duelSlots === undefined
    ? null
    : duelSlots.some((sl) => sl.isPerp)
      ? 'PERPETUALS'
      : duelSlots.some((sl) => sl.label && sl.label.length > 0)
        ? 'PREDICTIONS'
        : duel?.simulated
          ? 'PRACTICE RING'
          : 'SPOT COINS';
  const { entries: transcript } = useDuelTranscript(duelId, duelStartBlock, duelTurns, duelLastTurnBlock, duelSlots);

  const fighterNameOf = (fid: number): string => {
    const v = FIGHTER_VISUAL_MAP[fid];
    return v ? (FIGHTERS[v.id]?.name ?? `FIGHTER #${fid}`) : `FIGHTER #${fid}`;
  };
  /**
 * The fight as a scorecard: one column per round, one row per fighter.
 *
 * It was a flat list of thirty lines, alternating fighters, each repeating the
 * round number — so comparing what the two of them did in the same round meant
 * reading two lines that were not next to each other and were not in a
 * predictable order. Laid out as a grid the comparison is the whole point: read
 * DOWN a column to see a round, ACROSS a row to see one fighter's whole fight.
 *
 * The round order comes from the transcript; the ROW order is pinned to the
 * duel's own fighter slots rather than to whoever happens to appear first,
 * because the moves within a round arrive in whatever order the chain logged
 * them and a row that swaps sides mid-table is worse than no table.
 *
 * Wide fights scroll sideways inside their own card rather than stretching the
 * page — fifteen rounds of "BACK BTCHOUR" does not fit a phone.
 */
function TapeScorecard({
  transcript,
  fighterA,
  fighterB,
}: {
  transcript: TranscriptEntry[];
  fighterA?: number;
  fighterB?: number;
}) {
  const rounds = Array.from(new Set(transcript.map((e) => e.round))).sort((x, y) => x - y);

  // Prefer the duel's own slots; fall back to first-appearance only when the duel
  // has not loaded, so the table still renders rather than vanishing.
  const seen = Array.from(new Set(transcript.map((e) => e.fighterId)));
  const rowIds = (fighterA !== undefined && fighterB !== undefined) ? [fighterA, fighterB] : seen;

  const cell = (fid: number, round: number) =>
    transcript.find((e) => e.fighterId === fid && e.round === round);

  const border = '1px solid var(--border)';

  return (
    <table
      className="t-mono t-sm"
      style={{ borderCollapse: 'collapse', minWidth: '100%', whiteSpace: 'nowrap' }}
    >
      <thead>
        <tr>
          <th
            style={{
              textAlign: 'left', padding: '6px 16px 6px 0', borderBottom: border,
              position: 'sticky', left: 0, background: 'var(--bg-card)', zIndex: 1,
            }}
          />
          {rounds.map((r) => (
            <th
              key={r}
              className="t-dim"
              style={{ textAlign: 'left', padding: '6px 16px', borderBottom: border, fontWeight: 400 }}
            >
              R{r}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rowIds.map((fid) => (
          <tr key={fid}>
            <th
              scope="row"
              style={{
                textAlign: 'left', padding: '8px 16px 8px 0', borderBottom: border,
                color: fighterHexOf(fid), letterSpacing: '0.04em', fontWeight: 400,
                position: 'sticky', left: 0, background: 'var(--bg-card)', zIndex: 1,
              }}
            >
              {fighterNameOf(fid)}
            </th>
            {rounds.map((r) => {
              const e = cell(fid, r);
              return (
                <td
                  key={r}
                  className="t-num"
                  style={{
                    padding: '8px 16px', borderBottom: border,
                    color: !e ? 'var(--text-faint)'
                      : e.failed ? 'var(--text-faint)' : 'var(--text)',
                  }}
                >
                  {!e ? '·' : e.failed ? `— ${e.reason || 'no move'}` : e.action}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

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

  // ── Final valueA / valueB ─────────────────────────────────────────────────
  //
  // Two sources, in this order:
  //
  //  1. DuelHistory's ledger. It stores both values per duel and answers in ONE
  //     read, whenever the duel was resolved.
  //  2. The DuelResolved log, for duels older than the history sink.
  //
  // The log used to be the only source, and it went wrong: the scan is bounded to
  // ~1500 blocks past the duel's last turn, so a fight finalised later than that
  // showed a blank portfolio FOREVER — the window is derived from the duel's own
  // blocks and never widens. Seen for real when the keeper was down nine minutes:
  // resolution landed 2983 blocks past the window and the values were on chain the
  // whole time. Widening the window is not the fix either; scanning to the chain
  // head means an unbounded number of RPC calls for an old duel.
  const [resolvedValueA, setResolvedValueA] = useState<bigint | null>(null);
  const [resolvedValueB, setResolvedValueB] = useState<bigint | null>(null);

  // Source 1: the ledger. Reads the most recent slice and looks for this duel —
  // enough for anything current, and the log path below still covers the rest.
  const { data: historyData } = useReadContracts({
    contracts: DUEL_HISTORY_DEPLOYED
      ? [{
          address: CONTRACT_ADDRESSES.DuelHistory,
          abi: ABIS.DuelHistory,
          functionName: 'totalDuels' as const,
        }]
      : [],
    query: { enabled: DUEL_HISTORY_DEPLOYED },
  });
  const ledgerLength = (historyData?.[0]?.result as bigint | undefined) ?? BigInt(0);
  const LEDGER_WINDOW = BigInt(250);
  const ledgerOffset = ledgerLength > LEDGER_WINDOW ? ledgerLength - LEDGER_WINDOW : BigInt(0);

  const { data: entriesData } = useReadContracts({
    contracts: ledgerLength > BigInt(0)
      ? [{
          address: CONTRACT_ADDRESSES.DuelHistory,
          abi: ABIS.DuelHistory,
          functionName: 'getEntries' as const,
          args: [ledgerOffset, ledgerLength - ledgerOffset] as [bigint, bigint],
        }]
      : [],
    query: { enabled: ledgerLength > BigInt(0) },
  });

  useEffect(() => {
    const entries = entriesData?.[0]?.result as
      | readonly { duelId: bigint; valueA: bigint; valueB: bigint }[]
      | undefined;
    if (!entries) return;
    const mine = entries.find((e) => e.duelId === duelId);
    if (!mine) return;
    setResolvedValueA(mine.valueA);
    setResolvedValueB(mine.valueB);
  }, [entriesData, duelId]);

  // Source 2: the log, for anything the ledger does not carry.
  useEffect(() => {
    if (!publicClient || duelId <= BigInt(0)) return;
    if (resolvedValueA !== null && resolvedValueB !== null) return;
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

  // winnerSlot: 0 = fighterA, 1 = fighterB, 2 = draw (neither won).
  // A draw is not an edge case: both fighters are funded identically, so any duel
  // where neither trades ends exactly level. Without this branch the page waits
  // forever on a winner that will never arrive.
  const winnerSlotNum = isResolved && duel ? duel.winnerSlot : null;
  const isDraw = isResolved && winnerSlotNum === DRAW_SLOT;
  const winnerFighterIndex =
    winnerSlotNum === 0 ? fighterAIndex : winnerSlotNum === 1 ? fighterBIndex : undefined;
  const loserFighterIndex =
    winnerSlotNum === 0 ? fighterBIndex : winnerSlotNum === 1 ? fighterAIndex : undefined;

  /**
   * Per-fighter move counts, read from the transcript rather than the persona
   * registry. A "trade" is any move that actually hit the book — HOLD is a
   * decision, not a trade, and a failed move never reached the pool at all.
   *
   * Deliberately NOT reporting best/worst round: FighterMove carries the action
   * but no portfolio value, and only DuelResolved carries value — so per-round
   * PnL cannot be derived from chain data here. The persona registry does hold
   * bestRound/worstRound, but those are fixtures from the design mock and would
   * be fabricated numbers on a settled duel.
   */
  // On a draw there is no winner/loser, and the two cards fall back to slot
  // order — so the counts must follow the same fallback or both cards report 0.
  const topCardIndex = isDraw ? fighterAIndex : winnerFighterIndex;
  const bottomCardIndex = isDraw ? fighterBIndex : loserFighterIndex;

  const movesFor = (idx: number | undefined) =>
    idx === undefined ? [] : transcript.filter((e) => e.fighterId === idx);
  const tradeCount = (idx: number | undefined) =>
    movesFor(idx).filter((e) => !e.failed && e.action !== null && e.action !== 'HOLD').length;
  const holdCount = (idx: number | undefined) =>
    movesFor(idx).filter((e) => !e.failed && e.action === 'HOLD').length;

  // On a draw there is no winner/loser, so show the two fighters in slot order.
  const drawAVisual = fighterAIndex !== undefined ? FIGHTER_VISUAL_MAP[fighterAIndex] : null;
  const drawBVisual = fighterBIndex !== undefined ? FIGHTER_VISUAL_MAP[fighterBIndex] : null;

  const winnerVisual =
    winnerFighterIndex !== undefined ? FIGHTER_VISUAL_MAP[winnerFighterIndex] : null;
  const loserVisual =
    loserFighterIndex !== undefined ? FIGHTER_VISUAL_MAP[loserFighterIndex] : null;

  // These fall back to a real fighter so the avatars always have something to
  // render, which means they are NOT evidence of who won. Gate any win/loss claim
  // on winnerKnown instead, or the page announces the fallback fighter as the
  // winner for the second before the duel data arrives.
  const winnerId = winnerVisual ? winnerVisual.id : 'degen';
  const loserId  = loserVisual  ? loserVisual.id  : 'whale';
  const winnerKnown = isResolved && winnerVisual !== null;

  const winnerFighter = FIGHTERS[winnerId];
  const loserFighter  = FIGHTERS[loserId];
  const winnerHex = winnerVisual?.hex ?? winnerFighter?.hex ?? 'var(--gold)';

  // Real final portfolio values — from the history ledger, or the log as fallback.
  const winnerFinalValue: bigint | null =
    isResolved && resolvedValueA !== null && resolvedValueB !== null
      ? (winnerSlotNum === 0 ? resolvedValueA : resolvedValueB)
      : null;
  const loserFinalValue: bigint | null =
    isResolved && resolvedValueA !== null && resolvedValueB !== null
      ? (winnerSlotNum === 0 ? resolvedValueB : resolvedValueA)
      : null;

  // On a draw the two columns are just slot A and slot B — there is no winner
  // side to put first, and the win/loss colouring would be a lie.
  const leftValue  = isDraw ? resolvedValueA : winnerFinalValue;
  const rightValue = isDraw ? resolvedValueB : loserFinalValue;

  const wValueDisplay = leftValue  !== null ? fmtUsdso(leftValue)  : '—';
  const lValueDisplay = rightValue !== null ? fmtUsdso(rightValue) : '—';

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
          {marketName && (
            <>
              <span className="t-mono t-xs" style={{ letterSpacing: '0.28em', color: 'var(--text-dim)' }}>
                {marketName}
              </span>
              <span style={{ height: 12, width: 1, background: 'var(--border)' }} />
            </>
          )}
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
              {isLoading
                ? 'LOADING…'
                : isDraw
                  ? '★ DRAW ★'
                  : isResolved
                    ? '★ WINNER ★'
                    : '★ RESULT PENDING ★'}
            </span>
            <span style={{ height: 1, width: 80, background: 'var(--gold)' }} />
          </div>

          {isDraw ? (
            // Both fighters, side by side, neither crowned.
            <div className="row gap-32 ai-c" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
              <FighterAvatar fighter={drawAVisual?.id ?? 'degen'} context="card" size={160} state="idle" />
              <span className="fp-display" style={{ fontSize: 32, color: 'var(--muted)' }}>=</span>
              <FighterAvatar fighter={drawBVisual?.id ?? 'whale'} context="card" size={160} state="idle" />
            </div>
          ) : (
            <div className="vs-pop" style={winnerKnown ? { filter: `drop-shadow(0 0 60px ${winnerHex})` } : undefined}>
              <FighterAvatar
                fighter={winnerId}
                context="card"
                size={220}
                state={winnerKnown ? 'victory' : 'idle'}
              />
            </div>
          )}

          <h1
            className="fp-display"
            style={{
              fontSize: 'clamp(56px, 8vw, 96px)',
              letterSpacing: '0.06em',
              lineHeight: 1,
              textAlign: 'center',
              margin: 0,
              color: isDraw ? 'var(--gold)' : winnerHex,
              textShadow: `0 0 60px ${isDraw ? 'var(--gold)' : winnerHex}`,
              whiteSpace: 'nowrap',
            }}
          >
            {isDraw
              ? 'DRAW'
              : isLoading || !winnerKnown
                ? 'LOADING…'
                : (winnerFighter?.name ?? 'UNKNOWN')}
          </h1>

          {isDraw && (
            <p style={{ textAlign: 'center', color: 'var(--muted)', maxWidth: 460, margin: '8px auto 0' }}>
              Both fighters finished level. Each player is refunded their own deposit less the
              arena fee, and every bet is returned in full with no rake.
            </p>
          )}

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
                {!isResolved ? 'DUEL IN PROGRESS' : isDraw ? 'DREW ON PNL' : 'PNL DECISION'}
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
                <FighterAvatar
                  fighter={isDraw ? (drawAVisual?.id ?? 'degen') : winnerId}
                  context="mini"
                  size={40}
                />
                <div className="col gap-2">
                  {isDraw ? (
                    <Chip variant="gold">DREW</Chip>
                  ) : winnerKnown ? (
                    <Chip variant="win">★ WON</Chip>
                  ) : (
                    <Chip variant="gold">RESOLVING…</Chip>
                  )}
                  <span
                    className="t-display t-up"
                    style={{
                      color: isDraw ? (drawAVisual?.hex ?? 'var(--gold)') : winnerHex,
                      fontSize: 18,
                      letterSpacing: '0.12em',
                    }}
                  >
                    {isDraw
                      ? (FIGHTERS[drawAVisual?.id ?? 'degen']?.name ?? '—')
                      : winnerKnown
                        ? (winnerFighter?.name ?? '—')
                        : '—'}
                  </span>
                </div>
              </div>
              <span className="t-num text-win" style={{ fontSize: 28 }}>{wValueDisplay}</span>
            </div>
            <hr className="divider" />
            <div className="row jc-sb t-mono t-xs t-dim">
              <span>Trades executed</span>
              <span className="t-num" style={{ color: 'var(--text)' }}>{tradeCount(topCardIndex)}</span>
            </div>
            <div className="row jc-sb t-mono t-xs t-dim">
              <span>Rounds held</span>
              <span className="t-num t-dim">{holdCount(topCardIndex)}</span>
            </div>
            <div className="row jc-sb t-mono t-xs t-dim">
              <span>Settled by</span>
              <span className="t-num" style={{ color: 'var(--text)' }}>
                {isResolved ? 'on-chain result' : 'pending'}
              </span>
            </div>
          </div>

          {/* Loser card */}
          <div className="card flex-1 col gap-12 pad-24" style={{ opacity: 0.7 }}>
            <div className="row jc-sb ai-c">
              <div className="row gap-12 ai-c">
                <FighterAvatar
                  fighter={isDraw ? (drawBVisual?.id ?? 'whale') : loserId}
                  context="mini"
                  size={40}
                />
                <div className="col gap-2">
                  {isDraw ? (
                    <Chip variant="gold">DREW</Chip>
                  ) : winnerKnown ? (
                    <Chip variant="loss">LOST</Chip>
                  ) : (
                    <Chip variant="gold">RESOLVING…</Chip>
                  )}
                  <span
                    className="t-display t-up"
                    style={{
                      color: isDraw
                        ? (drawBVisual?.hex ?? 'var(--text-dim)')
                        : (loserFighter?.hex ?? 'var(--text-dim)'),
                      fontSize: 18,
                      letterSpacing: '0.12em',
                    }}
                  >
                    {isDraw
                      ? (FIGHTERS[drawBVisual?.id ?? 'whale']?.name ?? '—')
                      : winnerKnown
                        ? (loserFighter?.name ?? '—')
                        : '—'}
                  </span>
                </div>
              </div>
              <span className="t-num text-loss" style={{ fontSize: 28 }}>{lValueDisplay}</span>
            </div>
            <hr className="divider" />
            <div className="row jc-sb t-mono t-xs t-dim">
              <span>Trades executed</span>
              <span className="t-num" style={{ color: 'var(--text)' }}>{tradeCount(bottomCardIndex)}</span>
            </div>
            <div className="row jc-sb t-mono t-xs t-dim">
              <span>Rounds held</span>
              <span className="t-num t-dim">{holdCount(bottomCardIndex)}</span>
            </div>
            <div className="row jc-sb t-mono t-xs t-dim">
              <span>Settled by</span>
              <span className="t-num" style={{ color: 'var(--text)' }}>
                {isResolved ? 'on-chain result' : 'pending'}
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
          winnerName={isDraw ? FIGHTERS[drawAVisual?.id ?? 'degen']?.name : winnerFighter?.name}
          loserName={isDraw ? FIGHTERS[drawBVisual?.id ?? 'whale']?.name : loserFighter?.name}
          winnerColor={isDraw ? (drawAVisual?.hex ?? 'var(--gold)') : winnerHex}
          loserColor={isDraw ? (drawBVisual?.hex ?? 'var(--text-dim)') : loserFighter?.hex}
        />
      </section>

      {/* § 03 FIGHT TAPE — move-by-move transcript */}
      {transcript.length > 0 && (
        <section className="shell-pad col gap-16" style={{ paddingTop: 32, paddingBottom: 56 }}>
          <div className="sect-head">
            <span className="sect-head-num">§ 03</span>
            <span className="sect-head-title">FIGHT TAPE</span>
            <span className="sect-head-meta">{transcript.length} moves · every one on-chain</span>
          </div>
          <div className="card pad-24" style={{ overflowX: 'auto' }}>
            <TapeScorecard
              transcript={transcript}
              fighterA={duel?.fighterA}
              fighterB={duel?.fighterB}
            />
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
