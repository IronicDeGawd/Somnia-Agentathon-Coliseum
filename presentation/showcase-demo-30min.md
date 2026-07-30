# Coliseum — 30-Minute Demo Script

> Read-aloud script with timings. Spoken lines are in quotes; everything else is an action.
> Verified against the live deployment on 2026-07-30.

---

## Before you start (do this 5 minutes early)

- [ ] Open `https://coliseum.somniaforge.com/` and hard-refresh
- [ ] Connect the wallet holding **10 USDso + 220 STT** (`0x1E6C…a745`)
- [ ] Open a second tab on the Somnia explorer, ready to paste a tx hash
- [ ] Open a third tab on `/fighters`
- [ ] Have the SSH terminal ready (only needed if you want the bot's-eye view)
- [ ] Confirm the arena is idle — the lobby should read "ARENA IS DARK"

**The one timing rule that matters:** a turn cannot land faster than **56 seconds**
(600 blocks at 0.094s), so a 6-round duel takes about **7 minutes**. You start the duel
at minute 4 and it resolves around minute 11, while you keep talking. Never start a duel
and then wait in silence for it.

---

## 0:00 – 2:00 · Open

> "This is Coliseum. Two AI trading agents fight over a real order book, and the crowd
> bets on who wins. Everything you're about to see — the agents' decisions, the trades,
> the bets, the payouts — happens on Somnia. Nothing is pre-recorded, and I'll show you
> the transactions."

> "It took second place out of about eight hundred builds in the Somnia Agentathon. I
> built it solo."

Show the landing page. Scroll slowly past the roster.

> "Six agents. Each one has a different trading personality — the Degen goes all in, the
> Whale moves in size and takes profit, the Quant sits in cash unless the numbers justify
> a move. Those personalities are prompts stored on-chain, and I can retune them without
> redeploying anything."

---

## 2:00 – 4:00 · How one duel works

Go to `/duel`.

> "A duel is a queue. I pick an agent and a tier, and I put up half the pot. If nobody
> else is waiting, a house bot fills the other side, so a duel always starts."

> "Then every round, each agent gets asked one question on-chain: here's the market,
> here's what you're holding — buy, sell, or hold? That question goes to Somnia's on-chain
> LLM inference and the answer comes back as a number. That number becomes an order on
> dreamDEX. This is the part I want to be precise about: the agent's decision is a
> transaction, not an animation."

---

## 4:00 – 5:00 · Start the duel (do this now, it runs in the background)

Pick **The Degen**, tier **6 rounds**, market **Simulated**. Queue it. Approve in wallet.

> "That's 3.60 USDso escrowed from me. Watch — the house bot is going to notice an
> unmatched slot and take the other side."

Wait for the redirect to the live duel page (~15 seconds).

> "Matched. Six rounds, two assets, and it'll resolve in about seven minutes. Let's use
> that time."

---

## 5:00 – 8:00 · Place a bet, live

Stay on the duel page. Find the betting panel.

> "While it's running, anyone watching can bet. This is parimutuel — there's no
> bookmaker taking the other side. Winners split the losing pool."

Place a small bet — **0.2 USDso** — on one fighter. Approve, confirm.

> "The line opened at even money automatically when the duel went live. And note what I
> don't have to do at the end: nothing. Settlement is automatic. Yesterday this needed a
> human to press a button, and if nobody did, winners just… didn't get paid. That's fixed."

> "The contract also blocks the two duelists from betting on their own fight. On-chain,
> not in the UI."

---

## 8:00 – 12:00 · Watch the agents actually trade

Point at the move feed as rounds land (roughly one per minute).

> "There's round one. The Degen bought WETH. The Whale did something different — and that
> difference is the whole game. Same market summary, same model, different persona."

When a round shows a failed move, **address it directly rather than hoping nobody noticed**:

> "See that failed move? The agent tried to sell something it no longer held. The contract
> rejected the order and the duel carried on — the money is never at risk, it just loses
> that turn. The cause is that I was handing the model a 'sell' option it couldn't
> actually execute. That fix is written and ships with the next deploy."

Show the mark-price line moving.

> "The prices you're seeing track real dreamDEX marks — WETH around nineteen hundred,
> Bitcoin around sixty-four and a half thousand. This is the simulated market: real
> prices, mock pools, so a demo can't be ruined by a quiet order book."

---

## 12:00 – 16:00 · Real dreamDEX, with receipts

Open the `+ USDso` button in the top bar. Enter **50 STT**. Swap.

> "This is not a faucet. This reads the dreamDEX order book, simulates the order, and
> places a real taker order against the live book."

When it completes, copy the tx hash into the explorer tab.

> "There it is on-chain. Fifty STT in, about four and a quarter USDso out, filled against
> a real resting bid."

> "Duels can run on that real book too — I ran one earlier today where an agent placed
> three real orders that all filled at 0.0852. Right now, on the real market, agents can
> only buy: dreamDEX changed its default funding model recently and it strands sell-side
> inventory. The fix is written; it needs a redeploy. So today the honest split is —
> simulated market for the fight, real market to prove the plumbing."

*(If MAX looks small: it's capped at 50 STT deliberately — the book advertises more depth
than the maker delivers, and an oversized order silently falls back to a 1 USDso reserve.)*

---

## 16:00 – 20:00 · Resolution and automatic payout

The duel should resolve about here. Go to the result page — **let it finish loading before
you talk about the winner.**

> "Both portfolios get valued at the mark price on the final round. Higher value takes the
> pot. Here's the margin — these are real dollar values, not points."

Show the settlement panel.

> "And the bet I placed is already settled. Nobody clicked anything. The keeper saw the
> duel resolve, called settlement, and the winning side got their stake plus a share of
> the losing pool, minus a five percent rake."

Pull up the earlier verified numbers if useful:

> "Earlier today: two bets of a tenth of a USDso on opposite sides. Winner received 0.195,
> rake was 0.005. That's the whole economic loop, working."

---

## 20:00 – 24:00 · The rest of the surface

Visit `/fighters`, then a fighter detail page.

> "Records, PnL and win rate per agent — all read from the settled-duel ledger on-chain,
> not a database I control."

Back to the landing page ledger / standings.

> "Every duel that's ever resolved on this deployment. Eighteen so far. Anyone can verify
> all of it; I don't have a privileged copy."

Optionally show the terminal:

> "And this is the keeper's view — it's small on purpose: drive the turn, open the line,
> settle the bets, keep the arena fuelled for inference."

---

## 24:00 – 27:00 · Economics and what's next

> "On money: the flat duel fee just covers inference and gas. The real business is the
> five percent rake on betting. Which means a duel nobody watches roughly breaks even —
> the spectators are the product, not the fighters."

> "Three things next. Move the heartbeat on-chain with Somnia Reactivity — the handler is
> already written, I keep it switched off because an every-block subscription burns STT
> continuously. Run duels in parallel instead of one at a time. And move the live feed
> onto Somnia Data Streams instead of the log backfill I hand-rolled."

> "Two limits worth naming: on an exact tie the left-hand fighter wins, which is position
> rather than skill. And the agents differ strongly between personas but don't really adapt
> within a duel — the Degen buys every single round. Making them react to what the
> opponent is doing is the interesting problem."

---

## 27:00 – 30:00 · Q&A

**Likely questions, short answers**

- *"Is the AI really on-chain?"* — Yes. `Arena` calls Somnia Agents' inference from
  inside the contract and pays for it in STT; the request and response are both events.
  It is not my server calling an API.
- *"Could you rig a duel?"* — I own the prompts, so I could bias a persona. I cannot pick
  a winner: portfolio value is computed from mark-price snapshots taken before any order,
  and the winner is written by the contract.
- *"What if nobody bets?"* — The duel runs anyway; it's just close to break-even.
- *"Why simulated prices?"* — Testnet SOMI is flat, so a real-market duel resolves in a
  near-tie with no story. Simulated prices track real marks and give the fight something
  to react to.
- *"How much does a duel cost to run?"* — About 1.4 STT of inference for six rounds, plus
  gas. Roughly 1.1 USDso of platform fee on a tier-6 duel.

---

## If something goes wrong

| Problem | What to do |
|---|---|
| House doesn't match within ~30s | Say "the house bot waits fifteen seconds before it fills a lonely slot" and keep talking; it will. |
| Duel looks stuck mid-round | A turn cannot come faster than 56s. Fill with slide 3 or 4 content. |
| Result page shows no winner | Let it finish loading — it deliberately refuses to name a winner until the data is in. |
| Bet transaction fails | Check the wallet has USDso, not just STT. First-ever USDso receipt needs extra gas. |
| Out of USDso | `+ USDso` in the top bar, 50 STT at a time. |
| Everything looks dark | Fall back to a resolved duel — `/duel/17/result` is a clean 6-round example. |
