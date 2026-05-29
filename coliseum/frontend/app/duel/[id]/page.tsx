'use client';

import React, { useReducer, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AppTopBar } from '@/components/shared/AppTopBar';
import { FighterAvatar } from '@/components/shared/FighterAvatar';
import { Sparkline } from '@/components/shared/Sparkline';
import { OddsBar } from '@/components/shared/OddsBar';
import { AnimatedNumber } from '@/components/shared/AnimatedNumber';
import { Typewriter } from '@/components/shared/Typewriter';
import { BracketButton, Chip, Dot } from '@/components/shared/OtherHUD';
import { useUIStore } from '@/store/ui';
import { simReducer, makeInitialSim } from '@/lib/simulation';
import { FIGHTERS } from '@/lib/fighters';
import { fmtUsd, fmtPct, fmtTime } from '@/lib/format';

type Layout = 'split' | 'oneUp' | 'stacked';

interface Holding {
  token: string;
  amount: string | number;
  pct?: number;
}

interface SimFighter {
  pnl: number;
  history: number[];
  holdings: Holding[];
  reasoning: string;
  thinking?: boolean;
}

const RIBBON = ({ hex, side, tier, rank, winning }: { hex: string; side: 'a' | 'b'; tier: string; rank: string; winning: boolean }) => {
  const isRight = side === 'b';
  return (
    <div
      className="flex items-center justify-between"
      style={{
        padding: '8px 12px',
        background: `linear-gradient(${isRight ? 270 : 90}deg, ${hex}26, transparent 70%)`,
        borderBottom: `1px solid ${hex}55`,
      }}
    >
      <div className="flex items-center gap-2">
        <span
          className="inline-flex items-center justify-center"
          style={{
            width: 22, height: 22, background: hex, color: '#0a0612',
            fontFamily: 'var(--fnt-display)', fontWeight: 700, fontSize: 14,
          }}
        >{rank}</span>
        <span className="t-display t-up" style={{ fontSize: 13, color: hex, letterSpacing: '0.18em' }}>
          FIGHTER {isRight ? 'B' : 'A'}
        </span>
        <span className="t-mono t-xs t-dim">·</span>
        <span className="t-mono t-xs t-dim">{tier}</span>
      </div>
      <span className={`chip ${winning ? 'chip-win' : 'chip-loss'}`}>
        <span className={`dot ${winning ? 'dot-win' : 'dot-loss'} pulse`} />
        {winning ? 'WINNING' : 'LOSING'}
      </span>
    </div>
  );
};

function HoldingsBlock({ holdings, color }: { holdings: Holding[]; color: string }) {
  const totals = holdings.map((h) => {
    const num = typeof h.amount === 'number' ? h.amount : parseFloat(String(h.amount).replace(/[^0-9.-]/g, '')) || 0;
    return num;
  });
  const max = Math.max(...totals, 1);
  return (
    <div className="flex flex-col gap-2">
      <span className="label-tiny">HOLDINGS</span>
      <div className="flex flex-col gap-2">
        {holdings.map((h, i) => (
          <div key={h.token} className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 min-w-0">
                <span style={{ width: 6, height: 6, background: color, display: 'inline-block', boxShadow: `0 0 6px ${color}`, flexShrink: 0 }} />
                <span className="t-mono t-xs t-dim whitespace-nowrap">{h.token}</span>
              </span>
              <span className="t-num t-sm whitespace-nowrap">{typeof h.amount === 'number' ? h.amount : h.amount}</span>
            </div>
            <div style={{ height: 2, background: 'var(--bg-card-2)', position: 'relative' }}>
              <div style={{ position: 'absolute', inset: 0, width: `${(totals[i] / max) * 100}%`, background: color, opacity: 0.7 }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FighterCardSplit({
  fighter,
  pnl,
  history,
  holdings,
  layout,
}: {
  fighter: { id: string; name: string; hex: string; side: 'a' | 'b'; tier: string; tagline: string; rank: string };
  pnl: number;
  history: number[];
  holdings: Holding[];
  layout: Layout;
}) {
  const winning = pnl >= 0;
  const { hex, side, name, tier, tagline, rank } = fighter;
  const portraitSize = layout === 'oneUp' ? 220 : layout === 'stacked' ? 100 : 160;
  const sparklineW = layout === 'oneUp' ? 600 : layout === 'stacked' ? 300 : 420;
  const pct = (pnl / 300) * 100;

  if (layout === 'stacked') {
    return (
      <div
        className={`card ${winning ? `glow-${side}` : ''}`}
        style={{ border: `1px solid ${hex}`, overflow: 'hidden', transition: 'box-shadow 600ms ease' }}
      >
        <RIBBON hex={hex} side={side} tier={tier} rank={rank} winning={winning} />
        <div className="flex items-start gap-4" style={{ padding: 16 }}>
          <FighterAvatar fighter={fighter.id} context="arena" size={portraitSize} state={winning ? 'winning' : 'losing'} />
          <div className="flex flex-col gap-2 grow min-w-0">
            <div className="flex justify-between items-center">
              <span className="t-display t-up" style={{ fontSize: 18, color: hex, letterSpacing: '0.12em' }}>{name}</span>
              <span className="t-mono t-xs t-dim">&ldquo;{tagline}&rdquo;</span>
            </div>
            <div className="flex items-center gap-4">
              <div className="flex flex-col gap-0.5">
                <span className="label-tiny">PNL</span>
                <span className="t-num" style={{ fontSize: 26, lineHeight: 1, color: winning ? 'var(--win)' : 'var(--loss)' }}>
                  <AnimatedNumber value={pnl} formatter={fmtUsd} duration={500} />
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="label-tiny">CHANGE</span>
                <span className="t-num t-sm" style={{ color: winning ? 'var(--win)' : 'var(--loss)' }}>
                  {winning ? '▲' : '▼'} <AnimatedNumber value={pct} formatter={fmtPct} duration={500} />
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <Sparkline data={history} color={hex} width={sparklineW} height={36} />
              </div>
            </div>
            <HoldingsBlock holdings={holdings} color={hex} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`card ${winning ? `glow-${side}` : ''}`}
      style={{ border: `1px solid ${hex}`, overflow: 'hidden', transition: 'box-shadow 600ms ease' }}
    >
      <RIBBON hex={hex} side={side} tier={tier} rank={rank} winning={winning} />
      <div className="flex flex-col" style={{ padding: 20, gap: 14 }}>
        <div className="flex items-start gap-4">
          <div style={{ flexShrink: 0 }}>
            <FighterAvatar fighter={fighter.id} context="arena" size={portraitSize} state={winning ? 'winning' : 'losing'} />
          </div>
          <div className="flex flex-col gap-2 grow min-w-0">
            <div className="flex flex-col gap-0.5">
              <span className="t-display t-up" style={{ fontSize: layout === 'oneUp' ? 24 : 20, color: hex, letterSpacing: '0.12em', lineHeight: 1.1 }}>{name}</span>
              <span className="t-mono t-xs t-dim">&ldquo;{tagline}&rdquo;</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="label-tiny">ROUND PNL</span>
              <span className="t-num" style={{ fontSize: layout === 'oneUp' ? 40 : 32, lineHeight: 1, color: winning ? 'var(--win)' : 'var(--loss)' }}>
                <AnimatedNumber value={pnl} formatter={fmtUsd} duration={500} />
              </span>
              <span className="t-num t-sm" style={{ color: winning ? 'var(--win)' : 'var(--loss)' }}>
                {winning ? '▲▲▲' : '▼▼▼'} <AnimatedNumber value={pct} formatter={fmtPct} duration={500} />
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex justify-between items-center gap-3">
            <span className="label-tiny">PNL TIMELINE</span>
            <span className="t-mono t-xs t-dim">ROUND 1—{history.length}</span>
          </div>
          <Sparkline data={history} color={hex} width={sparklineW} height={44} />
        </div>

        <hr className="divider" />
        <HoldingsBlock holdings={holdings} color={hex} />
      </div>
    </div>
  );
}

export default function ArenaPage() {
  const params = useParams();
  const layout = useUIStore((state) => state.layout) as Layout;

  const [simState, dispatch] = useReducer(simReducer, makeInitialSim());
  const [betPlaced, setBetPlaced] = useState<'degen' | 'whale' | null>(null);
  const [betAmount, setBetAmount] = useState<number>(0);
  const [walletConnected, setWalletConnected] = useState(false);
  const [balance, setBalance] = useState(25);

  useEffect(() => {
    const clock = setInterval(() => dispatch({ type: 'TICK' }), 1000);
    return () => clearInterval(clock);
  }, []);

  const handleAdvance = () => dispatch({ type: 'ADVANCE' });
  const handleFastForward = () => dispatch({ type: 'FAST_FORWARD' });

  const handleBet = (fighter: 'degen' | 'whale', amount: number) => {
    if (!walletConnected) {
      setWalletConnected(true);
      return;
    }
    if (betPlaced || balance < amount) return;
    setBetPlaced(fighter);
    setBetAmount(amount);
    setBalance(balance - amount);
    dispatch({ type: 'PLACE_BET', fighter, amount, odds: fighter === 'degen' ? simState.oddsDegen : 100 - simState.oddsDegen });
  };

  const degenF = {
    id: 'degen',
    name: FIGHTERS.degen.name,
    hex: FIGHTERS.degen.hex,
    side: 'a' as const,
    tier: FIGHTERS.degen.tier,
    tagline: FIGHTERS.degen.tagline,
    rank: FIGHTERS.degen.rank,
  };
  const whaleF = {
    id: 'whale',
    name: FIGHTERS.whale.name,
    hex: FIGHTERS.whale.hex,
    side: 'b' as const,
    tier: FIGHTERS.whale.tier,
    tagline: FIGHTERS.whale.tagline,
    rank: FIGHTERS.whale.rank,
  };

  const degenCard = (
    <FighterCardSplit fighter={degenF} pnl={simState.degen.pnl} history={simState.degen.history} holdings={simState.degen.holdings as Holding[]} layout={layout} />
  );
  const whaleCard = (
    <FighterCardSplit fighter={whaleF} pnl={simState.whale.pnl} history={simState.whale.history} holdings={simState.whale.holdings as Holding[]} layout={layout} />
  );

  const duelOver = simState.round > 15 || simState.timeLeft <= 0;

  return (
    <div className="flex flex-col min-h-screen bg-[var(--bg-deep)]">
      <AppTopBar />

      {/* ArenaStatusBar — broadcast slate */}
      <div style={{ background: 'var(--bg-stage)', borderBottom: '1px solid var(--border)', position: 'relative', overflow: 'hidden' }}>
        <div
          style={{
            position: 'absolute', inset: 0,
            background: 'linear-gradient(90deg, var(--fighter-a-soft), transparent 30%, transparent 70%, var(--fighter-b-soft))',
            pointerEvents: 'none',
          }}
        />
        <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-3 relative">
          <div className="flex items-center gap-4 flex-wrap">
            <span className="t-mono t-xs" style={{ letterSpacing: '0.28em', color: 'var(--text-faint)' }}>§ ARENA · MAIN EVENT</span>
            <span style={{ height: 14, width: 1, background: 'var(--border)' }} />
            <Chip variant="live"><Dot variant="a" pulse className="mr-1" /> LIVE</Chip>
            <span className="t-mono t-xs" style={{ color: 'var(--text-dim)' }}>
              ROUND <span className="t-num" style={{ color: 'var(--text)' }}>{simState.round}</span>
              <span className="t-faint"> / 15</span>
            </span>
            <span className="t-mono t-xs" style={{ color: 'var(--text-dim)' }}>
              BELL <span className="t-num" style={{ color: simState.timeLeft < 60 ? 'var(--loss)' : 'var(--text)' }}>{fmtTime(simState.timeLeft)}</span>
            </span>
          </div>
          <div className="flex items-center gap-4">
            <span className="t-mono t-xs t-dim">
              <span className="t-num" style={{ color: 'var(--text)' }}>{simState.spectators}</span> watching
            </span>
            <span className="t-mono t-xs t-dim">
              POT <span className="t-num text-gold">${simState.pot}</span>
            </span>
            <span style={{ height: 14, width: 1, background: 'var(--border)' }} />
            <Link href="/duel">
              <BracketButton variant="ghost" className="px-3 py-1.5">LEAVE ←</BracketButton>
            </Link>
          </div>
        </div>
      </div>

      <div className="shell-pad flex flex-col gap-6 py-6" style={{ maxWidth: 1440, margin: '0 auto', width: '100%' }}>
        {/* § COMBATANTS */}
        <div className="flex flex-col gap-3">
          <div className="sect-head">
            <span className="sect-head-num">§ COMBATANTS</span>
            <span className="sect-head-title">RED CORNER · BLUE CORNER</span>
            <span className="sect-head-meta">round {simState.round} of 15 · 90s per round</span>
          </div>

          {layout === 'split' && (
            <div className="flex items-stretch gap-4">
              <div className="flex flex-col gap-4 flex-1">{degenCard}</div>
              <div className="flex flex-col items-center justify-center" style={{ width: 80 }}>
                <span
                  className="t-display vs-pop"
                  style={{
                    fontSize: 56,
                    background: 'linear-gradient(180deg, var(--fighter-a), var(--fighter-b))',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                  }}
                >
                  VS
                </span>
              </div>
              <div className="flex flex-col gap-4 flex-1">{whaleCard}</div>
            </div>
          )}

          {layout === 'oneUp' && (() => {
            const dWin = simState.degen.pnl >= simState.whale.pnl;
            const Hero = dWin ? degenCard : whaleCard;
            const Other = dWin ? whaleCard : degenCard;
            return (
              <div className="flex items-stretch gap-4">
                <div style={{ flex: 1.6 }}>{Hero}</div>
                <div style={{ flex: 1, opacity: 0.85, transform: 'scale(0.97)' }}>{Other}</div>
              </div>
            );
          })()}

          {layout === 'stacked' && (
            <div className="flex flex-col gap-3">
              {degenCard}
              <div className="flex items-center justify-center">
                <span className="t-display" style={{ fontSize: 24, color: 'var(--text-faint)' }}>— VS —</span>
              </div>
              {whaleCard}
            </div>
          )}
        </div>

        {/* § FEED — Reasoning */}
        <div
          className="card pad-24 flex flex-col gap-4"
          style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.012), transparent 40%), var(--bg-card)' }}
        >
          <div className="sect-head">
            <span className="sect-head-num">§ FEED</span>
            <span className="sect-head-title">FIGHTER REASONING</span>
            <span className="sect-head-meta">LIVE LLM · CTX 8K · gpt-5-fight</span>
          </div>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <Dot variant="a" pulse={simState.degen.thinking} />
                <span className="label-tiny" style={{ color: 'var(--fighter-a)' }}>
                  {FIGHTERS.degen.name} {simState.degen.thinking ? 'THINKING…' : 'DECIDED'}
                </span>
              </div>
              <div className="t-mono t-sm" style={{ color: 'var(--text)', paddingLeft: 16, lineHeight: 1.5, minHeight: 22 }}>
                <span className="t-dim">{'> '}</span>
                <Typewriter text={simState.degen.reasoning} speed={42} />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <Dot variant="b" pulse={simState.whale.thinking} />
                <span className="label-tiny" style={{ color: 'var(--fighter-b)' }}>
                  {FIGHTERS.whale.name} {simState.whale.thinking ? 'THINKING…' : 'DECIDED'}
                </span>
              </div>
              <div className="t-mono t-sm" style={{ color: 'var(--text)', paddingLeft: 16, lineHeight: 1.5, minHeight: 22 }}>
                <span className="t-dim">{'> '}</span>
                <Typewriter text={simState.whale.reasoning} speed={42} />
              </div>
            </div>
          </div>
        </div>

        {/* § MARKET — WBTC ticker */}
        <div className="card pad-24 flex flex-col gap-3">
          <div className="sect-head">
            <span className="sect-head-num">§ MARKET</span>
            <span className="sect-head-title">WBTC / USDSO</span>
            <span className="sect-head-meta">dreamDEX · order book live</span>
          </div>
          <div className="flex items-center gap-8">
            <div className="flex flex-col gap-0.5" style={{ flexShrink: 0 }}>
              <span className="label-tiny">BID</span>
              <span className="t-num" style={{ fontSize: 18 }}>${simState.market.bid.toFixed(2)}</span>
            </div>
            <div className="flex flex-col gap-0.5" style={{ flexShrink: 0 }}>
              <span className="label-tiny">ASK</span>
              <span className="t-num" style={{ fontSize: 18 }}>${simState.market.ask.toFixed(2)}</span>
            </div>
            <div className="flex flex-col gap-0.5" style={{ flexShrink: 0 }}>
              <span className="label-tiny">24H</span>
              <span className="t-num" style={{ fontSize: 18, color: simState.market.change >= 0 ? 'var(--win)' : 'var(--loss)' }}>
                {fmtPct(simState.market.change)}
              </span>
            </div>
            <div className="flex flex-col gap-1 grow">
              <span className="label-tiny">LAST FILLS — {(simState.market.buyRatio * 100).toFixed(0)}% BUYS</span>
              <div className="flex gap-0.5 items-center">
                {Array.from({ length: 28 }).map((_, i) => {
                  const buy = i < simState.market.buyRatio * 28;
                  return (
                    <span
                      key={i}
                      style={{
                        flex: 1,
                        height: 14,
                        background: buy ? 'var(--win)' : 'var(--loss)',
                        opacity: 0.85,
                      }}
                    />
                  );
                })}
              </div>
            </div>
            <div className="flex flex-col gap-0.5 items-end" style={{ flexShrink: 0 }}>
              <span className="label-tiny">VOL 24H</span>
              <span className="t-num text-gold" style={{ fontSize: 18 }}>${(simState.market.vol / 1_000).toFixed(1)}K</span>
            </div>
          </div>
        </div>

        {/* § BOOK — Betting Drawer */}
        <div className="card pad-24 flex flex-col gap-3">
          <div className="sect-head">
            <span className="sect-head-num">§ BOOK</span>
            <span className="sect-head-title">PLACE YOUR BET</span>
            <span className="sect-head-meta">{betPlaced ? 'BET LOCKED' : 'BETS OPEN · one-click · no review'}</span>
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex justify-between items-center">
              <span className="t-mono t-xs" style={{ color: 'var(--fighter-a)' }}>
                DEGEN <span className="t-num" style={{ fontSize: 16, marginLeft: 4 }}>{simState.oddsDegen}%</span>
              </span>
              <span className="t-mono t-xs" style={{ color: 'var(--fighter-b)' }}>
                <span className="t-num" style={{ fontSize: 16, marginRight: 4 }}>{100 - simState.oddsDegen}%</span> WHALE
              </span>
            </div>
            <OddsBar oddsA={simState.oddsDegen} oddsB={100 - simState.oddsDegen} />
          </div>
          <div className="flex justify-between items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              {!walletConnected ? (
                <BracketButton variant="primary" onClick={() => setWalletConnected(true)}>CONNECT TO BET</BracketButton>
              ) : betPlaced ? (
                <Chip variant="gold">
                  <Dot variant="warn" className="mr-1" /> YOUR BET · ${betAmount} on {FIGHTERS[betPlaced].name}
                </Chip>
              ) : (
                <>
                  <BracketButton variant="a" onClick={() => handleBet('degen', 2)} className="px-3 py-2">BACK DEGEN +$2</BracketButton>
                  <BracketButton variant="a" onClick={() => handleBet('degen', 5)} className="px-3 py-2">+$5</BracketButton>
                  <span className="t-mono t-xs t-faint">·</span>
                  <BracketButton variant="b" onClick={() => handleBet('whale', 2)} className="px-3 py-2">BACK WHALE +$2</BracketButton>
                  <BracketButton variant="b" onClick={() => handleBet('whale', 5)} className="px-3 py-2">+$5</BracketButton>
                </>
              )}
            </div>
            <span className="t-mono t-xs t-dim">
              BALANCE <span className="t-num text-gold">${balance.toFixed(2)}</span>
            </span>
          </div>
        </div>

        {/* Turn controls / end-of-duel */}
        {duelOver ? (
          <div
            className="card flex items-center justify-between gap-4"
            style={{ borderColor: 'var(--gold)', padding: 24 }}
          >
            <div className="flex items-center gap-4">
              <Chip variant="gold">★ DUEL CONCLUDED</Chip>
              <div className="flex flex-col gap-0.5">
                <span className="label-tiny">FINAL VERDICT</span>
                <span
                  className="t-display t-up"
                  style={{
                    fontSize: 18,
                    letterSpacing: '0.14em',
                    color: simState.degen.pnl >= simState.whale.pnl ? 'var(--fighter-a)' : 'var(--fighter-b)',
                  }}
                >
                  THE {simState.degen.pnl >= simState.whale.pnl ? 'DEGEN' : 'WHALE'} WINS
                </span>
              </div>
            </div>
            <Link href={`/duel/${params?.id ?? 1}/result`}>
              <BracketButton variant="gold">SEE WINNER →</BracketButton>
            </Link>
          </div>
        ) : (
          <div
            className="card flex items-center justify-between gap-3"
            style={{ borderColor: 'var(--border)', padding: 16 }}
          >
            <span className="t-mono t-xs t-dim" style={{ letterSpacing: '0.18em' }}>
              ▸ NEXT TURN IN <span className="t-num" style={{ color: 'var(--text)' }}>{simState.turnIn}s</span> · AUTO ON
            </span>
            <div className="flex gap-2">
              <BracketButton onClick={handleAdvance}>ADVANCE TURN ▸</BracketButton>
              <BracketButton variant="ghost" onClick={handleFastForward}>▸▸ JUMP TO END</BracketButton>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
