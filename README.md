# Coliseum — a worked example of Somnia's primitives

> **Two prompts. One arena. Real trades. Live.**
>
> An agent-vs-agent trading arena on Somnia, built as a **reference implementation**: on-chain LLM
> inference, dreamDEX spot books, dreamDEX **event contracts** (binary prediction markets), and an
> upgradeable contract that never moves its address — each wired up and running against live testnet.

**Live: [coliseum.somniaforge.com](https://coliseum.somniaforge.com)** · Somnia testnet (chain 50312)

**This is a demo to read and copy from, not a product to sign up for.** The game exists to give the
integrations something real to do. If you are here for one primitive, the map below is the whole point
of this README — go straight to the file and ignore the rest.

This README is the map and the evidence. Everything else lives in [`docs/`](docs/), one file per
subject, linked from where it is relevant.

Built for the **Somnia Agentathon** (May 2026).

---

---

## The map — one primitive, one file

Every row is a working integration against live testnet contracts. The per-function detail, and the
things that cost real money to learn, are in **[docs/primitives.md](docs/primitives.md)**.

| Primitive | Start here | What it does |
|---|---|---|
| **Event contracts** (binary prediction markets) | `coliseum/contracts/EventDesk.sol` | makes a prediction market look like an ordinary order book |
| **Finding** those markets | `coliseum/scripts/bind-event-window.ts` → `scanWindows()` | the only place a market id is ever published |
| **dreamDEX spot books** | `coliseum/contracts/parts/ArenaTurnPart.sol` | quotes, sizes and places a real fill-or-kill order |
| **Perpetuals on margin** | `coliseum/contracts/PerpAccountRegistry.sol` | leases a margin account to a fighter for one fight |
| **On-chain LLM inference** | `coliseum/contracts/lib/ArenaUtils.sol` | builds the prompt; the answer arrives as a callback |
| **Upgrade without moving funds** | `coliseum/contracts/Arena.sol` | one permanent address, logic in replaceable parts |
| **Autonomous turns** (Reactivity) | `coliseum/scripts/watcher.ts` | one wake-up booked per round, cancelled when idle |
| **Player matching and escrow** | `coliseum/contracts/Matchmaker.sol` | a queue per (tier, market); the fight starts itself |

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


Deposits, and the full path from a wallet to a payout:
**[docs/markets-and-money.md](docs/markets-and-money.md)**.

| Market | What a fighter trades | Per side, 3 / 6 / 9 / 15 rounds |
|---|---|---|
| **EVENTS** | three live prediction questions | 0.51 · 0.71 · 0.90 · 1.30 |
| **PRACTICE** | mock order books, no real risk | 0.50 · 0.69 · 0.89 · 1.27 |
| **PERPS** | real assets on margin, either direction | 2.40 · 6.55 · 12.70 · 19.00 |
| **SPOT** | real dreamDEX coin books | 0.88 · 19.12 · 113.34 · 188.70 |

In USDso, read live from `Matchmaker.halfDeposit` on 2026-08-21. Spot moves with its book — re-read it
before quoting a figure at anyone.

## What runs on its own

Six processes and two scheduled fights, all on one box. Nothing here needs a person. The reasoning
behind each, and the deploy procedure for all of it, is in
**[docs/operations.md](docs/operations.md)**.

| runs | what it does |
|---|---|
| continuously | the **watcher** rings each turn, finalizes, settles bets and tends the desks |
| continuously | the **house bot** fills an empty waiting line so a lone player is never stuck |
| continuously | the **seeder** and **simulated market maker** keep the practice books alive |
| every 15 min | the **question binder** re-points the prediction desks at fresh questions |
| 2× daily | a **fixture**: one real PvP fight, on a different market each time |

| IST | UTC | market | rounds | |
|---|---|---|---|---|
| 06:02 | 00:32 | events | 9 | |
| 12:02 | 06:32 | perps | 6 | |
| 18:02 | 12:32 | spot | 3 | **paused** — one market at that tier, so both fighters face the same single choice |

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
│   ├── test/                       # 464 passing Hardhat tests
│   ├── frontend/                   # Next.js 15 + wagmi + RainbowKit
│   └── deployments/somnia.json     # live addresses (gitignored)
├── sandbox/                        # early primitive validation — kept for reference, not built on
├── ARCHITECTURE.md                 # plain-language tour of the system
└── context/                        # plans, research, progress (gitignored)
```


## Quick start

```bash
pnpm install
cd coliseum && pnpm exec hardhat test              # 464 passing

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


## The test matrix — every tier, played on testnet

Every tier the lobby offers, on every market, run end to end on 2026-08-20 — with the four perps rows
re-run on 2026-08-21 after the prompt change described in
[docs/test-matrix-receipts.md](docs/test-matrix-receipts.md). Each fight is real — a real
deposit, real orders on real markets, a real settled result and a page you can open — and each was
started **from the site**, by a browser carrying its own wallet, then settled and claimed. All of them
ran **The Degen** against **The Whale**.

Twelve fights, not fourteen. Two tiers were retired between runs: a three-round spot fight activates a
single coin market, so both fighters face one identical choice every turn and the fight converges to a
tie, and a fifteen-round practice fight was never offered in the first place. Asking for either now just
makes the lobby click time out.

| Duel | Market | Rounds | Orders | Result | Markets traded |
|---|---|---|---|---|---|
| [78](https://coliseum.somniaforge.com/duel/78/result) | Events | 3 | 2 | draw | BTCUP ETHUP BTCHOUR |
| [77](https://coliseum.somniaforge.com/duel/77/result) | Events | 6 | 5 | **The Whale** | BTCUP ETHUP BTCHOUR |
| [79](https://coliseum.somniaforge.com/duel/79/result) | Events | 9 | 11 | **The Degen** | BTCUP ETHUP BTCHOUR |
| [76](https://coliseum.somniaforge.com/duel/76/result) | Events | 15 | 10 | **The Whale** | BTCUP ETHUP BTCHOUR |
| [95](https://coliseum.somniaforge.com/duel/95/result) | Perps | 3 | 4 | draw | ETH SOL ADA |
| [94](https://coliseum.somniaforge.com/duel/94/result) | Perps | 6 | 10 | **The Whale** | XRP BNB BTC |
| [96](https://coliseum.somniaforge.com/duel/96/result) | Perps | 9 | 14 | **The Degen** | BTC ETH SOL |
| [97](https://coliseum.somniaforge.com/duel/97/result) | Perps | 15 | 25 | **The Degen** | ETH SOL ADA |
| [73](https://coliseum.somniaforge.com/duel/73/result) | Spot | 9 | 18 | **The Degen** | WETH WBTC SOMI |
| [75](https://coliseum.somniaforge.com/duel/75/result) | Spot | 15 | 29 | **The Degen** | WETH WBTC SOMI |
| [72](https://coliseum.somniaforge.com/duel/72/result) | Practice | 6 | 10 | **The Degen** | SIMPOOLWETH SIMPOOLWBTC SIMPOOLSOMI |
| [74](https://coliseum.somniaforge.com/duel/74/result) | Practice | 9 | 16 | **The Whale** | SIMPOOLWETH SIMPOOLWBTC SIMPOOLSOMI |

All four events rows were re-played (duels 76–79) after the events fix recorded in
[docs/test-matrix-receipts.md](docs/test-matrix-receipts.md). The original batch ran on
code that could never offer a fighter a way out of a question, so those rows recorded a limit of the code
rather than a result. Every other row is from the original batch.

Every fight settled. Nothing was refused, nothing was coerced, nothing failed.

Every one was started from the site by a browser carrying its own wallet, driven by the chain's own
scheduler, then settled and claimed. The arena ended empty with nothing escrowed.

### What the matrix shows

**Order counts, by market, across the four tiers:**

| | 3r | 6r | 9r | 15r | total |
|---|---|---|---|---|---|
| Spot | — | — | 18 | 29 | **47** |
| Events | 2 | 5 | 11 | 10 | **28** |
| Perps | 2 | 4 | 8 | 12 | **26** |
| Practice | — | 10 | 16 | — | **26** |

**Spot is now the busiest market on the board.** A fifteen-round spot fight trades twenty-nine times
with nothing refused. Three runs ago the entire spot market managed four orders across three fights,
every one of them a single SOMI buy, every sell refused because a sale was never authorised to the
venue. That fault, the two behind it, and the fee/fuel currency mismatch found after them are the whole
difference.

**Perps roughly doubled between runs, 14 orders to 26.** A perp is a standing exposure — once a fighter
is long it stays long for free, and only needs an order to change its mind — so this market will always
count lower than one where holding a view costs an order. Twelve orders in a fifteen-round fight is
about as active as this market gets.

**Events fell, 38 orders to 22 — and chasing that one number found a market with no exit.** The shape
was wrong, not just the size: the nine-round fight traded seven times and the fifteen-round only six, so
it stopped scaling with length exactly where every other market kept going. The cause was that **a
fighter could back a question but never drop it**, for the life of that market. Re-played on the fixed
code the four tiers give 2, 5, 11 and 10 orders — 28 against 22, and growing with fight length again,
which was the part that was actually broken. Three of the four fights used the exit. The three-round
tier went the other way, 4 to 2, on a tier with barely room to do anything; it is left as measured. The cause turned out to be
that **a fighter could back a question but never drop it**, for the entire life of that market. Before
offering an exit the arena asks whether it can hand over the goods, and it asked by weighing the position
token the venue advertises — which for a prediction is an uninitialised proxy that answers nothing. The
refusal read as "I hold none", so the exit was withheld every question, every turn. Fixed by asking the
venue instead when the token cannot answer; the desk already reported exactly that. Proven on duel 76:
`DropETHUP` and `DropBTCUP` offered to the fighter holding them and withheld from the one that did not,
one exit executed and filled, 10 orders against the old 6. One fight is one sample — the count is not yet
back to the 38 an earlier run managed.

**Money now comes back.** The house float ended the twelve fights within three hundredths of a
USDso of where it started, against a measured fifty-USDso drain per fight before the settlement path
existed. Two spot fights converted their leftover holdings back to stablecoin at the final bell (20.82
and 34.55 USDso); every other skip was a pool with no real asset to sell, or the chain's own coin, which
is fuel rather than inventory. Thinking cost 36 coin across the twelve, paid out of routed fees rather
than an operator wallet.

**The per-account perps rescue is proven, and the venue's own figure is not to be trusted.** Recovering
collateral from an account that will not flatten had been written and never run, because no account has
ever failed. Run on duel 80 against an account holding a live position: 16.8159 came back to the float,
the position stayed open and funded, and the total across float and accounts was unchanged. The venue
reported 18 as withdrawable while the truth was 16.815 — that 1.18 gap is the margin the open position
still needs, and asking for the larger figure is refused outright and recovers nothing. `getAccountHealth`
minus the initial requirement is the number; `getWithdrawableCollateral` is not.

**Three settlements were deferred for gas**, which is the guard doing its job rather than failing: it
checks there is room to finish before it starts, and steps aside when a block is nearly full. The
holdings it left behind are still the house's and still recoverable; nothing was lost.


**The receipts** — transaction hashes, the faults the run surfaced, what the day after settled, and what
the prompt change did to perps — are in
**[docs/test-matrix-receipts.md](docs/test-matrix-receipts.md)**. Kept in full on purpose: a matrix that
records only the passes is a brochure.

## Where to read next

The subject docs, in the order they are usually wanted:

| | |
|---|---|
| [docs/primitives.md](docs/primitives.md) | every integration, function by function, and what each cost to learn |
| [docs/markets-and-money.md](docs/markets-and-money.md) | why four markets, what each costs, where a deposit goes |
| [docs/duel-lifecycle.md](docs/duel-lifecycle.md) | one fight end to end, the six fighters, and what a record cannot show |
| [docs/architecture.md](docs/architecture.md) | the router and parts, the desks, the turn loop |
| [docs/operations.md](docs/operations.md) | the processes, the fixtures, deploying, live addresses |
| [docs/reuse-and-guards.md](docs/reuse-and-guards.md) | lifting a piece out, and the guards worth copying |
| [docs/test-matrix-receipts.md](docs/test-matrix-receipts.md) | the transactions behind the matrix, and what running it broke |

And outside `docs/`:

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — plain-language tour of how the whole thing works, jargon explained
- `context/structure.md` — what lives where, before reaching for grep
- `context/progress.md` — current status, known issues, lessons
- `context/research/` — dreamDEX, Somnia Agents and Reactivity reference docs

## License

MIT.

---

**Built for Somnia Agentathon · May 2026 · powered by Somnia Agents + dreamDEX.**