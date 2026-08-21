# How a duel works, who is fighting, and what a fight can prove

One fight end to end: matched, funded, rung, settled. Then the six personalities, and the
honest limits of what the record can and cannot show.

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

**What a fighter is told, and why it changed.**

The rule used to be that a fighter is never shown a digit. A price echoed back by a model was once
read as a move number and executed as the wrong trade, so slots were described in words — *"odds edged
toward yes"*, *"very likely"* — and never as figures.

That rule now holds for **events only**, and the reason it was relaxed matters more than the rule did.
A prediction's mark IS a probability, so words carry it perfectly: a three-point shift in odds is three
hundred basis points and the word bands fire. A coin book is different. It moves a few basis points in
a sixty-second turn, so every spot slot read "flat" every turn — measured across three tiers, six
fighters placed **four orders in total**, all in the same one asset. A fighter was never shown a reason
to do anything.

Spot and perps therefore carry exact figures. The original danger is closed by a different mechanism:
the answer is matched against a **fixed allow-list of action names**, so a number in the prompt can
only fail to match, which is recorded as a coercion and read as Hold. Visible, and never a trade
nobody asked for.

**Numbers alone were still not enough on perps**, and that took a second fix. Measured 2026-08-21:
a six-round perps fight produced **twelve Holds from twelve moves** while seven actions were offered
and every one was affordable. The three markets had moved 5.6, 9.4 and 23.4 basis points across the
whole fight — there was no thesis to be had, and two things made that worse:

- **Nothing said the fighter had an opponent.** It was given a score against its own starting figure
  and nothing else, so staying flat looked free. Every market's prompt now says a fighter is scored
  against the other one, and that a book which never takes a position cannot win a fight. Stated as a
  rule rather than quoting a live opponent score: portfolios are valued at the final bell, so a real
  figure would mean revaluing three markets inside every prompt of every turn.
- **The move was absolute, so it could not be judged.** Four basis points means nothing without
  knowing what a market usually does in a minute. The prompt now names *the largest move of the fight
  so far, and its direction* — and says nothing when there is nothing to say, because emphasis has to
  be scarce to mean anything. A fighter talked into trading noise pays the spread on purpose.

Both were measured before they were deployed, on the real model with no Arena involved — see the
prompt harness note under "Guards worth copying".

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

## What a fight records, and what it cannot

A spectator sees a fight's whole story: every move by both fighters, timestamped from the block it was
mined in, live and historical in one place. Times are *asked of the chain* rather than derived from the
nominal block interval — a fight can stall between rounds, and an invented clock would show a cadence
that never happened.

The margin warnings on a perps fight are a harder problem, and worth writing down because the answer
was counter-intuitive twice over.

**A margin state is a live calculation, not a recorded fact.** The venue is asked what an account's
state is *right now* and answers from current equity. Nothing emits it — ours or the venue's — and the
link from a fighter to its rented trading account is deleted at the final bell, so after the bell the
registry answers "healthy" forever, whatever happened. The page has polled this every ten seconds for
months. So a state can only ever be *witnessed*, by a page that happened to be open, and those rows say
"seen" rather than pretending to be chain facts.

**A liquidation is different in kind, because it is an act rather than a threshold.** The venue does it
and records that it did. It is not on the margin desk — that emits only `CollateralLocked`,
`CollateralUnlocked`, `PositionUpdated` and `FundingSettled` — it is on the **liquidation engine**, as
`AccountLiquidated`, indexed by account and carrying the margin status *before and after*. So a fight
finished months ago can still be asked what the venue did to a fighter, and answer. Those rows say
"on-chain". **No storage contract was needed; the chain already had it and we were asking the wrong
contract.**

**And the states cannot be induced on purpose.** Measured on duel 83: equity 0.0627, initial margin
requirement 0.0618, maintenance 0.0309, close-out 0.0155. A margin call fires below *maintenance* — half
the equity present — while every withdrawal we control is capped at equity minus *initial*, which by
construction leaves the account above initial. Nothing on our side can reach the line; only an adverse
market move can. Zero liquidations have occurred on this venue at all, to anyone, across 150,000 blocks.
So the three warning states are **unproven on screen**, deliberately: the logic that will catch one is
unit-tested against synthetic events rather than demonstrated, and that is stated rather than glossed.

---

[← back to the README](../README.md)
