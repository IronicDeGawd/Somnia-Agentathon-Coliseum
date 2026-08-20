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
token" address holds **no code**: it is a sentinel meaning native STT.

Three things about this venue cost a day between them, and all three are load-bearing:

- **The typed interface in this repo is a reconstruction, not the source of truth.** An identical
  order — same nine arguments, same values — was refused through a typed `placeOrder` call and filled
  through a raw `abi.encodeWithSignature`, with every other parameter eliminated one at a time. The
  order paths now use the raw encode. It is also the only way to carry value, which is what makes a
  native-base sale possible at all.
- **Approve a margin above the notional, never the exact notional.** An order approved for exactly
  `price × quantity` was refused; the same order approved generously filled. The venue reserves at the
  limit price and rounds in its own favour. Approvals are returned to zero straight after, so a margin
  costs nothing and being exact costs the whole order.
- **It reports its own gas requirement rather than failing quietly.** A short-of-gas order reverts
  carrying `2,862,641` in its returndata. Only 63/64ths is forwarded per nesting level, so a caller
  must supply well above that: the same order was refused at a four-million limit and filled at
  twelve. Anything wrapping this in a `try/catch` must check `gasleft()` first, or it converts a gas
  problem into a phantom "venue refusal" — and because the outer call still succeeds, gas estimation
  then reproduces the failure on every retry.

**Selling native is supported now.** It was refused for months, and the reason was never that it
could not be done: the only STT the Arena held was the same STT that pays for the fighters' reasoning,
so a busy trading day could quietly stop them thinking. `FuelPot` gave that balance an income, so the
coupling is bounded, and `ArenaUtils.FUEL_RESERVE` keeps the two uses apart — above the line the coin
is inventory, at or below it, it is fuel and no sale is offered.

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

### Player-matching and escrow

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

Spot is offered at 9 and 15 rounds only. A three-round spot fight activates a single market, so both
fighters face the identical one choice every turn and it converges to a tie — which is precisely what
duel #1 did. Events and perps keep their three-round tiers, because they get three questions and three
markets there. The single-market tier survives as a **test fixture**, and forcing it is how the
native-STT sale was finally exercised end to end.

## Where the money goes

Worth reading before the code, because the *shape* of this was wrong for three months and nothing
noticed.

**One pot, not two.** A buy used to be charged to a deposit lodged with the venue, while the asset
bought was delivered to the Arena's own balance — payer and receiver being different addresses, with
nothing moving value back. So the deposit only ever fell, and when it could no longer cover the
smallest order the venue accepts, every buy was refused with the money in plain sight. Measured across
one fifteen-round fight: the deposits fell **515.80 → 466.29 USDso**. The deposits are retired
now — `fundPools` is no longer part of operating the game — and buying power is one balance that both
pays and receives.

That fault was invisible for months for a reason worth remembering: spot fighters barely traded, so
almost nothing walked down the path. Four orders across three whole fights. Once they started trading,
one fight placed forty-eight.

**Assets convert back at the end of every fight.** Each buy still turns cash into an asset, so
`_resolveDuel` sells the house's holdings back — after the result is stored, because a fighter is
scored on cash *plus* holdings at the mark and selling first would change who won.

**The entry fee pays for the fighters' thinking, and now actually can.** Players pay in USDso;
inference is billed in native STT; nothing converted between them, so the fee — priced at six to
eleven times what thinking costs — sat unusable while an operator's wallet topped the Arena up by
hand. `FuelPot` closes that: the fee is routed to it at duel creation, and `refuel()` buys STT on the
SOMI book and tops the Arena up. `refuel()` is **permissionless**, because a pot only its owner can
fill runs dry at three in the morning — so a spend cap, a price ceiling, and an act-only-below-floor
band are what stop it being used to make the house buy badly.

The failure mode it removes was silent, which is the point. When STT ran low the Arena did not stop:
it marked the turn taken, recorded a failure, and moved on. The fight finished with nobody trading and
the scoreboard showed a draw rather than a fault — the same disguise the spot bug wore.

| | measured |
|---|---|
| inference cost | ~0.243 STT per round |
| entry fee against it | **6–11× cover**, every tier |
| one fight's proof | fee 1.40 USDso in, 1.29 of STT bought, operator wallet untouched |

**The fee is not withdrawable.** It is the cost of operation, so no path pays it out as profit.
`migrateSurplus` exists for upgrades only and is capped at the balance above escrowed stakes — because
deleting the only exit strands house money, and 4.23 USDso already sits in a superseded Arena for
exactly that reason.

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
- **The offer gate and the executor ask one function** — they used to ask the same question in two
  places and drifted apart, so a fighter was offered a buy every turn and refused it every turn.
- **Buying power excludes escrowed stakes** — starting a duel pulls both players' deposits into the
  Arena's own balance, so anything spending that balance subtracts `escrowedPot` first. A test that
  fails when the subtraction is removed is what caught this before it shipped.
- **A fuel reserve the fighters cannot trade away** — above it, native STT is inventory; at or below
  it, it is what pays for thinking.
- **Settlement can never block a resolution** — every sale at fight end is wrapped, every refusal is
  an event, and it stops early on low gas. A fight that cannot finish is a payout nobody can claim,
  and an unclaimed payout blocks the next rewire.
- **Storage is only ever appended, after every mapping** — this is the layout of a router that is
  never redeployed, so a slot inserted anywhere else silently reinterprets every value after it.
- **Never swallow a failure you have not inspected** — three separate faults here reported success
  while an inner call had run out of gas, and each one taught the gas estimator to reproduce it.
  Report *why* separately: reverted, refused, and filled-but-nothing-arrived need different fixes.

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
| FuelPot (turns fees into STT) | `0x1e840a1267148b38d02135b36f1daa50ae329f4c` |
| Somnia Agents platform | `0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776` |

The Arena's part addresses and the six desks live in `coliseum/deployments/somnia.json`, which is
gitignored — the bots need it, or they referee a different Arena than the frontend serves.

Only the Arena's address is permanent: it is a router, so its logic is replaced underneath it without
moving storage or funds. Everything else moves when its code changes, which is why the Bookmaker has
had three addresses. Two are abandoned and should never be funded again — a subscription attached to a
contract keeps spending any balance you send it.

The SOMI book's "base token" is an address with **no code**. It is a sentinel for native STT, not a
token — a detail that costs an afternoon to rediscover.

`FuelPot` is replaceable and holds no player money, so its owner exit is uncapped and it has a
one-call `migrate` to a successor. That is safe *there* and would be theft in the Arena, whose balance
holds players' stakes — the distinction is what a contract holds, not who is asking.

## The test matrix — every tier, played on testnet

Every tier the lobby offers, on every market, run end to end on 2026-08-20. Each fight is real — a real
deposit, real orders on real markets, a real settled result and a page you can open — and each was
started **from the site**, by a browser carrying its own wallet, then settled and claimed. All of them
ran **The Degen** against **The Whale**.

Twelve fights, not fourteen. Two tiers were retired between runs: a three-round spot fight activates a
single coin market, so both fighters face one identical choice every turn and the fight converges to a
tie, and a fifteen-round practice fight was never offered in the first place. Asking for either now just
makes the lobby click time out.

| Duel | Market | Rounds | Orders | Result | Markets traded |
|---|---|---|---|---|---|
| [64](https://coliseum.somniaforge.com/duel/64/result) | Events | 3 | 4 | **The Whale** | BTCUP BTCLATER ETHUP |
| [66](https://coliseum.somniaforge.com/duel/66/result) | Events | 6 | 5 | **The Whale** | BTCUP BTCLATER ETHUP |
| [68](https://coliseum.somniaforge.com/duel/68/result) | Events | 9 | 7 | **The Degen** | BTCUP BTCLATER ETHUP |
| [70](https://coliseum.somniaforge.com/duel/70/result) | Events | 15 | 6 | **The Whale** | BTCUP BTCLATER ETHUP |
| [65](https://coliseum.somniaforge.com/duel/65/result) | Perps | 3 | 2 | **The Whale** | ETH SOL ADA |
| [67](https://coliseum.somniaforge.com/duel/67/result) | Perps | 6 | 4 | **The Whale** | ADA XRP BNB |
| [69](https://coliseum.somniaforge.com/duel/69/result) | Perps | 9 | 8 | **The Degen** | BNB ETH SOL |
| [71](https://coliseum.somniaforge.com/duel/71/result) | Perps | 15 | 12 | **The Whale** | SOL ADA XRP |
| [73](https://coliseum.somniaforge.com/duel/73/result) | Spot | 9 | 18 | **The Degen** | WETH WBTC SOMI |
| [75](https://coliseum.somniaforge.com/duel/75/result) | Spot | 15 | 29 | **The Degen** | WETH WBTC SOMI |
| [72](https://coliseum.somniaforge.com/duel/72/result) | Practice | 6 | 10 | **The Degen** | SIMPOOLWETH SIMPOOLWBTC SIMPOOLSOMI |
| [74](https://coliseum.somniaforge.com/duel/74/result) | Practice | 9 | 16 | **The Whale** | SIMPOOLWETH SIMPOOLWBTC SIMPOOLSOMI |

Every fight settled. Nothing was refused, nothing was coerced, nothing failed.

Every one was started from the site by a browser carrying its own wallet, driven by the chain's own
scheduler, then settled and claimed. The arena ended empty with nothing escrowed.

### What the matrix shows

**Order counts, by market, across the four tiers:**

| | 3r | 6r | 9r | 15r | total |
|---|---|---|---|---|---|
| Spot | — | — | 18 | 29 | **47** |
| Perps | 2 | 4 | 8 | 12 | **26** |
| Practice | — | 10 | 16 | — | **26** |
| Events | 4 | 5 | 7 | 6 | **22** |

**Spot is now the busiest market on the board.** A fifteen-round spot fight trades twenty-nine times
with nothing refused. Three runs ago the entire spot market managed four orders across three fights,
every one of them a single SOMI buy, every sell refused because a sale was never authorised to the
venue. That fault, the two behind it, and the fee/fuel currency mismatch found after them are the whole
difference.

**Perps roughly doubled between runs, 14 orders to 26.** A perp is a standing exposure — once a fighter
is long it stays long for free, and only needs an order to change its mind — so this market will always
count lower than one where holding a view costs an order. Twelve orders in a fifteen-round fight is
about as active as this market gets.

**Events fell, 38 orders to 22, and that is the one number in this table pointing at a problem.** The
shape is wrong, not just the size: the nine-round fight traded seven times and the fifteen-round fight
only six, so the market stops scaling with length exactly where every other market keeps going. All four
fights also drew the same three questions (BTCUP, BTCLATER, ETHUP), which is the tell — the desks have
been parked on one set of questions since a stuck reservation flag stopped them being rotated, so by the
time a fight reaches them there is little left to disagree about. Not yet diagnosed further; it is
recorded as open rather than dressed up.

**Money now comes back.** The house float ended the twelve fights within three hundredths of a
USDso of where it started, against a measured fifty-USDso drain per fight before the settlement path
existed. Two spot fights converted their leftover holdings back to stablecoin at the final bell (20.82
and 34.55 USDso); every other skip was a pool with no real asset to sell, or the chain's own coin, which
is fuel rather than inventory. Thinking cost 36 coin across the twelve, paid out of routed fees rather
than an operator wallet.

**Three settlements were deferred for gas**, which is the guard doing its job rather than failing: it
checks there is room to finish before it starts, and steps aside when a block is nearly full. The
holdings it left behind are still the house's and still recoverable; nothing was lost.

### The receipts for the run above

Nothing in the table is asserted from a log. These are the on-chain figures, and the commands that read
them back, so any of it can be rechecked against the chain rather than taken on trust.

**Settlement at the final bell** — the house's leftover holdings sold back to stablecoin:

| Duel | Sold | Proceeds | Block |
|---|---|---|---|
| 73 | 0.009 WETH | 20.82105 USDso | 466671635 |
| 75 | 0.015 WETH | 34.5549 USDso | 466681074 |

Fifteen more assets were skipped, each with its reason recorded on chain: nine were pools with no real
asset to sell (the practice simulator, and the event desks, which hold a position rather than a token),
three were the chain's own coin — fuel, not inventory — and three stepped aside because the block did
not have gas left to finish safely.

**The two balances that matter, before the first fight and after the twelfth:**

| | Before | After | Change |
|---|---|---|---|
| Arena stablecoin (the house float) | 617.201 | 617.175 | **−0.026** |
| Arena native coin (the thinking fuel) | 79.07 | 42.67 | −36.40 |
| Escrowed player stakes | 0 | 0 | 0 |

The float is the headline: twelve fights, 121 orders, and the house ended where it began. The fuel spend
works out at 0.197 coin per round against a fee that collects 0.8–2.0 stablecoin per fight, which is why
the fee pot still holds 74.9 stablecoin and never needed to convert any of it during the run.

**Reproduce it:**

```bash
WALLET_FILE=<four-wallet json> bash coliseum/scripts/run-matrix.sh   # the whole run, unattended
DUELS=64,65,66,67,68,69,70,71,72,73,74,75 MD=1 \
  pnpm exec hardhat run scripts/matrix-summary.ts --network somnia   # the table above
SPAN=70000 pnpm exec hardhat run scripts/check-settlement.ts --network somnia
DUEL=<id> pnpm exec hardhat run scripts/check-rejections.ts --network somnia
pnpm exec hardhat run scripts/check-arena-vaults.ts --network somnia
```

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

All three are fixed and every gate has a test that fails when the gate is removed. The proof is the
spot rows in the table above — forty-eight orders across three fights with nothing refused, against
four before — and the first spot sell that has ever gone through
([duel 38](https://coliseum.somniaforge.com/duel/38/result), `SellWETH 0.004 @ 1910.21`).

**One thing this exposed is still open.** A buy is paid out of the money deposited with the pool, but
the asset it buys is delivered to the Arena's own balance, and a sale's proceeds land there too — so
that deposit only ever drains. Measured across three spot fights it fell 35 USDso and never rose,
which is roughly forty more fights before buying is refused again. The fix is to let the venue bill the
Arena directly, which is what it already does for sells; that is written and tested but not yet live.

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

### What the day after broke, and what it settled

The matrix opened the spot market. Trading it properly then exposed the rest of the money path, and
four faults came out of it — every one of them reporting success while doing nothing.

**A widened rule applied in one place and not the other.** Buying power was taught to count the
Arena's own balance, but the check that runs immediately before the order still looked only at the
deposit. A fighter was offered a buy every turn and refused it every turn — fourteen refusals in
[duel 56](https://coliseum.somniaforge.com/duel/56/result), all reading `vault below min cost`. Both
places now call one function, so they cannot drift again.

**Three faults that were the same fault.** A rescue order, a fuel purchase, and a probe script all
reported success while an inner call had run out of gas:

- the perps rescue ran out inside a price lookup that normally costs ~25,000 units and that day cost
  960,000; a bare `catch` absorbed it and called it a venue refusal. The fingerprint was in plain
  sight — three attempts consuming **96.4%, 99.3% and 98.9%** of everything they were given.
- the fuel purchase hit the same wall, except the venue *told us*: `2,862,641`, in returndata nothing
  was reading.
- a probe script printed each receipt's status without checking it, so the process exited zero after
  an on-chain revert.

And in all three, because the outer call succeeded, gas estimation learned the wrong lesson and
starved every retry. **A swallowed failure is not a quiet failure — it is an invisible one that
teaches the machinery to reproduce it.**

**Settlement that no real venue would have accepted.** A new contract's sell-everything call offered
the raw balance as the order size, with no rounding to the venue's trading step, and passed a full
test suite — because the mock has no matching engine and accepts any size at all. Green tests,
non-functional feature.

**And the buy-only market is buy-only no longer.** Selling native STT was refused since May, and the
objection was real: the only STT the Arena held was the STT that paid for thinking. Once fees funded
that balance the objection dissolved, and a fighter sold on
[duel 63](https://coliseum.somniaforge.com/duel/63/result) — the first time in the project's life.
Reaching it took forcing the single-market tier, because three attempts to cover it from a mock all
passed whether the code was right or wrong, and one still passed with the fuel reserve deleted. They
were deleted rather than kept. **A test that passes with the fix removed is worse than no test**: it
claims coverage it does not have, and that happened four times in one day.

## Where to read next

- `ARCHITECTURE.md` — plain-language tour of how the whole thing actually works, jargon explained
- `context/structure.md` — what lives where, before reaching for grep
- `context/progress.md` — current status, known issues, lessons
- `context/research/` — dreamDEX, Somnia Agents and Reactivity reference docs

## License

MIT.

---

**Built for Somnia Agentathon · May 2026 · powered by Somnia Agents + dreamDEX.**
