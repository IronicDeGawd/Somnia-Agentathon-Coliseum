# Coliseum

> **Two prompts. One arena. Real trades. Live.**
>
> The first agent-vs-agent trading arena on Somnia. Two LLM personalities fight on dreamDEX's zero-fee CLOB. Spectators bet. The whole loop runs on-chain — no servers, no keepers, no humans in the loop.

Built for the **Somnia Agentathon** (May 2026).

---

## What it is

A duel is real on-chain trading between two AI personalities. Every turn each fighter's brain — a Somnia LLM agent — gets a market snapshot, picks one of seven moves (Hold, Buy/Sell WBTC, Buy/Sell WETH, Buy/Sell SOMI), and the Arena contract places that trade on dreamDEX. After 3, 6, 9, or 15 turns the higher-portfolio fighter wins. Spectators can bet via a separate Bookmaker contract. Turn ticks are driven by Somnia Reactivity — fully autonomous after `startDuel`.

## How a duel works

1. **Anyone calls `startDuel(fighterA, fighterB, turns)`** on the Arena contract. The caller deposits USDso — minimum is computed live from the order book (`Arena.minDepositFor(turns)`) plus a 1 USDso platform fee. The Arena pulls the deposit via `transferFrom`.
2. **Tier mapping** picks which markets the duel uses:

   | Turns | Active markets | Approx min deposit |
   |------:|---------------|--------------------|
   | 3 | SOMI only | ~$1–2 |
   | 6 | SOMI + WETH | ~$15 |
   | 9 | SOMI + WETH + WBTC | ~$90 |
   | 15 | SOMI + WETH + WBTC | ~$143 |

3. **Each turn** the Reactivity precompile fires `onEvent`, the Arena requests two LLM inferences (one per fighter), each fighter picks a number 0–6, and the Arena places an FOK order on the chosen pool. Mark prices are snapshotted for safety.
4. **Anyone calls `finalizeDuel(duelId)`** once all callbacks land. The Arena computes each fighter's portfolio value in USDso (quote balance + base × mark price), declares the higher one the winner, and stores `winnerSlot` on-chain (0 = fighterA, 1 = fighterB).
5. **The creator calls `recoverFunds(duelId)`** to withdraw their entitled USDso (sum of both fighters' quote balances on active pools). Per-duel accounting — one duel's recovery cannot drain another's funds.

## Fighter personalities

Six hardcoded LLM prompts in `FighterRegistry.sol`:

| # | Name | Style |
|---|------|-------|
| 0 | The Degen | Max-size momentum chaser |
| 1 | The Whale | Patient, large-conviction trades |
| 2 | The Scalper | Many small trades, tight spreads |
| 3 | The Reverter | Mean-revert, fade extremes |
| 4 | The Surfer | Trend-follow, cut losers fast |
| 5 | The Contrarian | Opposite of recent flow |

Each turn the LLM sees its current vault state, last action, and the active markets for the duel's tier — so a 3-turn SOMI duel only shows the SOMI buy/sell options, not the locked WBTC/WETH ones.

## Repo layout

```
somniaforge-agentathon/
├── coliseum/                       # main backend
│   ├── contracts/
│   │   ├── Arena.sol               # duel orchestrator
│   │   ├── ArenaVault.sol          # abstract base — fund management + Reactivity
│   │   ├── Bookmaker.sol           # spectator bet settlement
│   │   ├── FighterRegistry.sol     # 6 hardcoded fighter prompts
│   │   ├── Ping.sol                # Reactivity callback handler
│   │   ├── interfaces/             # ISpotPool, IFighterRegistry, IArena, etc.
│   │   └── lib/
│   │       ├── ArenaTypes.sol      # all structs, enums, errors, events
│   │       └── ArenaUtils.sol      # pure/view helpers, minDepositFor, prompt builder
│   ├── scripts/                    # deploy + operational scripts
│   │   ├── deploy.ts               # full system deploy
│   │   ├── start-duel.ts           # opens a duel — TURNS=3/6/9/15
│   │   ├── finalize.ts             # finalize a completed duel
│   │   ├── recover-duel.ts         # creator recovers funds — DUEL_ID=N
│   │   ├── force-turn.ts           # manual owner-only turn() bootstrap
│   │   ├── check-arena-state.ts    # diagnostics
│   │   └── ...
│   ├── test/                       # 59 passing Hardhat tests
│   ├── frontend/                   # Next.js 15 (in progress)
│   └── deployments/somnia.json     # latest testnet addresses
├── sandbox/                        # primitive validation (sandbox phase)
│   ├── contracts/                  # MockSpotPool, MultiAgent
│   └── scripts/                    # force-swap, BlockTick tests, etc.
└── context/                        # plans, research, progress
    ├── plan/                       # feature specs
    ├── research/                   # dreamDEX + Somnia Agents + Reactivity refs
    ├── progress.md                 # current build status + lessons
    └── handover.md                 # compact-survival essentials
```

## Quick start

```bash
# Install
pnpm install

# Test
cd coliseum && pnpm exec hardhat test           # 59 passing

# Deploy to Somnia testnet (needs ~33 STT + USDso for pool seeding)
USDSO_PER_POOL=13 pnpm exec hardhat run scripts/deploy.ts --network somnia

# Start a 3-turn (cheapest) duel
TURNS=3 pnpm exec hardhat run scripts/start-duel.ts --network somnia

# Bootstrap turns (owner-only — Reactivity is flaky on testnet)
pnpm exec hardhat run scripts/force-turn.ts --network somnia

# Once completedCallbacks == turns * 2
pnpm exec hardhat run scripts/finalize.ts --network somnia
DUEL_ID=1 pnpm exec hardhat run scripts/recover-duel.ts --network somnia
```

## Stack

| Layer | Component |
|---|---|
| Execution venue | **dreamDEX testnet** — SOMI / WBTC / WETH spot pools, all quoted in USDso |
| Agent brain | **Somnia Agents** — LLM inference with validator consensus |
| Turn loop | **Reactivity BlockTick** — validator-pushed turn advancement |
| Settlement | On-chain, atomic, FOK orders |
| Frontend | Next.js 15 + Tailwind v4 + wagmi 2 + RainbowKit (in progress) |

**Testnet-only.** Reactivity is testnet-only as of May 2026; using it as the autonomy primitive is more valuable than mainnet stakes for the Agentathon brief.

## Security highlights

Backend went through a full audit pass. Notable fixes applied (see commit history on `main`):

- **Per-duel `recoverFunds`** — one duel's creator cannot drain another's funds. Uses tracked quote balances per duel, not the contract's whole vault.
- **CEI ordering on recovery** — `fundsRecovered` flag flips before any external call; reentrancy can't double-spend.
- **`sweepToken(USDso, …)` blocked** — owner cannot drain user deposits via the sweep path. Use `withdrawFees(to)` for the platform-fee portion.
- **`turn()` is `onlyOwner`** — public access would let an attacker time turns around pool manipulation. Reactivity drives normal flow; `turn()` is a manual fallback.
- **Mark price snapshots** — `emergencyFinalize` reads snapshots stored each turn instead of live prices. Owner cannot time the call to a favorable book state.
- **On-chain winner** — `Bookmaker.settleBets(duelId)` reads `winnerSlot` from Arena, not a caller argument.
- **Dynamic action prompt** — LLM only sees actions available for the duel's tier.

## Key addresses (Somnia testnet, chain ID 50312)

| Contract | Address |
|---|---|
| USDso (quote token) | `0x9c32F3827A1a99f0cf9B213de8b53eC3d57bb171` |
| dreamDEX SOMI/USDso (native) | `0x259fD6559214dd5aD3752322426eA9F9fABEFff4` |
| dreamDEX WBTC/USDso | `0x3605f28aA7C50e7441211e77Cb0762d49539326C` |
| dreamDEX WETH/USDso | `0xD180195da5459C7a0DEA188ed61216ec43682b50` |
| Somnia Agents platform | `0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776` |

Latest deployed Arena and Bookmaker addresses live in `coliseum/deployments/somnia.json`.

## Where to read next

- `context/plan/coliseum.md` — full backend implementation plan
- `context/plan/coliseum-frontend.md` — full UI spec
- `context/progress.md` — current build status, lessons learned, resume point
- `context/research/` — dreamDEX, Somnia Agents, and Reactivity reference docs

## License

MIT.

---

**Built for Somnia Agentathon · May 2026 · powered by Somnia Agents + Reactivity + dreamDEX.**
