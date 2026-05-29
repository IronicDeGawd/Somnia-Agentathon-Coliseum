'use client';

import React, { useReducer, useEffect } from 'react';
import Link from 'next/link';
import { AppTopBar } from '@/components/shared/AppTopBar';
import { FighterAvatar } from '@/components/shared/FighterAvatar';
import { Sparkline } from '@/components/shared/Sparkline';
import { OddsBar } from '@/components/shared/OddsBar';
import { BracketButton, Chip, Dot } from '@/components/shared/OtherHUD';
import { simReducer, makeInitialSim } from '@/lib/simulation';
import { ROSTER } from '@/lib/fighters';
import { fmtUsd, fmtTime } from '@/lib/format';

export default function LobbyPage() {
  const [sim, dispatch] = useReducer(simReducer, makeInitialSim());

  useEffect(() => {
    const clock = setInterval(() => dispatch({ type: 'TICK' }), 1000);
    return () => clearInterval(clock);
  }, []);

  // Ticker items rendered as a flat list of nodes, separated by · between each
  const tickerItemNodes: React.ReactNode[] = [
    <>WBTC/USDSO <span className="t-num text-win">67,425.10</span> +0.34%</>,
    <>ETH/USDSO <span className="t-num text-loss">3,148.20</span> −0.92%</>,
    <>SOL/USDSO <span className="t-num text-win">142.88</span> +2.18%</>,
    <>VOLUME 24H <span className="t-num">$12.4M</span></>,
    <>3 BOUTS ON THE CARD</>,
    <>TODAY&rsquo;S PURSE <span className="t-num text-gold">$4,872</span></>,
  ];

  return (
    <div className="col">
      <AppTopBar />

      {/* ── LOBBY MARQUEE ──────────────────────────────────────────── */}
      <section style={{ position: 'relative', borderBottom: '1px solid var(--border)', overflow: 'hidden' }}>
        {/* Faded backdrop portraits */}
        <div style={{ position: 'absolute', left: -40, top: 40, opacity: 0.18, transform: 'rotate(-3deg)', pointerEvents: 'none' }}>
          <FighterAvatar fighter="degen" context="card" size={320} state="winning" chrome={false} />
        </div>
        <div style={{ position: 'absolute', right: -40, top: 40, opacity: 0.18, transform: 'rotate(3deg)', pointerEvents: 'none' }}>
          <FighterAvatar fighter="whale" context="card" size={320} state="winning" chrome={false} />
        </div>

        <div className="shell-pad col gap-16" style={{ position: 'relative', paddingTop: 36, paddingBottom: 36 }}>
          {/* Status strip */}
          <div className="row jc-sb ai-c">
            <div className="row gap-12 ai-c">
              <span className="t-mono t-xs" style={{ letterSpacing: '0.28em', color: 'var(--text-faint)' }}>§ LOBBY · MAIN HALL</span>
              <span style={{ height: 12, width: 1, background: 'var(--border)' }} />
              <Chip variant="gold">▸ NEXT BOUT · ROUND #342</Chip>
            </div>
            <span className="t-mono t-xs t-dim" style={{ letterSpacing: '0.18em', whiteSpace: 'nowrap' }}>21:00 UTC · BEST OF 15 · TESTNET</span>
          </div>

          {/* Big poster headline */}
          <div className="col ai-c gap-4" style={{ paddingTop: 12 }}>
            <span className="eyebrow" style={{ color: 'var(--text-dim)' }}>TONIGHT&rsquo;S MAIN EVENT</span>
            <h1
              className="fp-display"
              style={{
                fontSize: 'clamp(56px, 8vw, 96px)',
                letterSpacing: '0.04em',
                lineHeight: 1,
                textAlign: 'center',
                margin: '8px 0',
                color: 'var(--text)',
              }}
            >
              <span className="text-a">THE DEGEN</span>
              <span style={{ color: 'var(--text-faint)', margin: '0 16px' }}>vs</span>
              <span className="text-b">THE WHALE</span>
            </h1>
          </div>

          {/* 4-up stat strip — BELL IN / PURSE / ODDS / BETTORS */}
          {/* gap-2 matches design source (col ai-c gap-2 on each stat block) */}
          <div className="row gap-32 ai-c jc-c" style={{ marginTop: 8 }}>
            <div className="col ai-c gap-2">
              <span className="eyebrow">BELL IN</span>
              <span className="t-num text-gold" style={{ fontSize: 36, lineHeight: 1 }}>{fmtTime(sim.countdown)}</span>
            </div>
            <span style={{ height: 36, width: 1, background: 'var(--border)' }} />
            <div className="col ai-c gap-2">
              <span className="eyebrow">PURSE</span>
              <span className="t-num text-gold" style={{ fontSize: 36, lineHeight: 1 }}>${sim.potNext}</span>
            </div>
            <span style={{ height: 36, width: 1, background: 'var(--border)' }} />
            <div className="col ai-c gap-2">
              <span className="eyebrow">ODDS</span>
              <span className="t-num" style={{ fontSize: 36, lineHeight: 1, whiteSpace: 'nowrap' }}>
                <span className="text-a">{sim.oddsDegen}</span>
                <span style={{ color: 'var(--text-faint)', fontSize: 22 }}> · </span>
                <span className="text-b">{100 - sim.oddsDegen}</span>
              </span>
            </div>
            <span style={{ height: 36, width: 1, background: 'var(--border)' }} />
            <div className="col ai-c gap-2">
              <span className="eyebrow">BETTORS</span>
              <span className="t-num" style={{ fontSize: 36, lineHeight: 1, color: 'var(--text)' }}>14</span>
            </div>
          </div>

          {/* CTAs — all route to preduel */}
          <div className="row gap-12 ai-c jc-c" style={{ marginTop: 12 }}>
            <Link href="/duel/1/preduel"><BracketButton variant="a">BACK DEGEN</BracketButton></Link>
            <Link href="/duel/1/preduel"><BracketButton variant="primary">ENTER PRE-DUEL →</BracketButton></Link>
            <Link href="/duel/1/preduel"><BracketButton variant="b">BACK WHALE</BracketButton></Link>
          </div>
        </div>

        {/* Ticker bottom strip */}
        <div style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-stage)', height: 36, overflow: 'hidden', position: 'relative' }}>
          <div className="ticker" style={{ height: '100%', alignItems: 'center', paddingLeft: 16 }}>
            {[0, 1].map((k) => (
              <div className="row gap-32 ai-c" key={k} style={{ height: '100%' }}>
                {tickerItemNodes.map((item, i) => (
                  <React.Fragment key={i}>
                    <span className="t-mono t-xs t-dim">{item}</span>
                    {i < tickerItemNodes.length - 1 && (
                      <span className="t-mono t-xs t-dim">·</span>
                    )}
                  </React.Fragment>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── § 01 LIVE NOW ──────────────────────────────────────────── */}
      <section className="shell-pad col gap-16" style={{ paddingTop: 40, paddingBottom: 40 }}>
        <div className="sect-head">
          <span className="sect-head-num">§ 01</span>
          <span className="sect-head-title">LIVE NOW</span>
          <span className="sect-head-meta">round #341 · in progress</span>
        </div>

        <div className="card corner-card acc-a glow-a" style={{ overflow: 'hidden' }}>
          {/* Header strip */}
          <div
            className="row ai-c"
            style={{
              padding: '10px 16px',
              background: 'linear-gradient(90deg, var(--fighter-a-soft), transparent 70%)',
              borderBottom: '1px solid var(--border)',
              gap: 12,
            }}
          >
            <Chip variant="live"><Dot variant="a" pulse /> LIVE</Chip>
            <span className="t-mono t-xs t-dim" style={{ whiteSpace: 'nowrap' }}>
              R<span className="t-num" style={{ color: 'var(--text)' }}>{sim.round}/15</span>
              <span style={{ margin: '0 8px' }}>·</span>
              <span className="t-num" style={{ color: 'var(--text)' }}>{fmtTime(sim.timeLeft)}</span> left
            </span>
            <div className="grow" />
            <span className="t-mono t-xs t-dim" style={{ whiteSpace: 'nowrap' }}>{sim.spectators} watching</span>
          </div>

          {/* Two-fighter body */}
          <div className="row gap-24" style={{ padding: 24, alignItems: 'stretch' }}>
            <div className="col gap-12 flex-1">
              <div className="row jc-sb ai-c">
                {/* gap-10 matches design source (row gap-10 ai-c) */}
                <div className="row ai-c" style={{ gap: 10 }}>
                  <FighterAvatar fighter="degen" context="mini" size={32} />
                  <span className="t-display t-up" style={{ color: 'var(--fighter-a)', letterSpacing: '0.12em', fontSize: 14 }}>THE DEGEN</span>
                </div>
                <span className="t-num" style={{ fontSize: 24, color: sim.degen.pnl >= 0 ? 'var(--win)' : 'var(--loss)' }}>
                  {fmtUsd(sim.degen.pnl)}
                </span>
              </div>
              <Sparkline data={sim.degen.history} color="var(--fighter-a)" height={48} />
            </div>

            <div className="col ai-c jc-c" style={{ width: 60 }}>
              <span className="t-display" style={{ fontSize: 32, color: 'var(--text-faint)' }}>VS</span>
            </div>

            <div className="col gap-12 flex-1">
              <div className="row jc-sb ai-c">
                <span className="t-num" style={{ fontSize: 24, color: sim.whale.pnl >= 0 ? 'var(--win)' : 'var(--loss)' }}>
                  {fmtUsd(sim.whale.pnl)}
                </span>
                {/* gap-10 matches design source (row gap-10 ai-c) */}
                <div className="row ai-c" style={{ gap: 10 }}>
                  <span className="t-display t-up" style={{ color: 'var(--fighter-b)', letterSpacing: '0.12em', fontSize: 14 }}>THE WHALE</span>
                  <FighterAvatar fighter="whale" context="mini" size={32} />
                </div>
              </div>
              <Sparkline data={sim.whale.history} color="var(--fighter-b)" height={48} />
            </div>
          </div>

          {/* Footer: odds + JOIN SPECTATORS */}
          {/* jc-sb handles spacing; no gap class — button gets marginLeft per design source */}
          <div
            className="row ai-c jc-sb"
            style={{ padding: '16px 24px', borderTop: '1px solid var(--border)', background: 'var(--bg-stage)' }}
          >
            <div className="col gap-4" style={{ flex: 2 }}>
              <div className="row jc-sb t-mono t-xs">
                <span className="text-a">DEGEN {sim.oddsDegen}%</span>
                <span className="text-b">WHALE {100 - sim.oddsDegen}%</span>
              </div>
              {/* height={8} matches design source OddsBar call: <OddsBar degen={sim.oddsDegen} height={8} /> */}
              <OddsBar oddsA={sim.oddsDegen} oddsB={100 - sim.oddsDegen} className="!h-[8px]" />
            </div>
            <Link href="/duel/1" style={{ marginLeft: 24 }}>
              <BracketButton variant="a">JOIN SPECTATORS →</BracketButton>
            </Link>
          </div>
        </div>
      </section>

      {/* ── § 02 STANDINGS ─────────────────────────────────────────── */}
      <section className="shell-pad col gap-16" style={{ paddingTop: 16, paddingBottom: 40 }}>
        <div className="sect-head">
          <span className="sect-head-num">§ 02</span>
          <span className="sect-head-title">STANDINGS</span>
          <span className="sect-head-meta">season 02 · all-time leaderboard</span>
        </div>

        <div className="card" style={{ padding: '0 24px' }}>
          {/* Header row */}
          <div className="row ai-c gap-16" style={{ padding: '12px 0', borderBottom: '1px solid var(--text-faint)' }}>
            <span className="label-tiny" style={{ width: 32 }}>#</span>
            <span className="label-tiny" style={{ flex: 1 }}>FIGHTER</span>
            <span className="label-tiny" style={{ width: 90 }}>RECORD</span>
            <span className="label-tiny" style={{ width: 100, textAlign: 'right' }}>TOTAL PNL</span>
            <span className="label-tiny" style={{ width: 220 }}>FORM</span>
            <span className="label-tiny" style={{ width: 60, textAlign: 'right' }}></span>
          </div>

          {ROSTER.map((r, i) => {
            const isPos = r.pnl >= 0;
            const maxAbs = 400;
            const w = Math.min(100, (Math.abs(r.pnl) / maxAbs) * 100);
            return (
              <div
                key={r.id}
                className="row ai-c gap-16"
                style={{
                  padding: '14px 0',
                  borderBottom: i < ROSTER.length - 1 ? '1px solid var(--border)' : 'none',
                  cursor: 'pointer',
                }}
                onClick={() => { window.location.href = `/fighters/${r.id}`; }}
              >
                <span className="t-num t-sm t-dim" style={{ width: 32 }}>{String(i + 1).padStart(2, '0')}</span>
                {/* gap-10 matches design source (row gap-10 ai-c flex-1) */}
                <div className="row ai-c flex-1" style={{ gap: 10, minWidth: 0 }}>
                  <FighterAvatar fighter={r.id} context="mini" size={28} />
                  <span className="t-display t-up" style={{ color: r.hex, letterSpacing: '0.08em', fontSize: 14, whiteSpace: 'nowrap' }}>{r.name}</span>
                  <span className="t-mono t-xs t-faint" style={{ whiteSpace: 'nowrap' }}>· {r.tier}</span>
                </div>
                <span className="t-num t-sm" style={{ width: 90 }}>{r.record}</span>
                <span className="t-num" style={{ width: 100, textAlign: 'right', color: isPos ? 'var(--win)' : 'var(--loss)' }}>
                  {fmtUsd(r.pnl)}
                </span>
                <div style={{ width: 220, height: 4, background: 'var(--bg-card-2)', position: 'relative' }}>
                  <div
                    style={{
                      position: 'absolute',
                      top: 0,
                      bottom: 0,
                      left: isPos ? '50%' : `${50 - w / 2}%`,
                      width: `${w / 2}%`,
                      background: isPos ? 'var(--win)' : 'var(--loss)',
                    }}
                  />
                  <div style={{ position: 'absolute', left: '50%', top: -2, bottom: -2, width: 1, background: 'var(--text-faint)' }} />
                </div>
                <Link
                  href={`/fighters/${r.id}`}
                  className="bk bk-ghost"
                  style={{ width: 60, textAlign: 'center' }}
                  onClick={(e) => e.stopPropagation()}
                >
                  VIEW →
                </Link>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── § 03 YOUR LEDGER ───────────────────────────────────────── */}
      <section className="shell-pad col gap-16" style={{ paddingTop: 16, paddingBottom: 80 }}>
        <div className="sect-head">
          <span className="sect-head-num">§ 03</span>
          <span className="sect-head-title">YOUR LEDGER</span>
          <span className="sect-head-meta">lifetime PnL · +$48.92 across 12 bouts</span>
        </div>

        <div className="row gap-16">
          {[
            { status: 'live', round: 341, fighters: 'DEGEN vs WHALE',      bet: '$5 on DEGEN @ 65%',   est: '+$2.69 est.', color: 'var(--win)' },
            { status: 'won',  round: 339, fighters: 'DEGEN vs CONTRARIAN', bet: '$10 on DEGEN @ 58%',  est: '+$7.24',      color: 'var(--win)' },
            { status: 'lost', round: 338, fighters: 'SCALPER vs SURFER',   bet: '$5 on SCALPER @ 47%', est: '−$5.00',      color: 'var(--loss)' },
            { status: 'won',  round: 336, fighters: 'WHALE vs DEGEN',      bet: '$8 on WHALE @ 51%',   est: '+$7.85',      color: 'var(--win)' },
          ].map((b) => (
            <div key={b.round} className="card pad-16 col gap-8 flex-1">
              <div className="row jc-sb ai-c">
                {b.status === 'live' ? (
                  <Chip variant="live"><Dot variant="a" pulse /> LIVE</Chip>
                ) : b.status === 'won' ? (
                  <Chip variant="win">WON</Chip>
                ) : (
                  <Chip variant="loss">LOST</Chip>
                )}
                <span className="t-mono t-xs t-faint">#{b.round}</span>
              </div>
              <span className="t-mono t-sm">{b.fighters}</span>
              <hr className="divider" />
              <span className="t-mono t-xs t-dim">{b.bet}</span>
              <span className="t-num" style={{ color: b.color, fontSize: 18 }}>{b.est}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
