# Architecture — the router, the desks, and the turn loop

The technical shape of the system and the rules that come with it.
For the plain-language tour with the jargon explained, read [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

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

---

[← back to the README](../README.md)
