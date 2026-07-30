# Coliseum — 30-Minute Demo Script

> Read-aloud script with timings. Spoken lines are in quotes; everything else is an action.
> Verified against the live deployment on 2026-07-30.
>
> **Blanks marked `>>> FILL IN <<<` are personal facts I can't write for you.** Replace them
> with your real version — a rehearsed true story lands, an invented one falls apart under
> the first follow-up question.

---

## Before you start (do this 5 minutes early)

- [ ] Open `https://coliseum.somniaforge.com/` and hard-refresh
- [ ] Connect the wallet holding **10 USDso + 220 STT** (`0x1E6C…a745`)
- [ ] Second tab: Somnia explorer, ready to paste a tx hash
- [ ] Third tab: `/fighters`
- [ ] SSH terminal ready (only if you want to show the keeper's view)
- [ ] Confirm the arena is idle — lobby should read "ARENA IS DARK"

**The one timing rule that matters:** a turn cannot land faster than **56 seconds**
(600 blocks at 0.094s), so a 6-round duel takes about **7 minutes**. You queue at minute 5
and it resolves around minute 12, while you keep talking. Never start a duel and then wait
in silence for it.

---

## Running order

| Time | Section |
|---|---|
| 0:00 | Open + where the idea came from |
| 3:00 | How one duel works |
| 5:00 | **Queue the duel** (runs in background) |
| 6:00 | Why this is different |
| 9:00 | Place a bet + watch agents trade |
| 12:00 | Somnia: what this is actually built on |
| 16:00 | Real dreamDEX, with receipts |
| 19:00 | Resolution + automatic payout |
| 22:00 | The rest of the surface |
| 25:00 | Economics, limits, what's next |
| 27:30 | Q&A |

---

## 0:00 – 3:00 · Open, and where this came from

> "This is Coliseum. Two AI trading agents fight over a real order book, and the crowd bets
> on who wins. The agents' decisions, the trades, the bets, the payouts — all on Somnia.
> Nothing is pre-recorded and I'll show you the transactions."

> "Second place out of about eight hundred builds in the Somnia Agentathon. Built solo."

**Where the idea came from** — the honest arc, with your details:

> "The thing that started this was >>> FILL IN: what you actually noticed. e.g. 'every
> "AI agent" crypto project I looked at was a server calling an API, with a wallet
> attached — the AI part was never on-chain, so you just had to trust it' <<<"

> "So the question I wanted to answer was: if the model actually runs on-chain, what's the
> most obvious thing to build with it? And the answer felt like — make two of them compete
> at something where being right is measurable. Trading is measurable. You don't need a
> judge; the portfolio value tells you who was right."

> ">>> FILL IN: why a colosseum / fighting frame specifically — the spectator angle, the
> six personas, whatever the actual spark was <<<"

> "It started life as 'AIDuel', which was accurate and boring. It became Coliseum when I
> realised the interesting part wasn't the duel — it was the crowd around it."

*Keep this to 90 seconds of talking. Show the landing page and scroll the roster while you say it.*

> "Six agents. The Degen goes all in. The Whale moves in size then takes profit. The Quant
> sits in cash unless the numbers justify a move. Those personalities are prompts stored
> on-chain, and I can retune them without redeploying anything."

---

## 3:00 – 5:00 · How one duel works

Go to `/duel`.

> "A duel is a queue. I pick an agent and a tier, and I put up half the pot. If nobody else
> is waiting, a house bot fills the other side, so a duel always starts."

> "Then every round, each agent gets asked one question on-chain: here's the market, here's
> what you're holding — buy, sell, or hold? That question goes to Somnia's on-chain LLM
> inference, the answer comes back as a number, and that number becomes an order on
> dreamDEX. I want to be precise about this bit: the agent's decision is a transaction, not
> an animation."

---

## 5:00 – 6:00 · Queue the duel (do it now)

Pick **The Degen**, tier **6 rounds**, market **Simulated**. Queue. Approve in wallet.

> "3.60 USDso escrowed from me. Watch — the house bot notices an unmatched slot and takes
> the other side."

Wait for the redirect (~15s).

> "Matched. Six rounds, two assets, resolves in about seven minutes. Let's use that time."

---

## 6:00 – 9:00 · Why this is different

Four contrasts. Pick the two or three that fit your room; don't recite all of them.

**1. The AI is not off-chain.**
> "Most 'AI agent' projects put the model on a server and the wallet on-chain. That means
> the interesting part — the decision — is the part you can't verify. Here the Arena
> contract itself calls Somnia's inference and pays for it in STT. The request and the
> response are both events. You can replay every decision this thing has ever made from
> chain data alone. I couldn't quietly swap the model out mid-demo even if I wanted to."

**2. The market is real, not a simulation of a market.**
> "The orders go to dreamDEX — Somnia's native order book. Not an AMM curve, not a mock.
> When an agent buys, it takes liquidity from a real resting bid, and when it can't fill,
> the order visibly fails. I'll show you a real fill later."

**3. It's a spectator product, not a trading product.**
> "I'm not selling you a bot that makes you money. The agents are the entertainment and
> the betting is the business. That's a different design target — it means volatility and
> legible drama matter more than returns, which is why the fighters have personalities at
> all."

**4. Failure is visible instead of hidden.**
> "When an agent makes an illegal move, the UI shows the failed move. Most demos would
> swallow that. I'd rather you see the thing actually running, including where it's rough —
> that's the difference between a demo and a video."

*If someone asks "so is this a game or a trading system?":*
> "It's a game whose scoreboard happens to be real PnL. That's the whole point — the score
> can't be faked."

---

## 9:00 – 12:00 · Bet live, and watch them trade

Find the betting panel on the duel page. Place **0.2 USDso** on one fighter.

> "While it runs, anyone watching can bet. This is parimutuel — no bookmaker on the other
> side. Winners split the losing pool, house takes five percent."

> "The line opened at even money automatically when the duel went live. And notice what I
> won't have to do at the end: nothing. Settlement is automatic. Until recently this needed
> a human to press a button — and if nobody did, winners simply didn't get paid. That's fixed."

> "The contract also blocks the two duelists from betting on their own fight. On-chain, not
> in the UI."

Point at rounds as they land (~1/minute).

> "Round one. The Degen bought WETH. The Whale did something different — and that difference
> is the whole game. Same market summary, same model, different persona."

If a failed move appears, **name it before anyone asks**:

> "That failed move — the agent tried to sell something it no longer held. The contract
> rejected the order, the duel carried on, the money was never at risk. It just loses that
> turn. Cause is that I was handing the model a 'sell' option it couldn't execute. Fix is
> written, ships with the next deploy."

---

## 12:00 – 16:00 · Somnia: what this is actually built on

This is the section to lean into for a Somnia audience. Four things, and why each one
mattered to a decision I made.

**On-chain LLM inference (Somnia Agents)**
> "This is the primitive the whole project exists to use. `inferNumber` gets called from
> inside the Arena with the market summary and the fighter's prompt, and it costs real STT
> — about 0.12 STT per decision, so roughly 1.4 STT for a six-round duel. The cost being
> real is what makes it honest: I can't spam decisions, and neither can anyone else."

**dreamDEX — a native, zero-fee CLOB**
> "Maker and taker fees read zero on all three pools I trade. For a turn-based game that
> matters enormously: if every move cost thirty basis points, the fight would be decided by
> fee drag instead of by the agents. A zero-fee order book is what makes a six-round duel
> meaningful at small size."

**Sub-second blocks**
> "I measured it this morning: 0.094 seconds a block. A turn-based, on-chain game needs
> that. My turn floor is 600 blocks, which is 56 seconds — on a 12-second-block chain that
> same design would be a two-hour duel. Nobody watches a two-hour duel."

**Reactivity — and why it's currently off**
> "Somnia can have contracts wake themselves up: BlockTick, EpochTick, on-chain scheduling.
> I built that handler — it's in the repo as `Ping.sol` — and I keep it deactivated,
> because an every-block subscription burns STT continuously whether or not a duel is
> running. So a keeper drives turns today. Moving that heartbeat on-chain is the headline
> next step, and it's a cost question, not a capability question."

**What building on it actually taught me** — say one of these, it reads as real experience:
> "Two things that only show up when you build against live infrastructure. USDso — the
> stablecoin here — is Frax-backed with heavy internal accounting, so an approval costs
> about 1.1 million gas instead of the 46 thousand a normal ERC-20 takes. Any hardcoded
> gas limit silently dies. And dreamDEX shipped a change to its funding model recently
> that I had to adapt to mid-week. That's the tax on building against real systems instead
> of mocks, and I'd pay it again — mocks don't teach you anything."

---

## 16:00 – 19:00 · Real dreamDEX, with receipts

Open `+ USDso` in the top bar. Enter **50 STT**. Swap.

> "This is not a faucet. It reads the dreamDEX book, simulates the order, and places a real
> taker order against live liquidity."

Paste the tx hash into the explorer tab.

> "There it is. Fifty STT in, about four and a quarter USDso out, filled against a real
> resting bid."

> "Duels run on that real book too — earlier today an agent placed three real orders that
> all filled at 0.0852. One honest limit: on the real market agents can currently only buy.
> dreamDEX changed its default funding model and it strands sell-side inventory in the
> contract's wallet. The fix is written and needs a redeploy. So today: simulated market for
> the fight, real market to prove the plumbing."

*(If MAX looks small — it's capped at 50 STT deliberately. The book advertises more depth
than the maker delivers, and an oversized order silently falls back to a 1 USDso reserve.)*

---

## 19:00 – 22:00 · Resolution and automatic payout

Duel should resolve here. Go to the result page — **let it finish loading before you talk
about the winner.**

> "Both portfolios valued at the mark price on the final round. Higher value takes the pot.
> Here's the margin — real dollar values, not points."

> "And my bet is already settled. Nobody clicked anything. The keeper saw the duel resolve,
> called settlement, winners got stake plus a share of the losing pool minus the rake."

If useful:
> "Earlier today: two bets of a tenth of a USDso on opposite sides. Winner received 0.195,
> rake 0.005. That's the whole economic loop closing."

---

## 22:00 – 25:00 · The rest of the surface

`/fighters`, then a fighter detail page.

> "Records, PnL, win rate per agent — read from the settled-duel ledger on-chain, not a
> database I control."

Landing page ledger / standings.

> "Every duel that's ever resolved on this deployment. Anyone can verify all of it; I don't
> have a privileged copy."

Optionally the terminal:

> "The keeper's view. It's deliberately small: drive the turn, open the line, settle the
> bets, keep the arena fuelled."

---

## 25:00 – 27:30 · Economics, limits, next

> "On money: the flat duel fee covers inference and gas, that's it. The business is the
> five percent rake on betting — which means a duel nobody watches roughly breaks even.
> The spectators are the product, not the fighters."

> "Three things next. Move the heartbeat on-chain with Reactivity. Run duels in parallel
> instead of one at a time. And move the live feed onto Somnia Data Streams instead of the
> log backfill I hand-rolled."

> "Two limits worth naming out loud. On an exact tie the left-hand fighter wins — that's
> position, not skill. And the agents differ strongly between personas but don't adapt much
> within a duel; the Degen buys every single round. Making them react to what the opponent
> is doing is the interesting unsolved problem."

---

## 27:30 – 30:00 · Q&A

- *"Is the AI really on-chain?"* — Yes. The Arena calls Somnia Agents inference from inside
  the contract and pays in STT; request and response are both events. Not my server calling
  an API.
- *"Could you rig a duel?"* — I own the prompts, so I could bias a persona. I can't pick a
  winner: portfolio value is computed from mark-price snapshots taken before any order, and
  the contract writes the result.
- *"Why not just run the model off-chain and post the result?"* — Then you're trusting me,
  and the project has no reason to exist. The on-chain call is the whole thesis.
- *"What if nobody bets?"* — Duel runs anyway, just near break-even.
- *"Why simulated prices?"* — Testnet SOMI is flat, so a real-market duel resolves in a
  near-tie with no story. Simulated prices track real marks and give the fight something to
  react to.
- *"How much does a duel cost?"* — ~1.4 STT of inference for six rounds plus gas, and about
  1.1 USDso of platform fee on a tier-6 duel.
- *"Is this profitable?"* — Not at this volume, and I wouldn't claim otherwise. The unit
  economics only work with spectators, which is the thing left to prove.
- *"Why Somnia and not an L2?"* — On-chain inference doesn't exist there, and 56-second
  turns would become hour-long ones. The design depends on both.

---

## If something goes wrong

| Problem | What to do |
|---|---|
| House doesn't match within ~30s | "The house bot waits fifteen seconds before filling a lonely slot" — keep talking, it will. |
| Duel looks stuck mid-round | A turn can't come faster than 56s. Fill with the Somnia section. |
| Result page shows no winner | Let it load — it deliberately refuses to name a winner until data is in. |
| Bet tx fails | Check the wallet holds USDso, not just STT. A first-ever USDso receipt needs extra gas. |
| Out of USDso | `+ USDso` in the top bar, 50 STT at a time. |
| Everything looks dark | Fall back to a resolved duel — `/duel/17/result` is a clean 6-round example. |
| Venue wifi dies | Avatars are fetched from DiceBear over the network — mention it rather than fighting it. |
