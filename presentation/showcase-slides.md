# Coliseum — Showcase Slides

> 7 slides for a Somnia Discord project showcase. Content only — drop into any deck tool.
> Every number here was verified on-chain on 2026-07-30. Do not inflate them on stage;
> the honest version is stronger than the polished one, and the chain is public.

---

## Slide 1 — Coliseum

**Two AI trading agents fight. On-chain. You bet on the winner.**

- Six agents, each with a distinct trading personality
- They trade a real order book, turn by turn, with real money at stake
- Every decision is made **by a model running on-chain** — not a server calling an API
- Live now: `coliseum.somniaforge.com`

*Footer:* 2nd place of ~800 builds — Somnia Agentathon. Built solo.

---

## Slide 2 — The Loop

**One duel, four repeating steps.**

1. **Two players queue** and each deposit half the pot. A house bot fills the second
   slot if nobody else is waiting, so a duel always starts.
2. **Every turn, each agent is asked one question on-chain:** here is the market, here
   is your position — buy, sell, or hold? The answer comes from Somnia's on-chain LLM
   inference, paid for in STT.
3. **The answer becomes an order** on dreamDEX's central limit order book. It either
   fills or it visibly fails — both are recorded as events.
4. **After the last turn**, both portfolios are valued at the mark price. Higher value
   wins the pot. Spectator bets settle automatically.

*Say out loud:* the agent's reasoning is not a UI animation. The move is a transaction.

---

## Slide 3 — Why This Needs Somnia

Four Somnia-specific things this is built on. It would not work the same anywhere else.

| Primitive | What Coliseum uses it for |
|---|---|
| **Somnia Agents** — on-chain LLM inference | The agent's actual decision. `inferNumber` is called from the Arena contract with the market summary and the fighter's persona prompt. |
| **dreamDEX** — native CLOB, zero fees | The market they fight over. Maker and taker fees read 0 on all three pools, so the fight is not eaten by spread costs. |
| **Sub-second blocks** — measured 0.094s | A 6-round duel resolves in minutes, not hours. A turn-based game needs cheap, fast finality. |
| **Somnia Reactivity** | The duel *can* tick itself forward — the on-chain handler is built (`Ping.sol`). It is currently deactivated because an every-block subscription burns STT continuously; a keeper drives turns instead. |

*Be straight about that last row if asked — see slide 7.*

---

## Slide 4 — Architecture

**On-chain (Solidity 0.8.24, 93 tests passing)**

- `Arena` — runs the duel: snapshots prices, requests each agent's move, routes the
  order, values portfolios, resolves. 23,487 bytes, just under the 24,576 EIP-170 limit.
- `Matchmaker` — per-tier PvP queue with escrowed deposits, refunds on cancel
- `Bookmaker` — parimutuel spectator betting, 5% rake
- `FighterRegistry` — the six personas. Prompts are **owner-mutable**, so agents can be
  retuned without a redeploy.
- `DuelHistory` — settled-duel ledger behind the standings and leaderboard

**Off-chain (small, and honest about it)**

- A keeper drives turns and finalization, opens each betting line, and auto-settles bets
- A price injector feeds the simulated market
- A market-maker bot keeps a resting bid on dreamDEX
- All Node + viem under PM2 on one box

**Frontend** — Next.js 16, wagmi, RainbowKit. Every number on screen is read from chain.

---

## Slide 5 — Two Markets, One Arena

Each duel carries a flag choosing which market it trades.

**Simulated market** — the demo default
- Mock pools whose prices **track live dreamDEX marks** (WETH ~1900, BTC ~64500, SOMI ~0.085)
- Held inside a ±30% band so a long-running feed cannot drift into nonsense
- Volatile enough that portfolios visibly diverge

**Real dreamDEX** — the credibility proof
- Duel #16 placed **three real taker orders that filled on the live book** at 0.0852
- The in-app `+ USDso` button is also a real dreamDEX order, not a faucet

**Entry tiers** (per side, simulated market)

| Rounds | Assets | Cost/side |
|---|---|---|
| 6 | SOMI + WETH | 3.60 USDso |
| 9 | + WBTC | 8.10 USDso |
| 15 | all three | 13.50 USDso |

The 3-round tier was removed: one asset means one choice per turn, so both agents
converge and the duel ends in a tie decided by position rather than skill.

---

## Slide 6 — Spectators and Economics

**Betting is parimutuel, not a bookmaker's book.**

- The line opens at even money the moment a duel goes live
- Winners get their stake back plus a proportional share of the losing pool
- The house takes a **5% rake** on the losing pool
- Duelists are blocked from betting on their own fight, on-chain

**Verified end to end** (duel #18): two 0.1 USDso bets on opposite sides → winner paid
**0.195**, rake **0.005**, `BetsSettled` emitted — **with nobody pressing a button.**

**Where revenue comes from at scale**
- The flat duel fee is cost recovery for inference and gas, not margin
- The 5% betting rake is the real business
- A duel nobody watches is roughly break-even. **Spectators are the product.**

---

## Slide 7 — What's Real, What's Next

**Working today, on a public testnet deployment**
- 18 duels resolved · agents trading, betting open, settlement automatic
- Real dreamDEX fills, real on-chain inference, all state readable by anyone

**Known limits — stated plainly**
- **Turns are keeper-driven.** The Reactivity handler exists but is switched off to
  avoid a continuous every-block gas burn. Moving the heartbeat on-chain is the
  headline next step.
- **On the real market agents can currently only buy.** dreamDEX changed its default
  funding to wallet auto-pull, which strands sell-side inventory in the contract's
  wallet. The fix is written and needs a redeploy.
- **An exact tie awards the pot to the left-hand fighter.** Position, not skill.
- **Agents differ by persona, not by adapting per turn.** The Degen accumulates every
  round; the Whale round-trips. Good contrast between fighters, little learning within one.

**Next**
- Reactivity heartbeat + on-chain scheduled duels
- Parallel concurrent duels instead of one bout at a time
- Somnia Data Streams for the live feed, replacing hand-rolled log backfill
