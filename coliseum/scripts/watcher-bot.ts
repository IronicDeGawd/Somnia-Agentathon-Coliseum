// ============================================================================
// SwapFallback watcher bot.
// ----------------------------------------------------------------------------
// Long-running maintenance loop:
//   1. Periodically sweeps collected STT from the SwapFallback contract into
//      the MM seeder wallet (calls owner-only sweepStt).
//   2. Tops the seeder wallet up from the deployer when its STT falls below
//      a refill threshold, so the bot can keep paying gas for resting orders.
//   3. Self-tops the Arena's STT (its LLM-inference fuel) from the deployer when
//      it falls below a threshold — each fighter move costs ~0.24 STT, drawn from
//      the Arena's balance, so duels stall if it runs dry.
//   4. Referees any live player-started duel: fuels the Arena (while a duel is
//      live), rings the bell via turn() when the block window opens, and
//      finalizes when all moves are in (force-resolve fallback on a stall).
//      With Arena's Reactivity switched off this is what drives every turn. With
//      it on, Arena books one firing per turn and this becomes the watchdog:
//      set REACTIVITY_GRACE_BLOCKS so the bot only rings the bell once a firing
//      has clearly been missed, instead of racing the chain and paying twice.
//   5. Tends the prediction desks, when any are deployed: refreshes each busy
//      desk's remembered price every tick, because a window's makers stop
//      quoting long before it expires and a desk with no price values a real
//      holding at nothing. Hands a desk back once ITS WINDOW HAS EXPIRED and no
//      fight is running, collecting anything won first — releasing merely because
//      nothing is live would free a desk claimed for a fight about to start.
//   6. Refuses to drain the deployer below DEPLOYER_MIN_STT.
//   7. Logs every action with timestamp; one-shots when WATCHER_INTERVAL_S=0.
//
// Run:
//   SEEDER_ADDRESS=0x<seeder> pnpm exec hardhat run scripts/watcher-bot.ts --network somnia
//
// Env (all amounts in STT, parsed as decimal strings):
//   SEEDER_ADDRESS       — required, MM bot wallet to fund + sweep into
//   WATCHER_INTERVAL_S   — loop interval seconds (default 60; 0 = one-shot)
//   SWEEP_THRESHOLD_STT  — sweep fallback when its STT ≥ this (default 5)
//   SEEDER_MIN_STT       — refill seeder when it drops below this (default 50)
//   SEEDER_TOPUP_STT     — STT to send per top-up (default 100)
//   ARENA_MIN_STT        — refill Arena when its STT drops below this (default 0 = OFF;
//                          daily-duel self-funds Arena fuel, subscription left to deactivate)
//   ARENA_TOPUP_STT      — STT to send the Arena per top-up (default 10)
//   DEPLOYER_MIN_STT     — never drain deployer below this (default 20)
// ============================================================================

import hre from "hardhat";
import fs from "fs";
import path from "path";
import { parseEther, formatEther, getAddress } from "viem";

const FALLBACK_ABI = [
  {
    name: "sweepStt",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }],
    outputs: [],
  },
  {
    name: "owner",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

// Arena duel-driving ABI — read state + ring the bell + finalize.
const ARENA_DUEL_ABI = [
  { name: "getActiveDuelIds", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256[]" }] },
  {
    name: "duels", type: "function", stateMutability: "view",
    inputs: [{ name: "duelId", type: "uint256" }],
    outputs: [
      { name: "fighterA", type: "uint8" }, { name: "fighterB", type: "uint8" },
      { name: "creator", type: "address" }, { name: "startBlock", type: "uint256" },
      { name: "lastTurnBlock", type: "uint256" }, { name: "completedCallbacks", type: "uint16" },
      { name: "turns", type: "uint16" }, { name: "poolMask", type: "uint8" },
      { name: "status", type: "uint8" }, { name: "initialUsdsoPerFighter", type: "uint256" },
      { name: "fundsRecovered", type: "bool" }, { name: "winnerSlot", type: "uint8" },
    ],
  },
  { name: "nextDuelId", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "turn", type: "function", stateMutability: "nonpayable", inputs: [{ name: "duelId", type: "uint256" }], outputs: [] },
  { name: "finalizeDuel", type: "function", stateMutability: "nonpayable", inputs: [{ name: "duelId", type: "uint256" }], outputs: [] },
  { name: "emergencyFinalize", type: "function", stateMutability: "nonpayable", inputs: [{ name: "duelId", type: "uint256" }], outputs: [] },
] as const;

const BOOKMAKER_ABI = [
  { name: "currentOdds", type: "function", stateMutability: "view",
    inputs: [{ name: "duelId", type: "uint256" }, { name: "index", type: "uint256" }], outputs: [{ type: "uint16" }] },
  { name: "duelSettled", type: "function", stateMutability: "view",
    inputs: [{ name: "duelId", type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "initializeOdds", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "duelId", type: "uint256" }, { name: "oddsA", type: "uint16" }, { name: "oddsB", type: "uint16" }], outputs: [] },
  { name: "settleBets", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "duelId", type: "uint256" }], outputs: [] },
] as const;

const EVENT_DESK_ABI = [
  { name: "poke", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { name: "redeemSettled", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "setInUse", type: "function", stateMutability: "nonpayable", inputs: [{ type: "bool" }], outputs: [] },
  { name: "inUse", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { name: "marketId", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { name: "pool", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  // On the bound pool, not the desk: when the window stops accepting orders.
  { name: "marketExpiryNs", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
] as const;

/** Opening line when a duel starts: even money until bets move it. */
const OPENING_ODDS_BPS = 5000;

/**
 * Duels whose settlement attempt failed for a reason retrying will not fix, so the
 * loop stops burning gas on them every tick.
 */
const settleGaveUp = new Set<string>();

/** How many recent duel ids the settle sweep inspects each tick.
 *  Raised from 5 with concurrency: several duels now resolve close together, and
 *  anything that scrolls past this window is never settled automatically. */
const SETTLE_LOOKBACK = 12;

/** Mirrors ArenaTypes.DRAW_SLOT — the duel ended level and every bet is refunded. */
const ARENA_DRAW_SLOT = 2;

/**
 * settleBets pays every winning bettor in one call. A USDso transfer costs ~95k to
 * an address that already holds some, but a first-time recipient is far more
 * expensive — a 300,000-gas transfer to a fresh wallet reverted out-of-gas where
 * eth_estimateGas asked for 1,394,609. Spectators betting for the first time are
 * exactly that case, so budget generously; unused gas is refunded.
 */
const SETTLE_GAS_LIMIT = BigInt(10_000_000);

// Turn pacing — must mirror Arena. turnIntervalBlocks is read from the manifest;
// these are fallbacks / the force-resolve window if a duel stalls mid-flight.
const DEFAULT_TURN_INTERVAL_BLOCKS = 600n;
const EMERGENCY_FINALIZE_BLOCKS = 1000n;

/** Gas floor for turn() — see the note at the call site. */
const TURN_GAS_LIMIT = BigInt(9_000_000);

/**
 * How far past a turn's due block to wait before ringing the bell ourselves.
 *
 * Zero — the default — is the old behaviour: the bot drives every turn the moment
 * it is due. With Arena's one-shot Reactivity switched on, the chain drives turns
 * instead, and racing it means paying twice for the same turn (harmless but
 * wasteful: Arena's turn is idempotent on lastTurnBlock, so whichever lands second
 * does nothing). Set this to roughly 50 blocks — about 5 s at 101 ms blocks — while
 * Reactivity is on, so the bot only steps in once a firing has clearly been missed.
 *
 * It must stay well under EMERGENCY_FINALIZE_BLOCKS, or a stalled duel would reach
 * the force-resolve window before anything tried to advance it.
 */
const REACTIVITY_GRACE_BLOCKS = BigInt(process.env.REACTIVITY_GRACE_BLOCKS ?? "0");

interface DuelState {
  lastTurnBlock: bigint;
  completedCallbacks: number;
  turns: number;
  status: number; // 1=Active 2=Finalizing 3=Resolved
  winnerSlot: number;
}

function parseDuelTuple(raw: readonly unknown[]): DuelState {
  return {
    lastTurnBlock: raw[4] as bigint,
    completedCallbacks: Number(raw[5]),
    turns: Number(raw[6]),
    status: Number(raw[8]),
    winnerSlot: Number(raw[11]),
  };
}

const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (...args: unknown[]) => console.log(`[${ts()}]`, ...args);

/**
 * Settle bets on any recently resolved duel.
 *
 * Arena drops a duel from its active set the moment it resolves, so this cannot
 * hang off the active-duel path — by the time a duel is settleable it is gone.
 * Instead sweep the last few duel ids each tick. Nothing on-chain settles bets, so
 * without this winning bettors stay unpaid until a spectator happens to press the
 * result page's button. Safe with zero bets: the payout loop is empty and the duel
 * is simply marked settled.
 */
async function settleResolvedDuels(opts: {
  pub: Awaited<ReturnType<typeof hre.viem.getPublicClient>>;
  wallet: Awaited<ReturnType<typeof hre.viem.getWalletClients>>[number];
  arena: `0x${string}`;
  bookmaker: `0x${string}` | undefined;
}) {
  const { pub, wallet, arena, bookmaker } = opts;
  if (!bookmaker) return;
  const emsg = (e: unknown) =>
    e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);

  try {
    const next = (await pub.readContract({ address: arena, abi: ARENA_DUEL_ABI, functionName: "nextDuelId" })) as bigint;
    const from = next > BigInt(SETTLE_LOOKBACK + 1) ? next - BigInt(SETTLE_LOOKBACK) : BigInt(1);
    for (let id = from; id < next; id++) {
      if (settleGaveUp.has(String(id))) continue;
      const raw = (await pub.readContract({ address: arena, abi: ARENA_DUEL_ABI, functionName: "duels", args: [id] })) as readonly unknown[];
      if (Number(raw[8]) !== 3) continue;              // not resolved
      // A drawn duel IS settleable — Bookmaker refunds every bettor their stake
      // (Bookmaker.sol:412). This used to skip anything above slot 1 because
      // settleBets did revert on a draw back then; the draw work changed that,
      // and the stale guard meant every drawn duel was permanently abandoned
      // with its bettors unpaid. Draws are not rare: two fighters that both sit
      // out end exactly level.
      const slot = Number(raw[11]);
      if (slot > 1 && slot !== ARENA_DRAW_SLOT) {
        settleGaveUp.add(String(id));   // genuinely unsettleable (winner unset)
        continue;
      }
      const settled = (await pub.readContract({
        address: bookmaker, abi: BOOKMAKER_ABI, functionName: "duelSettled", args: [id],
      })) as boolean;
      if (settled) { settleGaveUp.add(String(id)); continue; }
      try {
        const h = await wallet.writeContract({
          address: bookmaker, abi: BOOKMAKER_ABI, functionName: "settleBets", args: [id], gas: SETTLE_GAS_LIMIT,
        });
        const r = await pub.waitForTransactionReceipt({ hash: h });
        log(`  settleBets(${id}) tx=${h} status=${r.status}`);
        if (r.status === "reverted") settleGaveUp.add(String(id));
      } catch (e) {
        const msg = emsg(e);
        log(`  settleBets(${id}) failed: ${msg}`);
        if (/AlreadySettled|InvalidWinner|DuelInactive/.test(msg)) settleGaveUp.add(String(id));
      }
    }
  } catch (e) { log(`  settle sweep failed: ${emsg(e)}`); }
}

// Referee for player-started fights. The on-chain reactivity subscription is
// left deactivated (it draws gas every block), and daily-duel.ts only drives
// its own scheduled fight — so without this, a player-started duel never
// advances. Each tick: fuel the Arena if a fight is live, ring the bell
// (turn()) when the block window opens, and finalize when all moves are in,
// with a force-resolve fallback if a duel stalls.
//
// Arena runs up to maxActiveDuels fights at once, so this drives every one of
// them. Fuel is checked ONCE for the whole set, against a floor scaled by how
// many duels are running: they all spend inference out of the same STT balance,
// and a dry Arena fails soft — every move becomes Hold, and an all-Hold duel now
// resolves as a draw. Silently drawing several fights at once is the failure
// this guard exists to prevent.
/**
 * Keep every desk currently serving a fight remembering a real price.
 *
 * A prediction window's makers stop quoting well before it expires, so its book
 * empties while the contract is still perfectly tradable. A desk looking at an
 * empty book has no price to report, and Arena would value a real holding at
 * nothing for the whole tail of a fight — turning a winning position into a
 * scoreless one. Each desk remembers the last real top-of-book it saw, and this
 * is what refreshes that memory while quotes still exist.
 *
 * Cheap and permissionless: it only ever writes the desk's own last-seen price.
 */
async function pokeDesksInUse(opts: {
  pub: Awaited<ReturnType<typeof hre.viem.getPublicClient>>;
  wallet: Awaited<ReturnType<typeof hre.viem.getWalletClients>>[number];
  desks: readonly `0x${string}`[];
}) {
  const { pub, wallet, desks } = opts;
  const emsg = (e: unknown) =>
    e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);

  for (const desk of desks) {
    try {
      const inUse = (await pub.readContract({
        address: desk, abi: EVENT_DESK_ABI, functionName: "inUse",
      })) as boolean;
      if (!inUse) continue;
      const hash = await wallet.writeContract({
        address: desk, abi: EVENT_DESK_ABI, functionName: "poke",
      });
      await pub.waitForTransactionReceipt({ hash });
      log(`  desk ${desk}: price memory refreshed`);
    } catch (e) {
      // A desk that cannot be poked is not a reason to stop refereeing.
      log(`  desk ${desk}: poke failed: ${emsg(e)}`);
    }
  }
}

/**
 * Hand back desks whose window is over.
 *
 * A desk is claimed so nothing can re-point it mid-fight, and only releasing it
 * allows that. But "no fight is running" is NOT enough on its own: a desk is
 * claimed a little before its fight starts, and releasing it in that gap would
 * let something re-point it under the fight about to begin. So a desk is only
 * freed once its own window has EXPIRED, which no fight can use anyway. A window
 * still alive needs no releasing — the next fight simply reuses it.
 *
 * Collecting first matters: a won position pays nothing until it is claimed, and
 * a desk released with an uncollected win carries that money into its next
 * binding, where it silently becomes the next fight's float. Claiming is
 * attempted but not required — a losing position is worth nothing and the claims
 * registry may refuse it outright, which must not strand the desk.
 */
async function releaseIdleDesks(opts: {
  pub: Awaited<ReturnType<typeof hre.viem.getPublicClient>>;
  wallet: Awaited<ReturnType<typeof hre.viem.getWalletClients>>[number];
  desks: readonly `0x${string}`[];
}) {
  const { pub, wallet, desks } = opts;
  const emsg = (e: unknown) =>
    e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
  const nowNs = BigInt(Math.floor(Date.now() / 1000)) * 1_000_000_000n;

  for (const desk of desks) {
    try {
      const inUse = (await pub.readContract({
        address: desk, abi: EVENT_DESK_ABI, functionName: "inUse",
      })) as boolean;
      if (!inUse) continue;

      const pool = (await pub.readContract({
        address: desk, abi: EVENT_DESK_ABI, functionName: "pool",
      })) as `0x${string}`;
      const expiryNs = (await pub.readContract({
        address: pool, abi: EVENT_DESK_ABI, functionName: "marketExpiryNs",
      })) as bigint;
      if (expiryNs > nowNs) {
        const left = Number((expiryNs - nowNs) / 1_000_000_000n);
        log(`  desk ${desk}: window still open for ${left}s — keeping it claimed`);
        continue;
      }

      try {
        const claim = await wallet.writeContract({
          address: desk, abi: EVENT_DESK_ABI, functionName: "redeemSettled",
        });
        await pub.waitForTransactionReceipt({ hash: claim });
      } catch (e) {
        log(`  desk ${desk}: nothing collectable (${emsg(e)})`);
      }

      const hash = await wallet.writeContract({
        address: desk, abi: EVENT_DESK_ABI, functionName: "setInUse", args: [false],
      });
      await pub.waitForTransactionReceipt({ hash });
      log(`  desk ${desk}: released`);
    } catch (e) {
      log(`  desk ${desk}: release failed: ${emsg(e)}`);
    }
  }
}

/**
 * Ask the fuel pot to convert collected fees into the coin that pays for the
 * fighters' thinking, and report the Arena's balance afterwards.
 *
 * Why this runs BEFORE the wallet top-up below it: the entry fee is priced to cover
 * the thinking and collects six to eleven times what it costs, but it arrives as
 * stablecoin while inference is billed in the chain's own coin. For months it could
 * not reach what it was named for, and this bot covered the gap from the operator's
 * wallet. The pot converts. Trying it first is the difference between a system that
 * is self-funding and one that merely looks it.
 *
 * The gas limit is EXPLICIT and large. The venue does not fail quietly when short of
 * gas — it reverts carrying its own requirement, measured at 2,862,641 — and only
 * 63/64ths is forwarded per nesting level, so an estimate made through the pot's
 * internal catch converges far too low. Measured: refused at four million, filled at
 * twelve.
 *
 * Never throws. A pot that cannot buy must not stop a fight being refereed.
 */
async function tryRefuel(
  pub: Awaited<ReturnType<typeof hre.viem.getPublicClient>>,
  wallet: Awaited<ReturnType<typeof hre.viem.getWalletClients>>[number],
  arena: `0x${string}`,
  current: bigint,
): Promise<bigint> {
  const pot = process.env.FUEL_POT as `0x${string}` | undefined;
  if (!pot) return current;
  try {
    const h = await wallet.writeContract({
      address: pot,
      abi: [{ name: "refuel", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint256" }] }] as const,
      functionName: "refuel",
      gas: BigInt(process.env.FUEL_GAS ?? 12_000_000),
    });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    const after = await pub.getBalance({ address: arena });
    log(`  fuel-pot: refuel tx=${h} status=${r.status} arena ${formatEther(current)} -> ${formatEther(after)} STT`);
    if (after <= current) log(`    fuel-pot bought nothing this round — falling back to the operator wallet`);
    return after;
  } catch (e) {
    const m = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
    log(`  fuel-pot: refuel failed (${m}) — falling back to the operator wallet`);
    return current;
  }
}

async function driveActiveDuels(opts: {
  bookmaker: `0x${string}` | undefined;
  pub: Awaited<ReturnType<typeof hre.viem.getPublicClient>>;
  wallet: Awaited<ReturnType<typeof hre.viem.getWalletClients>>[number];
  arena: `0x${string}`;
  deployer: `0x${string}`;
  turnInterval: bigint;
  activeDuelArenaMin: bigint;
  arenaTopup: bigint;
  deployerMin: bigint;
}) {
  const { pub, wallet, arena, deployer, activeDuelArenaMin, arenaTopup, deployerMin } = opts;
  const emsg = (e: unknown) =>
    e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);

  const ids = (await pub.readContract({
    address: arena, abi: ARENA_DUEL_ABI, functionName: "getActiveDuelIds",
  })) as readonly bigint[];

  if (ids.length === 0) { log("duel: no active duel"); return; }
  log(`duel: ${ids.length} active — ${ids.join(", ")}`);

  // Fuel for the whole set before ringing any bell.
  const need = activeDuelArenaMin * BigInt(ids.length);
  let arenaBal = await pub.getBalance({ address: arena });

  // FIRST ask the pot to buy fuel with the entry fees it has already collected.
  //
  // The fee is priced to cover the fighters' thinking and comes in at six to
  // eleven times what the thinking costs — but it arrives as stablecoin while
  // inference is billed in the chain's own coin, so for months it could not reach
  // what it was named for and this bot topped the Arena up from the operator's
  // wallet instead. The pot converts. Trying it before falling back to the wallet
  // is what makes the system self-funding rather than merely look it.
  //
  // Best-effort in every direction: no pot configured, an empty pot, a market with
  // nobody offering — all just fall through to the wallet as before.
  if (arenaBal < need) {
    arenaBal = await tryRefuel(pub, wallet, arena, arenaBal);
  }

  if (arenaBal < need) {
    const topup = arenaTopup * BigInt(ids.length);
    const deployerBal = await pub.getBalance({ address: deployer });
    if (deployerBal < deployerMin + topup) {
      log(`  duel-fuel: arena ${formatEther(arenaBal)} < ${formatEther(need)} STT for ${ids.length} duel(s), but deployer floor blocks topup — skipping turns to avoid silent all-Hold draws`);
      return;
    }
    log(`  duel-fuel: arena ${formatEther(arenaBal)} < ${formatEther(need)} STT → sending ${formatEther(topup)} STT`);
    try {
      const h = await wallet.sendTransaction({ to: arena, value: topup });
      const r = await pub.waitForTransactionReceipt({ hash: h });
      log(`    duel-fuel tx=${h} status=${r.status}`);
    } catch (e) { log(`    duel-fuel failed: ${emsg(e)}`); }
  }

  for (const id of ids) {
    try {
      await driveDuel(id, opts);
    } catch (e) {
      // One stuck duel must not stop the others from being refereed.
      log(`  duel #${id}: drive failed: ${emsg(e)}`);
    }
  }
}

async function driveDuel(aid: bigint, opts: {
  bookmaker: `0x${string}` | undefined;
  pub: Awaited<ReturnType<typeof hre.viem.getPublicClient>>;
  wallet: Awaited<ReturnType<typeof hre.viem.getWalletClients>>[number];
  arena: `0x${string}`;
  deployer: `0x${string}`;
  turnInterval: bigint;
  activeDuelArenaMin: bigint;
  arenaTopup: bigint;
  deployerMin: bigint;
}) {
  const { pub, wallet, arena, bookmaker, turnInterval } = opts;
  const emsg = (e: unknown) =>
    e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);

  const raw = (await pub.readContract({ address: arena, abi: ARENA_DUEL_ABI, functionName: "duels", args: [aid] })) as readonly unknown[];
  const d = parseDuelTuple(raw);
  const total = d.turns * 2;
  const cur = await pub.getBlockNumber();
  log(`duel #${aid}: status=${d.status} callbacks=${d.completedCallbacks}/${total} lastTurnBlock=${d.lastTurnBlock} head=${cur}`);

  if (d.status === 3) { log("duel: already resolved — nothing to drive"); return; }

  // Open the betting line as soon as the duel is live. placeBet reverts DuelInactive
  // while currentOdds is zero, so without this no spectator can bet at all — and the
  // window closes the moment the Arena leaves Active.
  if (bookmaker && d.status === 1) {
    try {
      const oddsA = (await pub.readContract({
        address: bookmaker, abi: BOOKMAKER_ABI, functionName: "currentOdds", args: [aid, BigInt(0)],
      })) as number;
      const oddsB = (await pub.readContract({
        address: bookmaker, abi: BOOKMAKER_ABI, functionName: "currentOdds", args: [aid, BigInt(1)],
      })) as number;
      if (oddsA === 0 && oddsB === 0) {
        const h = await wallet.writeContract({
          address: bookmaker, abi: BOOKMAKER_ABI, functionName: "initializeOdds",
          args: [aid, OPENING_ODDS_BPS, OPENING_ODDS_BPS],
        });
        const r = await pub.waitForTransactionReceipt({ hash: h });
        log(`  initializeOdds(${aid}, 50/50) tx=${h} status=${r.status} — betting open`);
      }
    } catch (e) { log(`  initializeOdds(${aid}) failed: ${emsg(e)}`); }
  }

  // All moves in (or chain marked Finalizing) → finalize, with force-resolve fallback.
  if (d.completedCallbacks >= total || d.status === 2) {
    try {
      const h = await wallet.writeContract({ address: arena, abi: ARENA_DUEL_ABI, functionName: "finalizeDuel", args: [aid] });
      const r = await pub.waitForTransactionReceipt({ hash: h });
      log(`  finalizeDuel(${aid}) tx=${h} status=${r.status}`);
    } catch (e) {
      log(`  finalizeDuel failed: ${emsg(e)}`);
      if (cur >= d.lastTurnBlock + EMERGENCY_FINALIZE_BLOCKS) {
        try {
          const h2 = await wallet.writeContract({ address: arena, abi: ARENA_DUEL_ABI, functionName: "emergencyFinalize", args: [aid] });
          const r2 = await pub.waitForTransactionReceipt({ hash: h2 });
          log(`  emergencyFinalize(${aid}) tx=${h2} status=${r2.status}`);
        } catch (e2) { log(`  emergencyFinalize failed: ${emsg(e2)}`); }
      }
    }
    return;
  }

  // Mid-duel: ring the bell when the block window is open, plus whatever grace
  // period is configured for Reactivity to get there first.
  const dueAt = d.lastTurnBlock + turnInterval + REACTIVITY_GRACE_BLOCKS;
  if (cur >= dueAt) {
    log(`  turn window open (head ${cur} ≥ ${dueAt}) → turn()`);
    try {
      // Explicit floor rather than estimation. A real-market turn can reach
      // dreamDEX's native-payout guard, which needs ~5M gas of headroom to still
      // be there when the pool transfers SOMI; because Somnia only forwards 63/64
      // of remaining gas into each nested call, an estimated limit can leave the
      // guard just short and the fighter's order reverts for no visible reason.
      // Unused gas is refunded, so over-providing costs nothing.
      const h = await wallet.writeContract({ address: arena, abi: ARENA_DUEL_ABI, functionName: "turn", args: [aid], gas: TURN_GAS_LIMIT });
      const r = await pub.waitForTransactionReceipt({ hash: h });
      log(`  turn(${aid}) tx=${h} status=${r.status} block=${r.blockNumber}`);
      if (r.status === "reverted" && cur >= d.lastTurnBlock + EMERGENCY_FINALIZE_BLOCKS) {
        log(`  turn(${aid}) reverted past emergency window → force-resolving`);
        try {
          const h2 = await wallet.writeContract({ address: arena, abi: ARENA_DUEL_ABI, functionName: "emergencyFinalize", args: [aid] });
          const r2 = await pub.waitForTransactionReceipt({ hash: h2 });
          log(`  emergencyFinalize(${aid}) tx=${h2} status=${r2.status}`);
        } catch (e2) { log(`  emergencyFinalize failed: ${emsg(e2)}`); }
      }
    } catch (e) {
      log(`  turn(${aid}) failed: ${emsg(e)}`);
      if (cur >= d.lastTurnBlock + EMERGENCY_FINALIZE_BLOCKS) {
        try {
          const h2 = await wallet.writeContract({ address: arena, abi: ARENA_DUEL_ABI, functionName: "emergencyFinalize", args: [aid] });
          const r2 = await pub.waitForTransactionReceipt({ hash: h2 });
          log(`  emergencyFinalize(${aid}) tx=${h2} status=${r2.status}`);
        } catch (e2) { log(`  emergencyFinalize failed: ${emsg(e2)}`); }
      }
    }
  } else {
    log(`  waiting for turn window: ${dueAt - cur} blocks left`);
  }
}

async function tick(opts: {
  bookmaker: `0x${string}` | undefined;
  fallback: `0x${string}`;
  seeder: `0x${string}`;
  deployer: `0x${string}`;
  arena: `0x${string}`;
  sweepThreshold: bigint;
  seederMin: bigint;
  seederTopup: bigint;
  deployerMin: bigint;
  arenaMin: bigint;
  arenaTopup: bigint;
  turnInterval: bigint;
  activeDuelArenaMin: bigint;
  desks: readonly `0x${string}`[];
}) {
  const pub = await hre.viem.getPublicClient();
  const [wallet] = await hre.viem.getWalletClients();
  const { fallback, seeder, deployer, arena, bookmaker, sweepThreshold, seederMin, seederTopup, deployerMin, arenaMin, arenaTopup, turnInterval, activeDuelArenaMin, desks } = opts;

  const [fbBal, seederBal, deployerBal, arenaBal] = await Promise.all([
    pub.getBalance({ address: fallback }),
    pub.getBalance({ address: seeder }),
    pub.getBalance({ address: deployer }),
    pub.getBalance({ address: arena }),
  ]);
  log(
    `balances: fallback=${formatEther(fbBal)} STT  seeder=${formatEther(seederBal)} STT  ` +
    `arena=${formatEther(arenaBal)} STT  deployer=${formatEther(deployerBal)} STT`,
  );

  // 1. Sweep fallback → seeder if above threshold.
  if (fbBal >= sweepThreshold) {
    log(`sweep: fallback holds ${formatEther(fbBal)} ≥ ${formatEther(sweepThreshold)} STT → sweepStt(${seeder})`);
    try {
      const hash = await wallet.writeContract({
        address: fallback,
        abi: FALLBACK_ABI,
        functionName: "sweepStt",
        args: [seeder],
      });
      const r = await pub.waitForTransactionReceipt({ hash });
      log(`  sweep tx=${hash} status=${r.status} block=${r.blockNumber}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
      log(`  sweep failed: ${msg}`);
    }
  } else {
    log(`sweep: skip (fallback ${formatEther(fbBal)} < ${formatEther(sweepThreshold)} STT)`);
  }

  // 2. Top up seeder from deployer if seeder is low.
  if (seederBal < seederMin) {
    if (deployerBal < deployerMin + seederTopup) {
      log(
        `topup: seeder ${formatEther(seederBal)} < ${formatEther(seederMin)} STT, ` +
        `but deployer ${formatEther(deployerBal)} would drop below floor ${formatEther(deployerMin)} ` +
        `if we send ${formatEther(seederTopup)} STT. Skipping.`,
      );
    } else {
      log(`topup: seeder ${formatEther(seederBal)} < ${formatEther(seederMin)} STT → sending ${formatEther(seederTopup)} STT to ${seeder}`);
      try {
        const hash = await wallet.sendTransaction({ to: seeder, value: seederTopup });
        const r = await pub.waitForTransactionReceipt({ hash });
        log(`  topup tx=${hash} status=${r.status} block=${r.blockNumber}`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
        log(`  topup failed: ${msg}`);
      }
    }
  } else {
    log(`topup: skip (seeder ${formatEther(seederBal)} ≥ ${formatEther(seederMin)} STT)`);
  }

  // 3. Self-top the Arena's LLM-inference fuel from the deployer when low.
  if (arenaBal < arenaMin) {
    if (deployerBal < deployerMin + arenaTopup) {
      log(
        `arena: ${formatEther(arenaBal)} < ${formatEther(arenaMin)} STT, but deployer ${formatEther(deployerBal)} ` +
        `would drop below floor ${formatEther(deployerMin)} if we send ${formatEther(arenaTopup)} STT. Skipping.`,
      );
    } else {
      log(`arena: ${formatEther(arenaBal)} < ${formatEther(arenaMin)} STT → sending ${formatEther(arenaTopup)} STT to ${arena}`);
      try {
        const hash = await wallet.sendTransaction({ to: arena, value: arenaTopup });
        const r = await pub.waitForTransactionReceipt({ hash });
        log(`  arena topup tx=${hash} status=${r.status} block=${r.blockNumber}`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
        log(`  arena topup failed: ${msg}`);
      }
    }
  } else {
    log(`arena: skip (${formatEther(arenaBal)} ≥ ${formatEther(arenaMin)} STT)`);
  }

  // 4. Referee any live player-started duel: fuel + ring the bell + finalize.
  try {
    await driveActiveDuels({ pub, wallet, arena, bookmaker, deployer, turnInterval, activeDuelArenaMin, arenaTopup, deployerMin });
    await settleResolvedDuels({ pub, wallet, arena, bookmaker });
  } catch (e: unknown) {
    const msg = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
    log(`duel: drive error: ${msg}`);
  }

  // 5. Prediction desks: keep prices fresh while a fight runs, hand them back
  //    once none does. Both are keyed on whether anything is live at all, which
  //    is why this sits after the duels have been driven and settled.
  if (desks.length) {
    try {
      const stillRunning = (await pub.readContract({
        address: arena, abi: ARENA_DUEL_ABI, functionName: "getActiveDuelIds",
      })) as readonly bigint[];
      if (stillRunning.length) await pokeDesksInUse({ pub, wallet, desks });
      else await releaseIdleDesks({ pub, wallet, desks });
    } catch (e: unknown) {
      const msg = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
      log(`desks: ${msg}`);
    }
  }
}

async function main() {
  const network = hre.network.name;
  log(`Watcher bot starting — network: ${network}`);

  const seederRaw = process.env.SEEDER_ADDRESS;
  if (!seederRaw) {
    throw new Error("SEEDER_ADDRESS is required (the MM bot wallet to sweep into / top up).");
  }
  const seeder = getAddress(seederRaw) as `0x${string}`;

  const manifestPath = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No deployment manifest at deployments/${network}.json — deploy SwapFallback first.`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const fallback = manifest?.contracts?.SwapFallback?.address as `0x${string}` | undefined;
  if (!fallback) {
    throw new Error("SwapFallback address missing from manifest. Deploy it with scripts/deploy-swap-fallback.ts.");
  }
  const arena = manifest?.contracts?.Arena?.address as `0x${string}` | undefined;
  if (!arena) {
    throw new Error("Arena address missing from manifest.");
  }
  const turnInterval = BigInt(manifest?.contracts?.Arena?.turnIntervalBlocks ?? DEFAULT_TURN_INTERVAL_BLOCKS);
  // Optional: without it the watcher still referees duels, it just cannot open or
  // settle the betting line.
  const bookmaker = manifest?.contracts?.Bookmaker?.address as `0x${string}` | undefined;
  // Optional: only present once the prediction desks are deployed. Without them
  // the watcher behaves exactly as before.
  const desks = (manifest?.contracts?.EventDesks?.desks ?? []) as readonly `0x${string}`[];

  const intervalS = parseInt(process.env.WATCHER_INTERVAL_S ?? "60", 10);
  const sweepThreshold = parseEther(process.env.SWEEP_THRESHOLD_STT ?? "5");
  const seederMin = parseEther(process.env.SEEDER_MIN_STT ?? "50");
  const seederTopup = parseEther(process.env.SEEDER_TOPUP_STT ?? "100");
  // Default 0 = DISABLED. The Arena's every-block reactivity subscription burns
  // STT continuously while funded, so we deliberately let the Arena drain to
  // ~0 and the subscription deactivate (stops the idle burn). daily-duel.ts
  // self-funds the Arena's LLM fuel just-in-time at the start of each run.
  // Set ARENA_MIN_STT>0 only to re-enable continuous topup.
  const arenaMin = parseEther(process.env.ARENA_MIN_STT ?? "0");
  const arenaTopup = parseEther(process.env.ARENA_TOPUP_STT ?? "10");
  const deployerMin = parseEther(process.env.DEPLOYER_MIN_STT ?? "20");
  // Arena STT floor enforced ONLY while a duel is live (each move ~0.24 STT).
  // Unlike ARENA_MIN_STT this doesn't cause idle burn — it only tops up when
  // there is an active duel to fuel.
  const activeDuelArenaMin = parseEther(process.env.ACTIVE_DUEL_ARENA_MIN ?? "2");

  const [wallet] = await hre.viem.getWalletClients();
  const deployer = wallet.account.address;

  // Verify the deployer is the SwapFallback owner — if not, sweepStt will revert.
  const pub = await hre.viem.getPublicClient();
  const onchainOwner = (await pub.readContract({
    address: fallback,
    abi: FALLBACK_ABI,
    functionName: "owner",
  })) as `0x${string}`;
  if (getAddress(onchainOwner) !== getAddress(deployer)) {
    throw new Error(
      `Deployer ${deployer} is not the SwapFallback owner (${onchainOwner}). ` +
      `sweepStt would revert. Run from the owning key.`,
    );
  }

  log(`config:`);
  log(`  SwapFallback     ${fallback}`);
  log(`  Arena            ${arena}`);
  log(`  seeder           ${seeder}`);
  log(`  deployer         ${deployer}`);
  log(`  interval         ${intervalS === 0 ? "one-shot" : `${intervalS}s`}`);
  log(`  sweep threshold  ${formatEther(sweepThreshold)} STT`);
  log(`  seeder min       ${formatEther(seederMin)} STT`);
  log(`  seeder topup     ${formatEther(seederTopup)} STT`);
  log(`  arena min        ${formatEther(arenaMin)} STT`);
  log(`  arena topup      ${formatEther(arenaTopup)} STT`);
  log(`  active-duel fuel ${formatEther(activeDuelArenaMin)} STT (floor while a duel is live)`);
  log(`  turn interval    ${turnInterval} blocks`);
  log(`  deployer floor   ${formatEther(deployerMin)} STT`);
  log(`  event desks      ${desks.length ? `${desks.length} known` : "none — event fights not deployed"}`);

  let running = true;
  const onSig = () => {
    log("signal received — exiting after current tick");
    running = false;
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

  const ctx = { fallback, seeder, deployer, arena, bookmaker, sweepThreshold, seederMin, seederTopup, deployerMin, arenaMin, arenaTopup, turnInterval, activeDuelArenaMin, desks };

  if (intervalS === 0) {
    await tick(ctx);
    return;
  }

  while (running) {
    try {
      await tick(ctx);
    } catch (e: unknown) {
      const msg = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
      log(`tick error: ${msg}`);
    }
    if (!running) break;
    await new Promise<void>((r) => setTimeout(r, intervalS * 1000));
  }
  log("watcher stopped");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
