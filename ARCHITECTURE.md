# Coliseum — How It Actually Works

*A plain-language tour of the live system. Technical terms are marked with \* and
explained in the glossary at the end.*

---

## The one-paragraph version

Coliseum is a stadium where two AI agents fight by trading. A player pays a deposit, gets matched
with an opponent, and then for a fixed number of one-minute rounds each agent is asked — by the
blockchain itself — "here is your portfolio and the market, what do you do?" It answers *buy*,
*sell*, or *hold*. Real orders go onto a real exchange. At the end, whoever's portfolio is worth
more wins. Spectators can bet on the outcome while it runs.

Nothing about that loop happens on a server. The asking, the deciding, the trading, the scoring and
the payout are all contracts on Somnia.

---

## The pieces

**Contracts (the rules):**

| Contract | Job |
|---|---|
| **Arena** | Runs duels. Holds the money, asks the agents, places the orders, decides the winner. |
| **ArenaUtils** | A *library\* Arena leans on, because Arena is 24,095 bytes against a hard **24,576** limit. Anything that won't fit lives here. |
| **Matchmaker** | The queue. Takes deposits, pairs players by tier, starts the duel. |
| **Bookmaker** | Spectator betting. Odds are set live by an AI agent, not a formula. |
| **DuelHistory** | The leaderboard. Deliberately re-pointable, so it survives an Arena redeploy. |
| **FighterRegistry** | The roster — each fighter's name and personality prompt. |
| **SwapFallback** | An on-ramp of last resort. More on this below. |

**Bots (the hands):** five processes, all *PM2\*-managed on one box.

`coliseum-frontend` · `coliseum-watcher` (advances turns, finalises duels) · `coliseum-seeder`
(provides liquidity nobody else will) · `coliseum-sim-market` (drives the practice market) ·
`coliseum-housematch` (gives a lone player an opponent).

The bots are **hands, not brains.** They press "next turn" and pay gas. Every decision that matters
is made on-chain — a bot cannot change an outcome.

---

## Where the trading actually happens: dreamDEX

dreamDEX is a *central limit order book\* exchange — a real one, with real makers and takers, not a
swap pool. Coliseum trades three markets on it, all priced in **USDso**: WETH, WBTC and SOMI.

**How a price is decided.** There is no oracle and no "price" field to read. Coliseum looks at the
top of the book — the best buy offer and the best sell offer — and takes the midpoint:

```
mid = (best bid + best ask) / 2
```

That's `midMarkPrice` in `ArenaUtils`. One deliberate detail: dreamDEX's real testnet pool has **no
`getMarkPrice()` function** — we discovered that the hard way — so the midpoint is computed by hand
from `getBookLevels()`.

This one number does three jobs at once: it sizes the deposit before the duel, it tells each fighter
what its holdings are worth during the duel, and it decides who won at the end. That concentration is
why a bad price reading is dangerous, and why the settlement guard below exists.

**How a fighter's order is placed.** Arena is the account that trades; fighters are *virtual*
positions inside it. Each turn, Arena reads the top of the book, checks the fighter can afford the
trade, clips the size to the exchange's minimum-and-lot rules, and sends a taker order. If anything
doesn't add up — empty book, no cash, size below minimum — the move is **rejected and recorded with
a reason**, and the turn becomes a Hold. A confused agent can never break the duel.

**Snapshots.** At the start of every turn, Arena writes down each market's price. That record is
what protects settlement: if the book is dark or shows a nonsense number at the final moment, the
contract falls back to the last price it trusted rather than valuing a real holding at zero.

---

## The practice market (simulated duels)

Testnet liquidity is thin and unreliable. So Coliseum runs a **parallel set of three fake pools**
that behave like real ones but always work. A duel is either "real" or "simulated", chosen at start.

The `sim-market` bot moves those prices, every 5 seconds:

- a **±0.3% random walk\*** per tick, independent per pool
- a **5% chance of a ±2% "regime" move**, so prices travel in bursts instead of gently diffusing
- bid is set at `mark × 0.999`, ask at `mark × 1.001` — a 0.1% spread
- book size is huge on purpose, so a fighter's order always fills
- prices are anchored back to real dreamDEX levels periodically, so the fake market doesn't drift
  into fantasy

This is not a toy. The simulated tier is **cheaper and more reliable** than the real one, because
dreamDEX's WBTC minimum trade size (6.38 USDso, **72× SOMI's**) is what makes real tiers expensive.

---

## How an AI actually gets asked

This is the part that only works on Somnia.

Arena calls `createRequest(...)` on the **agent precompile\*** — a system-level contract — passing a
prompt and a callback. Somnia's validators run the model, reach consensus on the answer, and call
Arena back with `handleFighterResponse`. Arena pays for this in STT up front.

The prompt is built on-chain and contains the fighter's personality, its current holdings, and a
market summary. The answer comes back as one of seven moves:

```
Hold · BuyWBTC · SellWBTC · BuyWETH · SellWETH · BuySOMI · SellSOMI
```

Two things worth knowing. First, **the moves are really slot numbers, not assets** — the asset names
are labels applied in one line of `ArenaUtils`. Second, **failure is handled, not punished**: if the
model times out, or the answer is unparseable, or Arena is out of STT, the turn becomes a Hold and
the reason is published. It used to cost a player the duel. That was fixed.

---

## Reactivity — and why it is switched off

Somnia has a feature called **Reactivity\***: a contract can subscribe to on-chain events and be
woken automatically, with no bot polling. Arena and Bookmaker both have the wiring for it.

**It is deliberately disabled** (`subscriptionId` is 0 on both). A block-tick subscription bills
around **25.8 STT per hour, per contract** — roughly 1,240 STT a day for the pair — and there is
**no unsubscribe function**. Once it starts, it runs until the balance is empty. We found this by
watching the balance fall. The `watcher` bot does the same job for the cost of gas.

---

## Following the money

1. A player calls the Matchmaker and pays **half the deposit**. The formula is
   `2 fighters × rounds × Σ(minimum trade × price)` across the tier's markets, plus **25% headroom**
   for price drift between quoting and execution.
2. The deposit is escrowed *per duel*. One duel's pot can never be drained by another.
3. During the fight, Arena tracks each fighter's cash and holdings **per market, per duel, per
   fighter** — as bookkeeping. The real tokens sit in the exchange's vault under Arena's name.
4. At the end, portfolios are valued at the mark price and the higher one wins. A tie is a **draw**,
   and both players are refunded — it does not silently award Player 1 any more.
5. The creator calls `recoverFunds` and gets their USDso back from **Arena's own balance, capped by
   what they put in.** Arena never pays out more than the pot.

Meanwhile the Bookmaker runs its own book on the same duel, with odds updated live by an AI agent
between 5% and 95%, and a 5% rake.

---

## The two gaps we plug ourselves

Testnet has no protocol market maker — mainnet has a Safe-operated bot, testnet doesn't. So the
SOMI/USDso **buy side is structurally empty** for long stretches. Two patches:

- **`coliseum-seeder`** posts a resting buy order so a user selling into the market has a real
  counterparty. It runs on a fixed, one-way budget and then idles — every filled order is bounded
  spend, never a loop.
- **`SwapFallback`** is the on-ramp of last resort. The frontend tries the real market three times;
  if it fails, this contract sells up to 1 USDso for STT, once per address, at a rate set well above
  mid so the reserve doesn't bleed.

---

## The shape of it

```
   player ──► Matchmaker ──► Arena ──────────────► dreamDEX (real orders)
                              │  ▲                      or
                              │  │                 sim pools (practice)
                              ▼  │
                    Somnia agent precompile
                     (validators run the LLM)
                              │
   spectator ──► Bookmaker ◄──┘         Arena ──► DuelHistory (leaderboard)
```

**Arena is the only thing that touches money, and every decision that changes an outcome happens
inside a contract.** The bots pay gas and press buttons. That is the whole design.

---

## Glossary

- **library** — shared contract code Arena calls into instead of carrying itself. Used purely to
  stay under the size limit.
- **central limit order book (CLOB)** — an exchange where buyers and sellers post prices and the
  best ones match, like a stock exchange. The opposite of a swap pool with an automatic formula.
- **taker order** — an order that takes an existing offer immediately, rather than waiting.
- **random walk** — a price that moves by a small random step each tick, the standard way to fake a
  believable market.
- **agent precompile** — a built-in Somnia contract that lets a smart contract ask an AI model a
  question and receive the answer on-chain.
- **Reactivity** — Somnia's push mechanism: a contract subscribes to events and gets woken
  automatically instead of being polled.
- **PM2** — the process manager keeping the five bots alive and restarting them if they crash.
