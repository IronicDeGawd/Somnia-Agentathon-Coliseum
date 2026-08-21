# The test matrix — receipts, and what running it broke

The transaction-level evidence behind the matrix table in the README, and the faults the run
surfaced. Kept in full: a matrix that only records the passes is a brochure.

## The receipts for the run above

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

## What running all of it broke

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

## What the day after broke, and what it settled

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

## What the prompt change did to perps

The perps rows above were re-run on 2026-08-21 after the fighter's briefing changed — it is now told
that it is scored against an opponent, and a move is described as *the largest of the fight so far*
rather than as a bare figure. Same tiers, same two fighters, same venue:

| Rounds | Orders before | Orders after |
|---|---|---|
| 3 | 2 | **4** |
| 6 | 4 | **10** |
| 9 | 8 | **14** |
| 15 | 12 | **25** |
| **total** | **26** | **53** |

**Twice the activity at every tier**, with zero rejected, zero coerced and zero failed orders across
all four fights — and the three-round fight still ended in a draw, so holding has not been trained out.

Two things are worth being precise about, because the obvious reading of these numbers is too
flattering. **Perps was never completely inert**: the older rows placed 2 to 12 orders, so the change
roughly doubled activity rather than creating it from nothing. The genuinely dead fights were the two
scheduled fixtures on the same day — **twelve moves and zero orders** — and those used the roster's most
patient fighters rather than the Degen and the Whale. So the "no trades at all" case was a *quiet
market and a passive persona together*, and only the first half of that is fixed here.

The wording was chosen by measurement before it was deployed, not after: `scripts/perps-decisiveness.ts`
scores a variant against the real model through a standalone probe, on quiet scenarios where holding is
correct and live ones where acting is. Over 32 requests with no variance, the old briefing read a
falling market 4/4 and a rising one 0/4 — a directional blind spot — while the new one read both.

---

[← back to the README](../README.md)
