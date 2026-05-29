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

const RIBBON = ({ hex, side, tier, rank, winning }: { hex: string; side: 'a' | 'b'; tier: string; rank: string; winning: boolean }) => {
  const isRight = side === 'b';
  return (
    <div
      className="row ai-c jc-sb"
      style={{
        padding: '8px 12px',
        background: `linear-gradient(${isRight ? 270 : 90}deg, ${hex}26, transparent 70%)`,
        borderBottom: `1px solid ${hex}55`,
      }}
    >
      <div className="row gap-8 ai-c">
        <span
          style={{
            width: 22, height: 22, background: hex, color: '#0a0612',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--fnt-display)', fontWeight: 700, fontSize: 14,
          }}
        >{rank}</span>
        <span className="t-display t-up" style={{ fontSize: 13, color: hex, letterSpacing: '0.18em', whiteSpace: 'nowrap' }}>
          FIGHTER {isRight ? 'B' : 'A'}
        </span>
        <span className="t-mono t-xs t-dim">·</span>
        <span className="t-mono t-xs t-dim" style={{ whiteSpace: 'nowrap' }}>{tier}</span>
      </div>
      <Chip variant={winning ? 'win' : 'loss'}>
        <Dot variant={winning ? 'win' : 'loss'} pulse />
        {winning ? 'WINNING' : 'LOSING'}
      </Chip>
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
    <div className="col gap-6">
      <span className="label-tiny">HOLDINGS</span>
      <div className="col gap-6">
        {holdings.map((h, i) => (
          <div key={h.token} className="col gap-2">
            <div className="row jc-sb ai-c" style={{ gap: 12 }}>
              <span className="row gap-8 ai-c" style={{ minWidth: 0 }}>
                <span style={{ width: 6, height: 6, background: color, display: 'inline-block', boxShadow: `0 0 6px ${color}`, flexShrink: 0 }} />
                <span className="t-mono t-xs t-dim" style={{ whiteSpace: 'nowrap' }}>{h.token}</span>
              </span>
              <span className="t-num t-sm" style={{ whiteSpace: 'nowrap' }}>{h.amount}</span>
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
        <div className="row gap-16 ai-s" style={{ padding: 16 }}>
          <FighterAvatar fighter={fighter.id} context="arena" size={portraitSize} state={winning ? 'winning' : 'losing'} />
          <div className="col gap-8 grow" style={{ minWidth: 0 }}>
            <div className="row jc-sb ai-c">
              <span className="t-display t-up" style={{ fontSize: 18, color: hex, letterSpacing: '0.12em', whiteSpace: 'nowrap' }}>{name}</span>
              <span className="t-mono t-xs t-dim" style={{ whiteSpace: 'nowrap' }}>&ldquo;{tagline}&rdquo;</span>
            </div>
            <div className="row gap-16 ai-c">
              <div className="col gap-2">
                <span className="label-tiny">PNL</span>
                <span className="t-num" style={{ fontSize: 26, lineHeight: 1, color: winning ? 'var(--win)' : 'var(--loss)', whiteSpace: 'nowrap' }}>
                  <AnimatedNumber value={pnl} formatter={fmtUsd} duration={500} />
                </span>
              </div>
              <div className="col gap-2">
                <span className="label-tiny">CHANGE</span>
                <span className="t-num t-sm" style={{ color: winning ? 'var(--win)' : 'var(--loss)', whiteSpace: 'nowrap' }}>
                  {winning ? '▲' : '▼'} <AnimatedNumber value={pct} formatter={fmtPct} duration={500} />
                </span>
              </div>
              <div className="flex-1" style={{ minWidth: 0 }}>
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
      <div className="col" style={{ padding: 20, gap: 14 }}>
        <div className="row ai-s gap-16">
          <div style={{ flexShrink: 0 }}>
            <FighterAvatar fighter={fighter.id} context="arena" size={portraitSize} state={winning ? 'winning' : 'losing'} />
          </div>
          <div className="col gap-8 grow" style={{ minWidth: 0 }}>
            <div className="col gap-2">
              <span className="t-display t-up" style={{ fontSize: layout === 'oneUp' ? 24 : 20, color: hex, letterSpacing: '0.12em', lineHeight: 1.1, whiteSpace: 'nowrap' }}>{name}</span>
              <span className="t-mono t-xs t-dim" style={{ whiteSpace: 'nowrap' }}>&ldquo;{tagline}&rdquo;</span>
            </div>
            <div className="col gap-2">
              <span className="label-tiny">ROUND PNL</span>
              <span className="t-num" style={{ fontSize: layout === 'oneUp' ? 40 : 32, lineHeight: 1, color: winning ? 'var(--win)' : 'var(--loss)', whiteSpace: 'nowrap' }}>
                <AnimatedNumber value={pnl} formatter={fmtUsd} duration={500} />
              </span>
              <span className="t-num t-sm" style={{ color: winning ? 'var(--win)' : 'var(--loss)', whiteSpace: 'nowrap' }}>
                {winning ? '▲▲▲' : '▼▼▼'} <AnimatedNumber value={pct} formatter={fmtPct} duration={500} />
              </span>
            </div>
          </div>
        </div>

        <div className="col gap-4">
          <div className="row jc-sb ai-c" style={{ gap: 12 }}>
            <span className="label-tiny">PNL TIMELINE</span>
            <span className="t-mono t-xs t-dim" style={{ whiteSpace: 'nowrap' }}>ROUND 1—{history.length}</span>
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
  const autoAdvance = true;

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
    <div className="col" style={{ minHeight: 'calc(100vh - 56px)' }}>
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
        <div className="row ai-c jc-sb" style={{ padding: '12px 24px', gap: 16, position: 'relative' }}>
          <div className="row gap-16 ai-c">
            <span className="t-mono t-xs" style={{ letterSpacing: '0.28em', color: 'var(--text-faint)' }}>§ ARENA · MAIN EVENT</span>
            <span style={{ height: 14, width: 1, background: 'var(--border)' }} />
            <Chip variant="live"><Dot variant="a" pulse /> LIVE</Chip>
            <span className="t-mono t-xs" style={{ whiteSpace: 'nowrap', color: 'var(--text-dim)' }}>
              ROUND <span className="t-num" style={{ color: 'var(--text)' }}>{simState.round}</span>
              <span className="t-faint"> / 15</span>
            </span>
            <span className="t-mono t-xs" style={{ whiteSpace: 'nowrap', color: 'var(--text-dim)' }}>
              BELL <span className="t-num" style={{ color: simState.timeLeft < 60 ? 'var(--loss)' : 'var(--text)' }}>{fmtTime(simState.timeLeft)}</span>
            </span>
          </div>
          <div className="row gap-16 ai-c">
            <span className="t-mono t-xs t-dim" style={{ whiteSpace: 'nowrap' }}>
              <span className="t-num" style={{ color: 'var(--text)' }}>{simState.spectators}</span> watching
            </span>
            <span className="t-mono t-xs t-dim" style={{ whiteSpace: 'nowrap' }}>
              POT <span className="t-num text-gold">${simState.pot}</span>
            </span>
            <span style={{ height: 14, width: 1, background: 'var(--border)' }} />
            <Link href="/duel">
              <BracketButton variant="ghost">LEAVE ←</BracketButton>
            </Link>
          </div>
        </div>
      </div>

      <div className="shell-pad col gap-24" style={{ flex: 1 }}>
        {/* § COMBATANTS */}
        <div className="col gap-12">
          <div className="sect-head">
            <span className="sect-head-num">§ COMBATANTS</span>
            <span className="sect-head-title">RED CORNER · BLUE CORNER</span>
            <span className="sect-head-meta">round {simState.round} of 15 · 90s per round</span>
          </div>

          {layout === 'split' && (
            <div className="row gap-16" style={{ alignItems: 'stretch' }}>
              <div className="col gap-16" style={{ flex: 1 }}>{degenCard}</div>
              <div className="col ai-c jc-c" style={{ width: 80 }}>
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
              <div className="col gap-16" style={{ flex: 1 }}>{whaleCard}</div>
            </div>
          )}

          {layout === 'oneUp' && (() => {
            const dWin = simState.degen.pnl >= simState.whale.pnl;
            const Hero = dWin ? degenCard : whaleCard;
            const Other = dWin ? whaleCard : degenCard;
            return (
              <div className="row gap-16" style={{ alignItems: 'stretch' }}>
                <div style={{ flex: 1.6 }}>{Hero}</div>
                <div style={{ flex: 1, opacity: 0.85, transform: 'scale(0.97)' }}>{Other}</div>
              </div>
            );
          })()}

          {layout === 'stacked' && (
            <div className="col gap-12">
              {degenCard}
              <div className="row ai-c jc-c">
                <span className="t-display" style={{ fontSize: 24, color: 'var(--text-faint)' }}>— VS —</span>
              </div>
              {whaleCard}
            </div>
          )}
        </div>

        {/* § FEED — Reasoning */}
        <div
          className="card pad-24 col gap-16"
          style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.012), transparent 40%), var(--bg-card)' }}
        >
          <div className="sect-head">
            <span className="sect-head-num">§ FEED</span>
            <span className="sect-head-title">FIGHTER REASONING</span>
            <span className="sect-head-meta">LIVE LLM · CTX 8K · gpt-5-fight</span>
          </div>
          <div className="col gap-16">
            <div className="col gap-4">
              <div className="row gap-8 ai-c">
                <Dot variant="a" pulse={simState.degen.thinking} />
                <span className="label-tiny" style={{ color: 'var(--fighter-a)', whiteSpace: 'nowrap' }}>
                  {FIGHTERS.degen.name} {simState.degen.thinking ? 'THINKING…' : 'DECIDED'}
                </span>
              </div>
              <div className="t-mono t-sm" style={{ color: 'var(--text)', paddingLeft: 16, lineHeight: 1.5, minHeight: 22 }}>
                <span className="t-dim">{'> '}</span>
                <Typewriter text={simState.degen.reasoning} speed={42} />
              </div>
            </div>
            <div className="col gap-4">
              <div className="row gap-8 ai-c">
                <Dot variant="b" pulse={simState.whale.thinking} />
                <span className="label-tiny" style={{ color: 'var(--fighter-b)', whiteSpace: 'nowrap' }}>
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
        <div className="card pad-24 col gap-12">
          <div className="sect-head">
            <span className="sect-head-num">§ MARKET</span>
            <span className="sect-head-title">WBTC / USDSO</span>
            <span className="sect-head-meta">dreamDEX · order book live</span>
          </div>
          <div className="row ai-c" style={{ gap: 32 }}>
            <div className="col gap-2" style={{ flexShrink: 0 }}>
              <span className="label-tiny">BID</span>
              <span className="t-num" style={{ fontSize: 18 }}>${simState.market.bid.toFixed(2)}</span>
            </div>
            <div className="col gap-2" style={{ flexShrink: 0 }}>
              <span className="label-tiny">ASK</span>
              <span className="t-num" style={{ fontSize: 18 }}>${simState.market.ask.toFixed(2)}</span>
            </div>
            <div className="col gap-2" style={{ flexShrink: 0 }}>
              <span className="label-tiny">24H</span>
              <span className={`t-num ${simState.market.change >= 0 ? 'text-win' : 'text-loss'}`} style={{ fontSize: 18 }}>
                {fmtPct(simState.market.change)}
              </span>
            </div>
            <div className="col gap-2 grow">
              <span className="label-tiny">LAST FILLS — {(simState.market.buyRatio * 100).toFixed(0)}% BUYS</span>
              <div className="row gap-2 ai-c">
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
            <div className="col gap-2 ai-e" style={{ flexShrink: 0 }}>
              <span className="label-tiny">VOL 24H</span>
              <span className="t-num text-gold" style={{ fontSize: 18 }}>${simState.market.vol.toFixed(1)}M</span>
            </div>
          </div>
        </div>

        {/* § BOOK — Betting Drawer */}
        <div className="card pad-24 col gap-12">
          <div className="sect-head">
            <span className="sect-head-num">§ BOOK</span>
            <span className="sect-head-title">PLACE YOUR BET</span>
            <span className="sect-head-meta">{betPlaced ? 'BET LOCKED' : 'BETS OPEN · one-click · no review'}</span>
          </div>
          <div className="col gap-8">
            <div className="row jc-sb ai-c">
              <span className="t-mono t-xs" style={{ color: 'var(--fighter-a)' }}>
                DEGEN <span className="t-num" style={{ fontSize: 16, marginLeft: 4 }}>{simState.oddsDegen}%</span>
              </span>
              <span className="t-mono t-xs" style={{ color: 'var(--fighter-b)' }}>
                <span className="t-num" style={{ fontSize: 16, marginRight: 4 }}>{100 - simState.oddsDegen}%</span> WHALE
              </span>
            </div>
            <OddsBar oddsA={simState.oddsDegen} oddsB={100 - simState.oddsDegen} />
          </div>
          <div className="row gap-12 ai-c jc-sb" style={{ flexWrap: 'wrap' }}>
            <div className="row gap-8 ai-c" style={{ flexWrap: 'wrap' }}>
              {!walletConnected ? (
                <BracketButton variant="primary" onClick={() => setWalletConnected(true)}>CONNECT TO BET</BracketButton>
              ) : betPlaced ? (
                <Chip variant="gold">
                  <Dot variant="warn" /> YOUR BET · ${betAmount} on {FIGHTERS[betPlaced].name}
                </Chip>
              ) : (
                <>
                  <BracketButton variant="a" onClick={() => handleBet('degen', 2)}>BACK DEGEN +$2</BracketButton>
                  <BracketButton variant="a" onClick={() => handleBet('degen', 5)}>+$5</BracketButton>
                  <span className="t-mono t-xs t-faint">·</span>
                  <BracketButton variant="b" onClick={() => handleBet('whale', 2)}>BACK WHALE +$2</BracketButton>
                  <BracketButton variant="b" onClick={() => handleBet('whale', 5)}>+$5</BracketButton>
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
          <div className="card pad-24 row jc-sb ai-c" style={{ borderColor: 'var(--gold)' }}>
            <div className="row gap-16 ai-c">
              <Chip variant="gold">★ DUEL CONCLUDED</Chip>
              <div className="col gap-2">
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
          <div className="card pad-16 row jc-sb ai-c" style={{ borderColor: 'var(--border)' }}>
            <span className="t-mono t-xs t-dim" style={{ letterSpacing: '0.18em' }}>
              ▸ NEXT TURN IN <span className="t-num" style={{ color: 'var(--text)' }}>{simState.turnIn}s</span> · AUTO {autoAdvance ? 'ON' : 'OFF'}
            </span>
            <div className="row gap-8">
              <BracketButton onClick={handleAdvance}>ADVANCE TURN ▸</BracketButton>
              <BracketButton variant="ghost" onClick={handleFastForward}>▸▸ JUMP TO END</BracketButton>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
