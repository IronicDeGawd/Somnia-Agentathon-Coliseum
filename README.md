# Coliseum — a worked example of Somnia's primitives

> **Two prompts. One arena. Real trades. Live.**
>
> An agent-vs-agent trading arena on Somnia, built as a **reference implementation**: on-chain LLM
> inference, dreamDEX spot books, dreamDEX **event contracts** (binary prediction markets), and an
> upgradeable contract that never moves its address — each wired up and running against live testnet.

**Live: [coliseum.somniaforge.com](https://coliseum.somniaforge.com)** · Somnia testnet (chain 50312)

**This is a demo to read and copy from, not a product to sign up for.** The game exists to give the
integrations something real to do. If you are here for one primitive, the map below is the whole point
of this README — go straight to the file, ignore the rest.

Built for the **Somnia Agentathon** (May 2026).

---

## Where each primitive is wired up

Every row is a real, working integration against live testnet contracts — not a sketch. Line numbers
drift; the function names are the durable anchor.

### Event contracts (binary prediction markets)

| What | Where |
|---|---|
| The whole adapter — makes a prediction market look like an order book | `coliseum/contracts/EventDesk.sol` |
| Attach to a market: read its outcome-token ids, retreat from the previous one first | `EventDesk.bind()` |
| Place an order, **clamping expiry to the market's own deadline** | `EventDesk.placeOrder()` |
| Quote a price and size, including the settled case | `EventDesk.getBookLevels()`, `_resolvedPrice18()` |
| Collect a won position | `EventDesk.redeemSettled()` |
| Remember the last real price, because makers stop quoting before a window ends | `EventDesk.poke()` |
| **Find live markets** — the only place a market id is ever published | `coliseum/scripts/bind-event-window.ts` → `scanWindows()` |
| Choose which questions to trade, and keep them fresh on a schedule | same file, `pickWindow` notes |
| Collateral plumbing (testnet faucet → desks) | `coliseum/contracts/EventTreasury.sol` |

Two things here cost real money to learn. An order outliving its market **reverts**, so the desk
substitutes the market's deadline rather than passing yours through. And a **settled** market still
quotes a price while accepting no orders at all — so size, not price, is what tells you a trade is
possible.

### dreamDEX spot trading

| What | Where |
|---|---|
| Placing a fill-or-kill taker order, with every failure recorded | `coliseum/contracts/parts/ArenaTurnPart.sol` → `_placeOrderForFighter()` |
| Deciding a move is even possible (cash, minimum size, **real resting size**) | `coliseum/contracts/lib/ArenaUtils.sol` → `tradability()`, `_hasSize()` |
| Pricing with no oracle: midpoint of the top of the book | `ArenaUtils.midMarkPrice()` |
| Reading pool minimums and lot rules, and caching them | `ArenaStorage._cachePoolMeta()` |
| The interface we actually needed | `coliseum/contracts/interfaces/ISpotPool.sol` |
| Buying native STT on the SOMI book | `coliseum/scripts/buy-stt.ts` |

The real pool has **no `getMarkPrice()`** — compute the midpoint yourself. And the SOMI book's "base
token" address holds **no code**: it is a sentinel meaning native STT, and orders against it need a
raised gas limit or they revert on a payout check. `buy-stt.ts` has both details in working form.

### On-chain LLM inference (Somnia Agents)

| What | Where |
|---|---|
| Paying for and submitting a request, with a callback selector | `ArenaTurnPart.sol` → `_requestFighterMove()` (`platform.createRequest`) |
| Receiving the answer and acting on it | `ArenaTurnPart.handleFighterResponse()` |
| Building the prompt **on-chain** | `ArenaUtils.sol` → `holdingLine()`, `actionName()`, `previewTurnPrompt()` |
| Never letting a model failure decide the game | same file — timeout, unparseable and out-of-funds all become Hold |
| The interface | `coliseum/contracts/interfaces/ISomniaAgents.sol` |

**Keep every digit out of the prompt.** A price printed into a prompt was echoed back by the model,
read as the move number, and executed as the wrong trade. Slots are described in words —
*"odds edged toward yes"* — and a test fails if a digit appears.

### Upgrading without moving funds (router + parts)

| What | Where |
|---|---|
| The router: storage, funds, and a delegating `fallback()` | `coliseum/contracts/Arena.sol` |
| The storage declaration every part shares | `coliseum/contracts/ArenaStorage.sol` |
| The logic, in four replaceable pieces | `coliseum/contracts/parts/` |
| Swapping parts on a live deployment, and retiring dead selectors | `coliseum/scripts/rewire-parts.ts` |

A `delegatecall` to an address with **no code succeeds and returns nothing** — so the router checks for
code before forwarding, or a mistyped part address would silently make every call a no-op.

### Reactivity (autonomous turns)

| What | Where |
|---|---|
| One subscription aimed at the next deadline, re-aimed and cancelled | `ArenaStorage._nextTurnBlock()`, `_scheduleNextTick()`, `_cancelTick()` |
| The subscribe payload — the one field that decides the whole cost | `ArenaStorage._subscribeReactivity(uint64 targetBlock)` |
| The handler, and the four places that re-arm | `ArenaTurnPart.onEvent()` / `turn()`, `ArenaDuelPart.startDuel()` / `_resolveDuel()` |
| Owner switches — on, off, and reading the state | `ArenaVaultPart.resubscribe()` / `disableReactivity()`, `ArenaViewPart.reactivityStatus()` |
| The same shape on a standalone contract, its own cadence | `coliseum/contracts/Bookmaker.sol` |
| The watchdog behind it | `coliseum/scripts/watcher-bot.ts` (`REACTIVITY_GRACE_BLOCKS`) |
| Measuring both cost profiles yourself | `coliseum/scripts/probe-reactivity-oneshot.ts`, `probe-reactivity-unsubscribe.ts` |
| Tests, including what a local node cannot show you | `coliseum/test/Arena.reactivity.t.ts` |
| Verified API notes | `context/research/somnia-reactivity.md` |

**Read this before copying anyone's Reactivity code, including ours.** `BlockTick` has two completely
different cost profiles depending on **one field**, and we shipped the expensive one for months:

| `eventTopics[1]` | Fires | Cost |
|---|---|---|
| `bytes32(0)` | **every block** — ~10.5×/second | **~31 STT/hour**, running or idle |
| a block number | **once, at that block** | **~0.047 STT per turn**, and **nothing while idle** |

Measured live across three fights on the deployment: nine turns, every one executed on the exact block
requested, zero blocks late, then cancelled on resolution — followed by ~1,100 idle blocks with no
spend at all. The 0.047 is a whole turn (price snapshots, two inference requests, and booking the next
firing); a bare probe with an empty handler comes in at 0.0045.

Cancelling works, which is what makes an idle arena free: `SomniaExtensions.unsubscribe(subscriptionId)`
stops a live subscription dead. It is documented but was missing from the published interface — see
`coliseum/contracts/interfaces/ISomniaReactivityPrecompile.sol`.

**What one-shot firing gives up is self-healing.** An every-block subscription that misses a wake-up
retries 100 ms later; a one-shot chain has each firing book the next, so a firing that never lands ends
the chain silently. Three consequences worth copying:

- **Keep a watchdog.** The keeper here rings a turn that is overdue past a grace period — and re-arms
  when it does. Tested by cutting the chain mid-fight: the keeper picked the missed turn up 158 blocks
  after it came due, and the chain resumed exactly one interval later when switched back on.
- **Re-aim, never blindly cancel.** Every hook calls the same "what is due soonest" function and lets
  it decide whether the answer is *cancel*. The Bookmaker originally cancelled outright on settlement,
  so a keeper catching up on a finished fight killed the tick for the fight actually running.
- **A subscription's id is your only handle on it.** Overwrite it with zero on a failed subscribe — as
  the old Bookmaker did — and you have an orphan firing forever that nothing can cancel. The only cure
  was starving it of gas. Never abandon a deployment with a native balance still in it.

### Player-matching and escrow### Player-matching and escrow

| What | Where |
|---|---|
| A queue keyed on *(tier, game)*, with full-refund cancel and FIFO pending | `coliseum/contracts/Matchmaker.sol` |
| Quoting a player before they commit | `Matchmaker.halfDeposit()` |
| Paying out and releasing escrow | `Matchmaker.claimWinnings()` |

---

## What the demo does

The game is the harness. It exists so the integrations above have something real to exercise — a
contract that must actually price a book, actually ask a model, actually place an order that can
actually fail. Everything below is context for reading the code.

A duel is real on-chain trading between two AI personalities. Each round, every fighter's brain — a
Somnia LLM agent — is shown its portfolio and what the market did, and answers with one move: hold,
or buy or sell one of three markets. The Arena contract places that order for real. After 3, 6, 9 or
15 rounds the fighter whose portfolio is worth more wins, and the loser's stake pays the winner.

Players do not start duels directly. They **join a queue**, get matched with whoever is waiting on
the same line, and the fight begins on its own.

## Three games, not one

A fight's deposit has to cover both fighters placing the smallest possible order on every active
market, every round. On real coin books that is brutal: one minimum WBTC order costs a few dollars,
so a nine-round fight needed about **150 USDso** and the long tiers sat unplayed.

A **prediction question** fixes this. Its price is a probability between 0 and 1, so its smallest
order costs a fraction of a cent and — unlike a coin — that can never grow with the asset's price.

So there are three markets, and they coexist rather than replace each other. Every fight records its
own three markets when it starts, so they run side by side without touching each other.

| Market | What a fighter trades | Per side, 3 / 6 / 9 / 15 rounds |
|---|---|---|
| **EVENTS** | three live prediction questions | 0.51 · 0.70 · 0.90 · 1.29 |
| **PRACTICE** | mock order books, no real risk | 0.50 · 0.69 · 0.89 · 1.27 |
| **SPOT** | real dreamDEX coin books | 0.84 · 15.56 · 95.36 · 158.72 |

Measured live 2026-08-18, in USDso. The deposit is
`(trading stake + platform fee) × 1.25`, split between the two players, where the fee is
`0.5 + 0.1 × rounds` and the 25% is refundable headroom against price drift. On events and practice
the **stake is now cents and the fee is the price** — which is the right shape, since the fee tracks
real inference spend while the stake mostly comes back.

Both real markets are offered at once. Nine waiting lines: events at every length, spot at 3/9/15,
practice at 6/9. Two players match only if they picked the same line — a spot fight and an events
fight cost wildly different amounts and could not share a pot.

## How a duel works

1. **Both players call `Matchmaker.queue(fighter, turns, marketKind)`**, each approving their half of
   the deposit. The first to arrive waits; the second's arrival starts the fight. Nobody waiting
   alone is stuck — cancelling refunds in full, and a house bot fills empty lines.
2. **The Arena binds that fight's three markets** and funds both fighters from the pot. Which slots
   are active depends on the game: spot narrows for short fights (a smallest BTC order costs dollars),
   events trades all three at every length.
3. **Each round** the Arena asks both brains for a move and places a fill-or-kill order for the one
   it chose. A move is only offered when there is **real resting size** behind it, so a fighter can
   never be handed a trade that cannot happen.
4. **`finalizeDuel(duelId)`** values each portfolio in USDso from mark prices snapshotted during the
   fight, and stores the winner on-chain.
5. **`Matchmaker.claimWinnings(duelId)`** pays the winner, or refunds both on a draw. The same call
   releases the escrow.

Fighters are never shown a digit. A price echoed back by a model was once read as a move number and
executed as the wrong trade, so a slot is described in words — *"odds edged toward yes"*, *"very
likely"* — and never as a number.

## Fighter personalities

Six prompts in `FighterRegistry.sol`:

| # | Name | Tagline |
|---|------|---------|
| 0 | The Degen | Send it. Always. |
| 1 | The Whale | Size matters. Move markets. |
| 2 | The Quant | Mean reversion or nothing. |
| 3 | The Diamond Hand | Never sell. Buy the dip. |
| 4 | The Scalper | 1% × 1000 = victory. |
| 5 | The Contrarian | Whatever they're doing, do opposite. |

## Architecture

**The Arena is a router plus parts.** One address holds all storage and all funds; a `fallback()`
delegates each function to whichever part implements it. Logic is replaced without moving money or
re-pointing anything — which is why the Arena address in the table below is permanent.

Two rules that come with that, both learned the hard way:

- **The router's own getters are frozen.** It is never redeployed, so its compiled getter for any
  public struct is permanent. Adding a field to such a struct breaks every reader. Append a mapping
  and expose it through a part instead.
- **A changed signature leaves its old selector routed at retired code** that still runs against live
  storage. `scripts/rewire-parts.ts` records and retires unclaimed selectors for this reason.

**An `EventDesk` makes a prediction market look like an ordinary pool** to the Arena — same
interface, so nothing above it knows the difference. It also translates 6-decimal testnet collateral
into the 18-decimal face the Arena expects; on mainnet the collateral *is* USDso and the shim
disappears.

**Turns are driven by Reactivity; the bots do everything around them.** Each fight books a single
wake-up at the block its next round is due, re-books as each is spent, and cancels when the fight ends,
so an idle arena costs nothing. The earlier every-block subscription billed ~31 STT/hour regardless and
was switched off for months — the fix was one field, not a different architecture. Five processes under
PM2 handle the rest: a watcher (referee, funder, and the watchdog behind Reactivity), a binder (keeps
prediction questions fresh), a house opponent, a pool seeder and a mock-market injector.

**Prediction questions expire, so something has to rewind them.** A question lives for its window —
an hour, or four. The watcher hands a desk back when its window ends, and the binder re-points it at
a fresh question every fifteen minutes, choosing the ones priced nearest even money because a
question at 0.95 has effectively already answered itself and makes a dead slot. Measured over eleven
hours, this venue publishes BTC and ETH only, and three quarters of what it makes are fifteen-minute
questions no long fight can outlive — so daily questions are held as a reserve for when the livelier
lengths cannot fill three slots.

## Repo layout

```
somniaforge-agentathon/
├── coliseum/
│   ├── contracts/
│   │   ├── Arena.sol               # the router: storage, setPart, delegating fallback
│   │   ├── ArenaStorage.sol        # THE storage declaration — append only, never reorder
│   │   ├── parts/                  # ArenaVaultPart · ArenaDuelPart · ArenaTurnPart · ArenaViewPart
│   │   ├── Matchmaker.sol          # the player queue, keyed on (tier, market)
│   │   ├── EventDesk.sol           # makes a prediction market look like a pool
│   │   ├── EventTreasury.sol       # holds testnet collateral, funds the desks
│   │   ├── Bookmaker.sol           # spectator betting
│   │   ├── DuelHistory.sol         # leaderboard; re-pointable so it survives redeploys
│   │   ├── FighterRegistry.sol     # the six fighter prompts
│   │   └── lib/                    # ArenaTypes (structs, MarketKind) · ArenaUtils (deposits, prompts)
│   ├── scripts/                    # deploy, operate, and drive fights — see context/structure.md
│   ├── test/                       # 199 passing Hardhat tests
│   ├── frontend/                   # Next.js 15 + wagmi + RainbowKit
│   └── deployments/somnia.json     # live addresses (gitignored)
├── sandbox/                        # early primitive validation — kept for reference, not built on
├── ARCHITECTURE.md                 # plain-language tour of the system
└── context/                        # plans, research, progress (gitignored)
```

## Quick start

```bash
pnpm install
cd coliseum && pnpm exec hardhat test              # 199 passing

# Put two throwaway players through the real queue. One wallet per player —
# transactions from one address are ordered, so a shared wallet serialises
# parallel fights. Keys go to the scratchpad, never the repo.
WALLET_FILE=/tmp/players.json pnpm exec hardhat run scripts/make-test-wallets.ts --network somnia
PAIR=0 TURNS=9 MARKET=2 WALLET_FILE=/tmp/players.json \
  pnpm exec hardhat run scripts/queue-pair.ts --network somnia

# Read a fight's real tape — every move, order AND refusal
FROM_DUEL=8 pnpm exec hardhat run scripts/duel-tape.ts --network somnia

# Collect payouts. Also how the arena is emptied before replacing parts
WALLET_FILE=/tmp/players.json pnpm exec hardhat run scripts/claim-all.ts --network somnia
```

Operating the prediction market:

```bash
pnpm exec hardhat run scripts/bind-event-window.ts --network somnia   # FORCE=1 to rebind healthy slots
pnpm exec hardhat run scripts/tune-sim-lots.ts --network somnia       # reprice a practice lot
pnpm exec hardhat run scripts/rewire-parts.ts --network somnia        # refuses unless the arena is empty
```

A duel's *result* hides refused moves. `duel-tape.ts` is the only way to see them — one fight looked
like an ordinary draw with three of five moves silently rejected.

## Stack

| Layer | Component |
|---|---|
| Execution venue | **dreamDEX** — SOMI / WBTC / WETH spot books and binary prediction markets, quoted in USDso |
| Agent brain | **Somnia Agents** — LLM inference with validator consensus |
| Turn loop | **Somnia Reactivity** — one `BlockTick` booked per round, cancelled when idle; PM2 watcher as watchdog |
| Settlement | On-chain, atomic, fill-or-kill |
| Frontend | Next.js 15 + Tailwind v4 + wagmi + RainbowKit |

**Testnet only.** Event collateral is testnet tUSDC rather than USDso, and `EventTreasury` exists
purely to refill it from a faucet — neither is part of a mainnet deployment.

## Lifting a piece out

**The event-contract adapter is the most reusable part.** `EventDesk.sol` depends on nothing in
Coliseum except the order-book interface it implements, so anything that already trades a spot book can
trade prediction markets by pointing at a desk instead of a pool. To reuse it you need: the market
factory's `MarketCreated` logs (`scanWindows` in `bind-event-window.ts` — the market id appears nowhere
else, and without it a won position can never be claimed), a collateral source, and something on a
schedule to re-point desks as windows expire.

Two things in that path are worth copying carefully, because both were wrong here first:

- **Pin the log query to the venue's address, and check the collateral it names.** A query with only an
  event shape matches that event from *any* contract on the chain. Somnia testnet has run one
  prediction venue so far, so nothing broke — but with two, the best-scoring window can belong to
  someone else, and a desk bound to it adopts *that* market's collateral, which your treasury does not
  hold. The result is a slot registered on a question that can never be traded, invisible until a
  fight's tape shows moves that never reached a market.
- **Derive the decimal scaling from the market, never from a constant.** The pool reports its own
  collateral unit (`oneCollateral`), and `EventDesk` now computes its factor from that at bind time. It
  was `1e12` hardcoded — correct for 6-decimal testnet collateral and wrong by a factor of a trillion
  the moment the collateral is 18-decimal, with nothing anywhere to notice.

**The router pattern is the second.** `Arena.sol` plus `ArenaStorage.sol` is about 3.3 KB of
diamond-lite: no libraries, no loupe, one storage layout shared by every part. Enough for "I need to fix
this contract without migrating its funds", and small enough to read in one sitting.

**What is Coliseum-specific and not worth copying:** the fighter personalities, the tier ladder, the
betting market, and `EventTreasury` — which exists only because testnet collateral comes from a faucet.

## Guards worth copying

Each of these was bought with a real failure, not added defensively.

- **Per-duel `recoverFunds`** — one duel's creator cannot drain another's funds.
- **CEI ordering on recovery** — the recovered flag flips before any external call.
- **`sweepToken(USDso, …)` blocked** — an owner can never take player deposits. This is load-bearing:
  a superseded deployment still holds 4.23 USDso of settlement surplus that was deliberately left
  stranded rather than weaken the guard to retrieve it.
- **A trade needs real resting size** — a settled prediction market still quotes a price but accepts
  no orders. It once advertised unlimited size and silently swallowed moves; affording a trade is not
  the same as there being one to make.
- **Mark price snapshots** — emergency finalize reads prices stored each round, so the call cannot be
  timed to a favourable book.
- **On-chain winner** — the Bookmaker reads the winner from the Arena, never from a caller argument.
- **No digits in a prompt** — a number in the prompt was echoed back and executed as a move.
- **Desks are claimed, not shared** — a desk refuses to be re-pointed while claimed, so a question
  cannot move under a live fight.

## Key addresses (Somnia testnet, chain 50312)

| Contract | Address |
|---|---|
| Arena (router — permanent) | `0x301d9364BDb2fd76E33c13eBE8FCc956BAcfbeD6` |
| Matchmaker | `0x6b7e255a3420c7846a15e963589ffd5504773b0a` |
| Bookmaker | `0x73d0a884f563c454ca0d05bd09b0643c0204b755` |
| DuelHistory | `0x11ac9b65b05dfb1406618bda649b410b8e8f7108` |
| FighterRegistry | `0xefe3dd01c59b435bb688135f19db364ef09e90df` |
| EventTreasury (+ 6 desks) | `0x47dab39e8a6c1e9e8c367576ae225904fc85fbff` |
| USDso (quote token) | `0x9c32F3827A1a99f0cf9B213de8b53eC3d57bb171` |
| tUSDC (event collateral) | `0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E` |
| dreamDEX SOMI/USDso | `0x259fD6559214dd5aD3752322426eA9F9fABEFff4` |
| dreamDEX WBTC/USDso | `0x3605f28aA7C50e7441211e77Cb0762d49539326C` |
| dreamDEX WETH/USDso | `0xD180195da5459C7a0DEA188ed61216ec43682b50` |
| Somnia Agents platform | `0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776` |

The Arena's part addresses and the six desks live in `coliseum/deployments/somnia.json`, which is
gitignored — the bots need it, or they referee a different Arena than the frontend serves.

Only the Arena's address is permanent: it is a router, so its logic is replaced underneath it without
moving storage or funds. Everything else moves when its code changes, which is why the Bookmaker has
had three addresses. Two are abandoned and should never be funded again — a subscription attached to a
contract keeps spending any balance you send it.

The SOMI book's "base token" is an address with **no code**. It is a sentinel for native STT, not a
token — a detail that costs an afternoon to rediscover.

## The test matrix — every tier, played on testnet

Every tier the lobby offers, on every market, run end to end on 2026-08-19. Each fight is real — a real
deposit, real orders on real markets, a real settled result and a page you can open — and each was
started **from the site**, by a browser carrying its own wallet, then settled and claimed. All of them
ran **The Degen** against **The Whale**.

> **The spot rows below are the OLD numbers, and they are kept deliberately.** Running this matrix is
> what exposed why they were so low, and the three faults behind them are now fixed. Rerun on the fixed
> contracts, a nine-round spot fight placed **16 orders across 18 moves with nothing refused**
> ([duel 38](https://coliseum.somniaforge.com/duel/38/result)) — against four orders across the three
> spot fights below combined. See *What running all of it broke*.

| Duel | Market | Rounds | Orders | Result | Markets traded |
|---|---|---|---|---|---|
| [22](https://coliseum.somniaforge.com/duel/22/result) | Events | 3 | 3 | **The Whale** | ETHUP BTCUP ETHLATER |
| [26](https://coliseum.somniaforge.com/duel/26/result) | Events | 6 | 6 | **The Whale** | ETHUP BTCUP ETHLATER |
| [27](https://coliseum.somniaforge.com/duel/27/result) | Events | 9 | 9 | **The Whale** | ETHUP BTCUP ETHLATER |
| [32](https://coliseum.somniaforge.com/duel/32/result) | Events | 15 | 10 | **The Degen** | ETHUP BTCUP ETHLATER |
| [24](https://coliseum.somniaforge.com/duel/24/result) | Perps | 3 | 0 | draw | BNB ETH SOL |
| [23](https://coliseum.somniaforge.com/duel/23/result) | Perps | 6 | 3 | **The Whale** | XRP BNB ETH |
| [31](https://coliseum.somniaforge.com/duel/31/result) | Perps | 9 | 6 | **The Whale** | ETH SOL ADA |
| [35](https://coliseum.somniaforge.com/duel/35/result) | Perps | 15 | 7 | **The Whale** | BNB BTC ETH |
| [25](https://coliseum.somniaforge.com/duel/25/result) | Spot | 3 | 2 | draw | SOMI |
| [28](https://coliseum.somniaforge.com/duel/28/result) | Spot | 9 | 0 | draw | SOMI WETH WBTC |
| [33](https://coliseum.somniaforge.com/duel/33/result) | Spot | 15 | 2 | **The Degen** | SOMI WETH WBTC |
| [29](https://coliseum.somniaforge.com/duel/29/result) | Practice | 6 | 3 | **The Whale** | mock books |
| [30](https://coliseum.somniaforge.com/duel/30/result) | Practice | 9 | 0 | draw | mock books |
| [34](https://coliseum.somniaforge.com/duel/34/result) | Practice | 15 | 0 | draw | mock books |

One row is marked rather than quietly counted: duel 31 was started by the operator, because at the
time the site could not start a nine-round perps fight — the queue asked to be given 29,200,558 gas
and was capped well below it. The cap is fixed and duel 35 proves it, having been started from the
browser at the tier above; that transaction went on to use 6,431,596 of the 40,000,000 it was given.

Money reconciled to the wei afterwards: the perps float returned 149.41 of 150, every fighter account
free, nothing quarantined, escrow zero, and every payout claimed.

### What the matrix shows

**Perps is where a fight is decided cheaply.** A fifteen-round spot fight takes **319.79 USDso** of
deposit between the two players; the same fight on perps takes **47.50**. That gap is the whole reason
the market exists — a position is posted against, not bought outright.

**Bitcoin only appears at the top tiers**, and duel 35 is the first fight it ever traded in
(`ORDER BTC buy 0.001 @ 64,589.2 → LongBTC`). Which three of the six perp markets a fight gets is
computed when it starts, from what its budget can post margin for at that moment — so no two perps rows
above show the same three, and Bitcoin moved from the fifteen-round tier into the nine-round tier by
itself during the run as its margin requirement fell from 12.05 to 10.90.

**Spot barely trades.** Four orders across three fights, all of them one SOMI, against twenty-eight on
events and twenty-six on perps. It is not a wiring fault — at turn ten of duel 33 the fighter was
offered `BuyWBTC, BuyWETH, BuySOMI` and held anyway. A real coin book moves a few basis points in a
sixty-second turn, so every slot reads "flat" to a fighter, and "you hold no WETH" is not on its own a
reason to buy. Practice escapes it because its price injector actually moves prices; events escapes it
because a probability is bounded and its relative moves are huge — eleven of twelve measured per-turn
steps crossed the same band, several by thousands of basis points.

Perps had the identical problem and was fixed before this matrix ran: described in words alone, its
fighters held every single round. Perps slots now carry the numbers a trader decides on — the level,
the level last turn, the level at the open, the position and what it is worth.

### What running all of it broke

**The largest one first: the spot market could never sell, and running this matrix is what revealed
it.** With the old wording fighters held nearly every turn, so the failure had no way to show itself.
Once they started trading, every sell came back refused.

A dreamDEX pool takes the money for a buy out of what was deposited to it, but it hands the asset it
bought to the buyer's own wallet — not into any deposit. Selling is the reverse: the venue reaches into
that wallet and takes the asset back out. It was never given permission to. So every sell reverted, on
every market, for the whole life of the project. Measured on
[duel 36](https://coliseum.somniaforge.com/duel/36/result): one fighter tried to sell on nine
consecutive turns and was refused nine times, while the Arena's own balance held the asset the whole
while and the permission stood at zero.

Two more faults were sitting in the same place. The list of moves a fighter is offered checked what the
fighter was owed and whether the market had anything to trade against, but never whether the Arena
could actually deliver — so fighters were offered buys the venue could not fund and sells nothing
backed, and lost a turn to each. And the SOMI market's asset turns out to be the chain's own coin
rather than a token, which has to be handed over differently again; those sells could never have
worked at all, and it is no longer offered.

All three are fixed and every gate has a test that fails when the gate is removed. The proof is
[duel 38](https://coliseum.somniaforge.com/duel/38/result): a nine-round spot fight, 18 moves, **16
orders, none refused**, including the first spot sell that has ever gone through.

The settlement rules came from [somnia-primitives](https://github.com/IronicDeGawd/somnia-primitives),
which is the only written source we found that states plainly where the money moves from and to.

Four more faults that only appear under load, all found by this matrix and all fixed:

- **The queue gas floor was too low, twice.** Queueing costs a few hundred thousand gas when the line
  is empty and millions when it is not, because the second player's transaction starts the fight. The
  floor was 5,000,000 and a six-round events start needs 5,223,101 — the player lost their gas and the
  site showed a failed queue with nothing explaining it. Twelve million then covered every tier except
  perps at nine and fifteen rounds, which asked for **29,200,558**.

  That last number is worth separating from the others, because it is not what a perps start costs.
  It is what the network's gas *estimator* asked to be given, and the two differ here by a factor of
  four and a half: the fight it was quoted for went on to use 6,431,596. The gap is structural rather
  than a mistake. Choosing the three markets involves a chain of nested calls, and the innermost one
  needs about 1.8 million gas to be AVAILABLE at its depth — not spent, available. A caller may only
  pass on 63/64ths of what it holds, so meeting that floor several levels down requires a starting
  limit far above anything the transaction will actually consume. The estimator finds the lowest limit
  that works, and that is the number it reports. It also moves on its own, since which markets qualify
  depends on what margin they demand at that moment. The fix is a generous floor rather than a clever
  one: unused gas is refunded, so 40,000,000 costs nothing and stops the estimate's wandering from
  ever reaching a player.
- **A reactive firing advanced every active duel under a 15,000,000 gas cap.** A turn measured
  7,477,821 gas one hour and 29,382,823 the next — the variable part is the inference platform's, not
  ours. A firing that runs out of gas books no successor, so the chain ends silently: five concurrent
  fights stalled for fifteen thousand blocks with nothing reporting it. A firing now takes one turn and
  re-arms.
- **The keeper could not recover it.** It will not drive turns while the arena is below its fuel floor,
  and it tops the arena up from the deployer, which will not go below its own. Both were low at once.
- **Leaving a queue was capped at 200,000 gas** against a 1,144,175 estimate, so a player who could not
  cancel could not recover their deposit until somebody happened to match them.

## Where to read next

- `ARCHITECTURE.md` — plain-language tour of how the whole thing actually works, jargon explained
- `context/structure.md` — what lives where, before reaching for grep
- `context/progress.md` — current status, known issues, lessons
- `context/research/` — dreamDEX, Somnia Agents and Reactivity reference docs

## License

MIT.

---

**Built for Somnia Agentathon · May 2026 · powered by Somnia Agents + dreamDEX.**
