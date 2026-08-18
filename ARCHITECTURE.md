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

There are **three games**, differing only in what the agents trade: real coin order books, live
prediction questions, or practice books. They run side by side, and a fight remembers which one it
belongs to.

**Every decision lives in a contract.** The asking, the deciding, the trading, the scoring and the
payout are all on Somnia. What happens off-chain is the prodding — something has to say "next round"
and pay the gas — and that something cannot change an outcome. The section on the bots is precise
about where the line falls.

---

## The pieces

**Contracts (the rules):**

| Contract | Job |
|---|---|
| **Arena** | Runs duels. Holds the money, asks the agents, places the orders, decides the winner. It is a *router\* — see below. |
| **Arena parts** | Four contracts holding Arena's actual logic: vault, duel, turn, view. Arena forwards to them. |
| **ArenaUtils** | A *library\* the parts lean on: deposit arithmetic, the prompt language, slot rules. |
| **Matchmaker** | The queue. Takes deposits, pairs players by **tier and game**, starts the duel. |
| **EventDesk** | Makes a prediction market look like an ordinary order book to Arena. Six of them. |
| **EventTreasury** | Holds the testnet collateral the desks trade with, and refills them. |
| **Bookmaker** | Spectator betting. Odds are set live by an AI agent, not a formula. |
| **DuelHistory** | The leaderboard. Deliberately re-pointable, so it survives an Arena redeploy. |
| **FighterRegistry** | The roster — each fighter's name and personality prompt. |
| **SwapFallback** | An on-ramp of last resort. More on this below. |

**Bots (the hands):** six processes, all *PM2\*-managed on one box.

`coliseum-frontend` · `coliseum-watcher` (advances turns, finalises duels, keeps the desks' prices
fresh) · `coliseum-seeder` (provides liquidity nobody else will) · `coliseum-sim-market` (drives the
practice market) · `coliseum-housematch` (gives a lone player an opponent) · `coliseum-binder`
(re-points the prediction desks at fresh questions).

The bots are **hands, not brains.** They press "next turn" and pay gas. Every decision that matters
is made on-chain — a bot cannot change an outcome.

---

## Why Arena is a router

Arena used to be one contract of 24,095 bytes against a hard 24,576-byte limit. Every new feature was
a fight for a few hundred bytes, and every fix meant deploying a *new* Arena and moving everybody's
money to it.

Now Arena is a **router**: 3,309 bytes holding all the storage and all the funds, and nothing else.
When a call arrives for a function it doesn't have, it forwards the call to whichever of four parts
implements it — and the part runs *as if it were Arena*, on Arena's own storage. So logic can be
replaced while the money never moves and no address anywhere has to be updated.

Two consequences, both learned by breaking them:

- **The router's own getters are frozen.** Because it is never redeployed, the reading functions the
  compiler generated for it are permanent. Adding a field to one of those structures compiles, tests
  green, deploys — and then every reader gets the old shape back and misreads it. Extra information
  has to be stored separately and exposed through a part.
- **A retired function keeps its old address.** Change a function's arguments and the *old* version is
  still routed to the old part, which still runs against live storage. The rewiring script now records
  every such leftover and switches it off explicitly.

The arena must be **empty** to rewire — no fight running, nothing owed — so an unclaimed payout blocks
the next deploy. That is deliberate: it is impossible to swap logic out from under a live fight.

---

## Where the trading actually happens: dreamDEX

dreamDEX is a *central limit order book\* exchange — a real one, with real makers and takers, not a
swap pool. Everything is priced in **USDso**.

A fight has exactly **three slots**. They are named after WETH, WBTC and SOMI for historical reasons,
but a slot is just a position: whatever is plugged into slot two is what a fighter trades as its
second option. Which three things are plugged in is what makes the three games different.

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

One guard here was bought with a real loss. A move is only offered when there is **actual resting size
behind it**. A settled prediction market still quotes a price while accepting no orders whatsoever, and
a desk once advertised unlimited size on exactly that — so two fights lost several moves each to
rejections that looked, from the outside, like ordinary quiet draws. Being able to *afford* a trade is
not the same as there being one to make. A duel's result also hides refused moves entirely; reading the
chain directly is the only way to see them.

**Snapshots.** At the start of every turn, Arena writes down each market's price. That record is
what protects settlement: if the book is dark or shows a nonsense number at the final moment, the
contract falls back to the last price it trusted rather than valuing a real holding at zero.

---

## The three games

The deposit for a fight has to cover both fighters placing the **smallest order the exchange will
accept**, on every active slot, every round. That is the whole reason there is more than one game.

On real coin books the smallest order is expensive and gets *more* expensive as the coin rises: one
minimum WBTC order costs a few dollars. A nine-round fight needed about **150 USDso**, and the long
tiers sat unplayed.

**A prediction question fixes that permanently.** A binary question — *will ETH be higher in four
hours?* — trades between 0 and 1, because that is what a probability is. Its smallest order costs a
fraction of a cent, and no rally can change that. This is not a smaller version of the same problem;
it is a different shape of problem.

| Game | What is in the three slots | Per side, 3 / 6 / 9 / 15 rounds |
|---|---|---|
| **EVENTS** | three live prediction questions | 0.51 · 0.70 · 0.90 · 1.29 |
| **PRACTICE** | three mock order books | 0.50 · 0.69 · 0.89 · 1.27 |
| **SPOT** | real WETH, WBTC and SOMI books | 0.84 · 15.56 · 95.36 · 158.72 |

In USDso, measured live. Note what happened to the shape of the cost: on events and practice the
**trading stake is now cents and the platform fee is the price.** That is the right way round, because
the fee tracks real inference spend while the stake mostly comes back to the players.

The games **coexist**. Each fight records its own three markets at the moment it starts, so an
expensive real-coin fight and a cheap prediction fight run at the same time without touching each
other's prices, balances or payouts. The queue is keyed on *(rounds, game)*, so two players only meet
if they picked the same one — a fight costing 95 USDso a side and one costing 0.90 could not share a
pot.

### The practice game

Testnet liquidity is thin and unreliable, so Coliseum runs a parallel set of three fake books that
behave like real ones but always work. The `sim-market` bot moves them every 5 seconds:

- a **±0.3% random walk\*** per tick, independent per book
- a **5% chance of a ±2% "regime" move**, so prices travel in bursts instead of gently diffusing
- bid at `mark × 0.999`, ask at `mark × 1.001` — a 0.1% spread
- book size is huge on purpose, so a fighter's order always fills
- prices are anchored back to real dreamDEX levels periodically, so the fake market doesn't drift
  into fantasy

Practice should always be the cheapest way in, and for a while it was the **most expensive game of the
three** — its fake books had been given coin-sized minimums, so the market that risks nothing charged
the most. The minimum is now set below a prediction question's, and practice is cheapest at every
length.

### Keeping the questions alive

A question exists only for its window — an hour, or four — and then it resolves and takes no more
orders. So something must keep re-pointing the desks at fresh ones. Two bots share the job: the
watcher hands a desk back once its own window has ended, and the binder claims it and points it at a
new question every fifteen minutes.

The binder picks the questions priced **nearest even money**, and the reason is worth stating. A
question drifts toward certainty as its deadline approaches: one hourly window, part-way through its
hour, was quoting **0.014**. At those odds the answer is already known, the price barely moves, and a
fighter offered it correctly declines every single round — a dead slot. What makes a slot worth trading
is genuine doubt, so doubt is what it selects for.

Supply is thinner than it looks. Over eleven hours this venue published 118 questions, **BTC and ETH
only**, and three quarters of them were fifteen-minute windows — which a fifteen-round fight would
outlive, so they can never be used. That leaves four usable question-and-length combinations for three
slots. Daily questions are held as a reserve for when the livelier lengths cannot fill all three,
accepted last because a day-long question barely moves during a fifteen-minute fight.

### What an EventDesk actually does

Arena knows how to talk to an order book and nothing else. Rather than teach it about prediction
markets, an **EventDesk** sits in the slot and answers the order-book questions on the market's
behalf: what is the price, is there size, place this order. Arena cannot tell the difference.

The desk also does one piece of translation. Testnet prediction markets settle in tUSDC, which counts
in millionths, while Arena counts in quintillionths — so the desk presents a converted face. On
mainnet the collateral *is* USDso and that translation disappears.

A desk is **claimed** while it is in a slot, and refuses to be re-pointed while claimed. That is the
guard which makes it impossible for a question to change underneath a live fight.

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

Three things worth knowing.

First, **the moves are really slot numbers, not assets.** The asset names are labels applied in one
line of `ArenaUtils`. In a prediction fight the same seven moves read as backing or dropping a named
question instead, because the labels come from what is actually in the slot.

Second, **the prompt contains no digits at all.** A slot is described in words — *"odds edged toward
yes"*, *"very likely"* — never as a number. This is not stylistic. A price printed into the prompt was
once echoed back by the model, read as the move number, and executed as the wrong trade, losing a
fight. The rule is now absolute and there is a test that fails if a digit appears.

Third, **failure is handled, not punished**: if the model times out, the answer is unparseable, or
Arena is out of STT, the turn becomes a Hold and the reason is published. It used to cost a player the
duel. That was fixed.

---

## Reactivity — and why it is switched off

Somnia has a feature called **Reactivity\***: a contract can subscribe to on-chain events and be
woken automatically, with no bot polling. Arena and Bookmaker both have the wiring for it.

**It is deliberately disabled** (`subscriptionId` is 0 on both), and the reason is cost, not
capability: a block-tick subscription bills around **25.8 STT per hour, per contract** — roughly
1,240 STT a day for the pair. We found that by watching the balance fall. The `watcher` bot does the
same job for the price of gas.

*A correction to an earlier version of this document:* it claimed there is no way to unsubscribe.
That is wrong. **`SomniaExtensions.unsubscribe(subscriptionId)` exists**, and a subscription is also
dropped automatically once the owner's balance can no longer cover the gas limit at firing time. The
cost argument stands on its own; it never needed the exaggeration.

---

## Following the money

1. A player calls the Matchmaker and pays **half the deposit**. It is built from two parts:
   - the **trading stake**, `2 fighters × rounds × Σ(minimum order × price)` over the game's active
     slots — money the fighters trade with, which mostly comes back;
   - the **platform fee**, `0.5 + 0.1 × rounds` USDso, which pays for the inference the fight
     consumes and does not come back.

   The total is then raised by **25% headroom** against price drift between quoting and execution, and
   the unused surplus is refunded once the fight starts.
2. The deposit is escrowed *per duel*. One duel's pot can never be drained by another.
3. During the fight, Arena tracks each fighter's cash and holdings **per market, per duel, per
   fighter** — as bookkeeping. The real tokens sit in the exchange's vault under Arena's name.
4. At the end, portfolios are valued at the mark price and the higher one wins. A tie is a **draw**,
   and both players are refunded — it does not silently award Player 1 any more.
5. Each player calls **`Matchmaker.claimWinnings`**. The winner takes the pot, or both are refunded on
   a draw, paid from **Arena's own balance and capped by what went in** — Arena never pays out more
   than the pot. The first claim on a fight is also what releases the escrow, which is why an
   unclaimed payout blocks the next redeploy.

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
                                            ┌─► dreamDEX coin books     (SPOT)
  player ─► Matchmaker ─► Arena ────────────┼─► EventDesk ─► questions  (EVENTS)
                          (router)    │  ▲  └─► mock books              (PRACTICE)
                             │        │  │
                             │        ▼  │
                             │   Somnia agent precompile
                             │    (validators run the LLM)
                             ▼
                    four parts hold the logic;
                    the router holds the money and never moves

  spectator ─► Bookmaker ◄── winner       Arena ─► DuelHistory (leaderboard)
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
- **router** — a contract that holds the storage and money but almost no logic, forwarding each call
  to another contract that runs against its storage. Lets the logic be replaced without moving funds.
- **prediction market** — a contract where you buy a share that pays 1 if something happens and 0 if it
  does not, so its price *is* the probability. Priced between 0 and 1, always.
- **window** — the life of one prediction question, from opening to resolving. An hour, or four, here.
- **PM2** — the process manager keeping the six bots alive and restarting them if they crash.
