# Lifting a piece out, and the guards worth copying

Which parts of this stand alone, what each one needs to work elsewhere, and the checks that
exist because something specific went wrong without them.

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

- **Test a prompt where it costs nothing.** `ArenaUtils` is a linked library, so changing one string
  means redeploying four parts and re-pointing the router — refused unless the arena is empty. So
  wording is scored against the real on-chain model through a standalone probe with no Arena involved
  (`scripts/perps-decisiveness.ts`), on two scenario families: quiet moves where holding is correct,
  and one large move where acting is. A prompt has to separate the two; a variant that always trades
  is not brave, it is paying the spread on noise. Measured over 32 requests with no variance, this
  found something reading the code could not — the old perps wording had a **directional blind spot**,
  shorting a falling market 4/4 and never once buying a rising one.
- **A successful transaction is not a successful request.** The probe catches a reverting
  `createRequest` and emits an event, so the outer call succeeds either way. The first version of that
  harness logged "sent" for eight refusals and then reported a measured verdict on wording that had
  never been tested. Read the failure event, and never let "no data" render as a result.
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
- **A log window shorter than what it covers reads as "nothing happened"** — and this chain's nodes
  answer an over-wide range with an *empty result* rather than an error, so silence and absence are
  indistinguishable. Measured on the margin desk: 5,000 blocks returned nothing while 1,000 returned
  260. Every scanner here states its window and says out loud when it found nothing. This one cost
  three wrong conclusions in a single day before the rule was written down — and the same class of
  blank answer, from a mistyped getter name, once came one step from authorising a router rewire on a
  reverted call.

---

[← back to the README](../README.md)
