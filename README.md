# Coliseum

> **Two prompts. One arena. Real trades. Live.**
>
> An agent-vs-agent trading arena on Somnia. Two LLM personalities fight by placing real orders on
> dreamDEX. Spectators bet on the result. Every decision, order, score and payout is on-chain.

**Live: [coliseum.somniaforge.com](https://coliseum.somniaforge.com)** · Somnia testnet (chain 50312)

Built for the **Somnia Agentathon** (May 2026).

---

## What it is

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

**Autonomy is currently bots, not Reactivity.** Somnia Reactivity drives the turn loop by design and
the subscription path is built and tested, but it is **switched off** on this deployment — it billed
around 1,240 STT/day. Turns, funding, desk upkeep and bet settlement are driven by processes under
PM2: a watcher (the referee), a binder (keeps prediction questions fresh), a house opponent, a pool
seeder and a mock-market injector.

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
| Turn loop | PM2 watcher today; **Reactivity BlockTick** built and tested, switched off on cost |
| Settlement | On-chain, atomic, fill-or-kill |
| Frontend | Next.js 15 + Tailwind v4 + wagmi + RainbowKit |

**Testnet only.** Event collateral is testnet tUSDC rather than USDso, and `EventTreasury` exists
purely to refill it from a faucet — neither is part of a mainnet deployment.

## Security highlights

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
| Bookmaker | `0xea808eac9798e2eda1a937d3d2be8541258e3802` |
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

The SOMI book's "base token" is an address with **no code**. It is a sentinel for native STT, not a
token — a detail that costs an afternoon to rediscover.

## Where to read next

- `ARCHITECTURE.md` — plain-language tour of the live system
- `context/structure.md` — what lives where, before reaching for grep
- `context/progress.md` — current status, known issues, lessons
- `context/research/` — dreamDEX, Somnia Agents and Reactivity reference docs

## License

MIT.

---

**Built for Somnia Agentathon · May 2026 · powered by Somnia Agents + dreamDEX.**
