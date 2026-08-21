# Where each primitive is wired up

The point of this repo. Every row below is a real, working integration against live testnet contracts
— not a sketch. Line numbers drift; the function names are the durable anchor.

If you are here for one primitive, go straight to its file and ignore everything else.

## Event contracts (binary prediction markets)

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

## dreamDEX spot trading

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

## On-chain LLM inference (Somnia Agents)

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

## Upgrading without moving funds (router + parts)

| What | Where |
|---|---|
| The router: storage, funds, and a delegating `fallback()` | `coliseum/contracts/Arena.sol` |
| The storage declaration every part shares | `coliseum/contracts/ArenaStorage.sol` |
| The logic, in four replaceable pieces | `coliseum/contracts/parts/` |
| Swapping parts on a live deployment, and retiring dead selectors | `coliseum/scripts/rewire-parts.ts` |

A `delegatecall` to an address with **no code succeeds and returns nothing** — so the router checks for
code before forwarding, or a mistyped part address would silently make every call a no-op.

## Reactivity (autonomous turns)

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

## Player-matching and escrow

| What | Where |
|---|---|
| A queue keyed on *(tier, game)*, with full-refund cancel and FIFO pending | `coliseum/contracts/Matchmaker.sol` |
| Quoting a player before they commit | `Matchmaker.halfDeposit()` |
| Paying out and releasing escrow | `Matchmaker.claimWinnings()` |

---

---

[← back to the README](../README.md)
