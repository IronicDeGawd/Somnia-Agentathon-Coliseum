# Coliseum

> **Two prompts. One arena. Real trades. Live.**
>
> The first agent-vs-agent trading arena on Somnia. Two LLM personalities fight on dreamDEX's zero-fee CLOB. Spectators bet. An LLM bookmaker prices the odds. The whole loop runs on-chain with no servers, no keepers, no humans in the loop.

Built for the **Somnia Agentathon** (May 2026) — *Build the most novel and high-impact agent-driven application on Somnia.*

---

## What it is, in one paragraph

Picture a Twitch fighting-game broadcast where the fighters are LLM personalities ("The Degen", "The Whale") and the fight is *real on-chain trading*. Every 60 seconds, each fighter's brain — a Somnia LLM Inference agent — gets a fresh market snapshot, decides on a move, and executes it as a real order on dreamDEX. After 15 turns, whoever has the highest PnL wins the pot. Spectators bet on the side; an LLM bookmaker prices live odds. **The turn loop is driven by Somnia Reactivity** — no off-chain server, no keeper, no human pushing buttons.

## Why now, why Somnia, why dreamDEX

Three primitives lined up at exactly the right time:

| Primitive | What it does for Coliseum |
|---|---|
| **Somnia Agents** | Deterministic on-chain LLMs. Two fighter brains + one bookmaker brain, all running with validator consensus. |
| **Somnia Reactivity** | Validator-pushed `BlockTick` drives every duel turn. **No off-chain keeper means full autonomy.** |
| **dreamDEX** | Zero-fee CLOB explicitly built for agents. Fighters can place GTC limit orders, cancel, market-hit — without bleeding fees. |

dreamDEX's intro literally says *"Native agent and algo access… autonomous agents and LLMs are first-class participants."* Coliseum is the canonical use case they were waiting for.

## How it scores against the judging criteria

| Criterion | How Coliseum earns it |
|---|---|
| **Functionality** | One Arena + one Bookmaker + one FighterRegistry contract. Deployable, demoable, runs reliably under load (Somnia handles 1M TPS). |
| **Agent-First Design** | Every duel turn is *literally* two autonomous LLM agents making independent decisions. The bookmaker is itself an agent. Reactivity drives the loop, dreamDEX executes the trades. Maximum agent density. |
| **Innovation & Technical Creativity** | First agent-vs-agent trading product on Somnia. First product combining Somnia Agents + dreamDEX. The "fight as financial duel" framing is fresh — most agent submissions are oracles or auto-traders. |
| **Autonomous Performance** | Once a duel starts, zero human input. Reactivity-driven turns, Agent-driven decisions, dreamDEX-executed trades, Bookmaker-set odds, on-chain settlement. The judges can verify it on the explorer. |

## The product surface

**6 pre-built fighter personalities** — each a tuned LLM system prompt with a distinct trading style:

| # | Fighter | Style | Tagline |
|---|---|---|---|
| 1 | **The Degen** | Max-size momentum chaser | *"Send it. Always."* |
| 2 | **The Whale** | Patient, large-conviction trades | *"I'll wait for it."* |
| 3 | **The Scalper** | Many small trades, tight spreads | *"Death by a thousand cuts."* |
| 4 | **The Reverter** | Mean-revert, fade extremes | *"All trends end."* |
| 5 | **The Surfer** | Trend-follow, cut losers fast | *"Ride the wave."* |
| 6 | **The Contrarian** | Opposite of recent flow | *"Crowd is always wrong."* |

**3 trading pairs on dreamDEX testnet**: SOMI/USDso, WBTC/USDso, WETH/USDso (all settled in USDso).

**Duel mechanics**: 15-minute duels, 60-second turns, vault-funded (so fighters can place limit orders, not just market hits), winner takes the pot minus 5% arena rake.

**Spectator betting**: an LLM Bookmaker agent reads each fighter's prompt + intra-duel PnL each turn and re-prices odds. Spectators bet testnet USDso, get paid at locked-in odds.

## Stack (testnet-only — see §Why testnet below)

| Layer | Component |
|---|---|
| Execution venue | **dreamDEX testnet** (SOMI/USDso, WBTC/USDso, WETH/USDso pools) |
| Agent brain | **Somnia Agents** testnet `0x037Bb9C7…` — LLM Inference + JSON API Agent |
| Turn loop | **Reactivity BlockTick** (off-chain subscription, free, every ~60s) |
| Audit feed | Plain Solidity events (`FighterMove`, `OddsUpdate`, `DuelStarted`, `DuelResolved`, `BetSettled`) |
| Stake currency | **testnet USDso** |
| Frontend | Next.js 15 + Tailwind + Framer Motion + wagmi + viem, deployed to Vercel |

**Why testnet**: as of May 2026, Reactivity is testnet-only. dreamDEX has live testnet pools. Somnia Agents are on both networks. **Putting everything on testnet lets us use Reactivity as the actual autonomy primitive** (instead of faking it with a keeper). The Reactivity story is worth more than mainnet stakes for the judging criteria.

## The aesthetic

Twitch fighting-game broadcast meets retro-terminal trading floor. Dark-stage palette with hot-magenta vs electric-cyan fighter glow. Pixelify Sans display + JetBrains Mono everywhere else. Bracket-text buttons `[ BET 5 USDSO ]`. CRT terminal vibes. Avatars are tarot-card portrait illustrations, not pixel art.

See `context/plan/coliseum-frontend.md` for the full visual spec.

## Architecture (high-level)

```
                       USER (browser)
                            │
                            ▼
              ┌──────────────────────────┐
              │  Next.js Frontend        │
              │  (wallet + spectator UI) │
              └──────────────────────────┘
                  │              │
        wagmi/viem │              │ native WebSocket
                  ▼              ▼
   ┌─────────────────────┐   ┌──────────────────────┐
   │   Arena contract    │   │  dreamDEX WS API     │
   │   Bookmaker contract│   │  (orderbook, trades, │
   │   FighterRegistry   │   │   ohlcv, order)      │
   └─────────────────────┘   └──────────────────────┘
            │                          │
            │ placeOrder / cancel      │
            ▼                          │
   ┌─────────────────────┐             │
   │ dreamDEX SpotPools  │◄────────────┘
   │ (SOMI/WBTC/WETH)    │
   └─────────────────────┘
            ▲
            │ executes calldata
            │
   ┌─────────────────────┐    Reactivity BlockTick (every ~60s)
   │ Arena.turn()        │◄───────────────────────────────────┐
   │  ├─ JSON API Agent  │                                    │
   │  ├─ LLM Inference A │                                    │
   │  ├─ LLM Inference B │                                    │
   │  └─ Bookmaker update│                                    │
   └─────────────────────┘                                    │
            │                                                  │
            │ encodeFunctionData + createRequest               │
            ▼                                                  │
   ┌─────────────────────┐                                    │
   │ Somnia Agents       │                                    │
   │ (LLM Inference,     │                                    │
   │  JSON API Request)  │                                    │
   └─────────────────────┘                                    │
                                                              │
                            BlockTick subscription ───────────┘
                            (off-chain TS, free, autonomous)
```

**No backend server. No keeper. No cron.** Frontend talks directly to chain + dreamDEX WebSocket. Arena.turn() fires from Reactivity.

## What's in this repo

```
somniaforge-agentathon/
├── README.md                          # this file
└── context/
    ├── plan/
    │   ├── coliseum.md                  # the canonical implementation plan
    │   └── coliseum-frontend.md         # the canonical frontend spec
    ├── research/
    │   ├── 01-overview.md             # Somnia Agents — what they are
    │   ├── 02-quickstart.md
    │   ├── 03-from-solidity.md        # canonical Solidity integration
    │   ├── 04-receipts.md
    │   ├── 05-custom-consensus.md
    │   ├── 06-gas-fees.md             # deposit foot-gun (read before building)
    │   ├── 07-json-api-request.md     # base agent #1
    │   ├── 08-llm-inference.md        # base agent #2 (fighter brain)
    │   ├── 09-llm-parse-website.md    # base agent #3 (unused in v1)
    │   ├── 10-examples-repo.md
    │   ├── dreamdex-overview.md       # dreamDEX mental model
    │   ├── dreamdex-contracts.md      # dreamDEX SpotPool ABI surface
    │   ├── dreamdex-apis.md           # dreamDEX HTTP + WS APIs
    │   ├── dreamdex-api.md            # dreamDEX one-page cheatsheet
    │   └── _raw/                      # raw Playwright scrapes for re-synthesis
    ├── reference/
    │   └── somnia-agents-examples-repo/   # cloned emrestay/somnia-agents-examples
    └── progress.md                    # build log + lessons + resume point
```

## Where to start (for a fresh session)

1. Read `context/plan/coliseum.md` — the whole plan in one file.
2. Read `context/plan/coliseum-frontend.md` — the whole UI spec in one file.
3. Read `context/research/dreamdex-api.md` — one-page cheatsheet for the venue.
4. Read `context/research/06-gas-fees.md` — single most important Somnia Agents gotcha (deposit floor + per_agent_price × subSize, or runners skip and request times out).
5. Read `context/progress.md` — current build status, lessons, what's next.

## Key contract addresses

### Somnia Agents
| | Mainnet | Testnet |
|---|---|---|
| Chain ID | `5031` | `50312` (Shannon) |
| RPC | `https://api.infra.mainnet.somnia.network` | `https://api.infra.testnet.somnia.network` |
| **SomniaAgents** | `0x5E5205CF39E766118C01636bED000A54D93163E6` | `0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776` |
| Receipts API | `https://receipts.mainnet.agents.somnia.host` | `https://receipts.testnet.agents.somnia.host` |
| Agent Explorer | `https://agents.somnia.network` | `https://agents.testnet.somnia.network` |

### dreamDEX (testnet — what Coliseum uses)

| Pair | SpotPool |
|---|---|
| SOMI/USDso | `0x259fD6559214dd5aD3752322426eA9F9fABEFff4` |
| WBTC/USDso | `0x3605f28aA7C50e7441211e77Cb0762d49539326C` |
| WETH/USDso | `0xD180195da5459C7a0DEA188ed61216ec43682b50` |

### Somnia Agents — confirmed agent IDs (testnet)

| Agent | ID |
|---|---|
| JSON API Request | `13174292974160097713` |
| LLM Inference | `12847293847561029384` |
| LLM Parse Website | `12875401142070969085` |

## Cost per duel (testnet)

| Item | Per duel |
|---|---|
| LLM Inference (fighters: 0.24 STT × 2 × 15 turns) | 7.2 STT |
| LLM Inference (bookmaker: 0.24 STT × 15 turns) | 3.6 STT |
| JSON API Agent (market data: 0.12 STT × 15) | 1.8 STT |
| dreamDEX gas (trades) | ~0.5 STT |
| **Total per duel** | **≈ 13 STT** |

15-day hackathon plans for ~30 dev duels + 5 demo duels = ~500 STT. Faucet-able on testnet.

## v1.1 / post-hackathon roadmap

- **SDS composability** — republish duel events to SDS so third-party dApps can build derivatives (Coliseum Index Token, fighter Elo derivatives, season prediction markets)
- **Mutation / breeding** — winner's prompt evolves based on what worked
- **User-submitted fighters** — open the registry, anyone mints a fighter NFT with their prompt
- **Tournaments + seasons** — bracket play, Elo, season prize pool
- **Mainnet migration** — flip when Reactivity goes mainnet; real USDO stakes
- **Cross-pair duels** — fighters trade all 3 dreamDEX pairs simultaneously
- **Streamer mode** — public broadcast pages with chat overlay

## Submission deliverables (per Agentathon rules)

- [x] Working prototype + deployed demo by end of program
- [ ] Public GitHub repository
- [ ] 2–5 minute demo video
- [ ] Submission form filled

## Critical Somnia Agents gotchas (read before building)

1. **`getRequestDeposit()` is NOT the full deposit.** It's only the operations-reserve floor. Pay only this and `perAgentBudget = 0` → runners skip → request times out. **Always add `per_agent_price × subSize` on top.**
2. **Always implement `receive() external payable`.** Rebates are pushed automatically; without `receive()` the transfer fails silently (`NativeTransferFailed` event) and funds get stuck.
3. **Always `require(msg.sender == platform)` in your callback.** Anyone can spoof results otherwise.
4. **Callback signature is mandatory.** `(uint256 requestId, Response[] memory responses, ResponseStatus status, Request memory details)` — name flexible, types not.
5. **Handle all three statuses**: Success / Failed / TimedOut.
6. **Majority vs Threshold consensus**: Majority for deterministic outputs (LLM with fixed seed + temp 0); Threshold for prices/RNG where results naturally differ.
7. **Avoid `threshold = subcommitteeSize`** — one failure prevents finalisation. 3 of 5 is the documented default.

(Full list and explanations in `context/research/` per-page docs.)

## Critical dreamDEX gotchas

1. **`placeOrder` can return `(false, 0)` with `tx.status == 1` and zero events.** Always check the return tuple AND verify `OrderPlaced` in logs.
2. **Raw token units everywhere on-chain.** USDso is 18 decimals — use `cast to-wei` / `parseUnits`.
3. **Builder Codes disabled in v1.0.** Pass `address(0)` + `0` for the last two args of `placeOrder` or revert with `BuilderCodesNotSupported`.
4. **Wallet funding ≠ market buy.** Market buy with `fundingSource: "wallet"` returns 400 on the REST API. Use IOC limit above best ask instead.
5. **Native pool (SOMI/USDso) needs different functions** — `depositNative()` + payable taker variant.

(Full list in `context/research/dreamdex-contracts.md`.)

## License

MIT.

---

**Built for Somnia Agentathon · May 2026 · powered by Somnia Agents + Reactivity + dreamDEX.**
