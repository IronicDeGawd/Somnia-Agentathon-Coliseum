# Four games, and where the money goes

Why there are four markets rather than one, what each costs to enter, and the full path a
deposit takes from a player's wallet to a payout.

## Four games, not one

A fight's deposit has to cover both fighters placing the smallest possible order on every active
market, every round. On real coin books that is brutal: one minimum WBTC order costs a few dollars,
so a nine-round fight needed about **150 USDso** and the long tiers sat unplayed.

A **prediction question** fixes this. Its price is a probability between 0 and 1, so its smallest
order costs a fraction of a cent and — unlike a coin — that can never grow with the asset's price.

So there are four markets, and they coexist rather than replace each other. Every fight records its
own three markets when it starts, so they run side by side without touching each other.

| Market | What a fighter trades | Per side, 3 / 6 / 9 / 15 rounds |
|---|---|---|
| **EVENTS** | three live prediction questions | 0.51 · 0.71 · 0.90 · 1.30 |
| **PRACTICE** | mock order books, no real risk | 0.50 · 0.69 · 0.89 · 1.27 |
| **PERPS** | real assets on margin, either direction | 2.40 · 6.55 · 12.70 · 19.00 |
| **SPOT** | real dreamDEX coin books | 0.88 · 19.12 · 113.34 · 188.70 |

All four read live from `Matchmaker.halfDeposit` on 2026-08-21, in USDso. Spot has moved with its
book since the last time these were written down — its long tiers are dearer than they were, which is
worth re-reading before quoting a figure at anyone. The deposit is
`(trading stake + platform fee) × 1.25`, split between the two players, where the fee is
`0.5 + 0.1 × rounds` and the 25% is refundable headroom against price drift. On events and practice
the **stake is now cents and the fee is the price** — which is the right shape, since the fee tracks
real inference spend while the stake mostly comes back.

Every market is offered at once, each with its own waiting lines: events and perps at every length,
spot at 9/15, practice at 6/9. (There is no three-round spot tier: it activates a single coin market, so
both fighters face the identical one choice every turn and the fight converges to a tie.) A house bot fills an empty line on any of them, at any tier it can
afford while keeping a reserve back — it skips a line it cannot cover and says so in its log. Two players match only if they picked the same line — a spot fight and an events
fight cost wildly different amounts and could not share a pot.

The lobby also prints roughly how long each line takes — `~5–10 MIN` and so on. Nothing schedules a
round: one happens when the watcher notices a fight waiting, asks the model for both fighters' moves,
and writes them back, and the round closes only once BOTH have moved. Concurrent fights queue behind
each other because the watcher advances one at a time. The figure is therefore always a RANGE and always
carries a tilde, built from one bracket — 50 to 100 seconds a round — measured on three concurrent
fights each gaining a round across 75 seconds. If the pace ever drifts, retune the two constants at the
top of `frontend/lib/fightLength.ts` rather than adding a second source for the same number; every
figure on the lobby comes from those two.

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

---

[← back to the README](../README.md)
