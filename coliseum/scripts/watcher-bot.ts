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
//      This replaces the on-chain reactivity subscription (left deactivated to
//      avoid its every-block gas draw) for player-started fights.
//   5. Refuses to drain the deployer below DEPLOYER_MIN_STT.
//   6. Logs every action with timestamp; one-shots when WATCHER_INTERVAL_S=0.
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
  { name: "activeDuelId", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
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
  { name: "turn", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { name: "finalizeDuel", type: "function", stateMutability: "nonpayable", inputs: [{ name: "duelId", type: "uint256" }], outputs: [] },
  { name: "emergencyFinalize", type: "function", stateMutability: "nonpayable", inputs: [{ name: "duelId", type: "uint256" }], outputs: [] },
] as const;

// Turn pacing — must mirror Arena. turnIntervalBlocks is read from the manifest;
// these are fallbacks / the force-resolve window if a duel stalls mid-flight.
const DEFAULT_TURN_INTERVAL_BLOCKS = 600n;
const EMERGENCY_FINALIZE_BLOCKS = 1000n;

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

// Referee for player-started fights. The on-chain reactivity subscription is
// left deactivated (it draws gas every block), and daily-duel.ts only drives
// its own scheduled fight — so without this, a player-started duel never
// advances. Each tick: fuel the Arena if a fight is live, ring the bell
// (turn()) when the block window opens, and finalize when all moves are in,
// with a force-resolve fallback if a duel stalls.
async function driveActiveDuel(opts: {
  pub: Awaited<ReturnType<typeof hre.viem.getPublicClient>>;
  wallet: Awaited<ReturnType<typeof hre.viem.getWalletClients>>[number];
  arena: `0x${string}`;
  deployer: `0x${string}`;
  turnInterval: bigint;
  activeDuelArenaMin: bigint;
  arenaTopup: bigint;
  deployerMin: bigint;
}) {
  const { pub, wallet, arena, deployer, turnInterval, activeDuelArenaMin, arenaTopup, deployerMin } = opts;
  const emsg = (e: unknown) =>
    e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);

  const aid = (await pub.readContract({ address: arena, abi: ARENA_DUEL_ABI, functionName: "activeDuelId" })) as bigint;
  if (aid === BigInt(0)) { log("duel: no active duel"); return; }

  const raw = (await pub.readContract({ address: arena, abi: ARENA_DUEL_ABI, functionName: "duels", args: [aid] })) as readonly unknown[];
  const d = parseDuelTuple(raw);
  const total = d.turns * 2;
  const cur = await pub.getBlockNumber();
  log(`duel #${aid}: status=${d.status} callbacks=${d.completedCallbacks}/${total} lastTurnBlock=${d.lastTurnBlock} head=${cur}`);

  if (d.status === 3) { log("duel: already resolved — nothing to drive"); return; }

  // Fuel the Arena for the remaining LLM-inference moves (~0.24 STT each) before
  // ringing the bell, so turn() doesn't stall on a dry Arena.
  const arenaBal = await pub.getBalance({ address: arena });
  if (arenaBal < activeDuelArenaMin) {
    const deployerBal = await pub.getBalance({ address: deployer });
    if (deployerBal < deployerMin + arenaTopup) {
      log(`  duel-fuel: arena ${formatEther(arenaBal)} < ${formatEther(activeDuelArenaMin)} STT, but deployer floor blocks topup — skipping`);
    } else {
      log(`  duel-fuel: arena ${formatEther(arenaBal)} < ${formatEther(activeDuelArenaMin)} STT → sending ${formatEther(arenaTopup)} STT`);
      try {
        const h = await wallet.sendTransaction({ to: arena, value: arenaTopup });
        const r = await pub.waitForTransactionReceipt({ hash: h });
        log(`    duel-fuel tx=${h} status=${r.status}`);
      } catch (e) { log(`    duel-fuel failed: ${emsg(e)}`); }
    }
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

  // Mid-duel: ring the bell when the block window is open.
  if (cur >= d.lastTurnBlock + turnInterval) {
    log(`  turn window open (head ${cur} ≥ ${d.lastTurnBlock + turnInterval}) → turn()`);
    try {
      const h = await wallet.writeContract({ address: arena, abi: ARENA_DUEL_ABI, functionName: "turn", args: [] });
      const r = await pub.waitForTransactionReceipt({ hash: h });
      log(`  turn() tx=${h} status=${r.status} block=${r.blockNumber}`);
      if (r.status === "reverted" && cur >= d.lastTurnBlock + EMERGENCY_FINALIZE_BLOCKS) {
        log("  turn() reverted past emergency window → force-resolving");
        try {
          const h2 = await wallet.writeContract({ address: arena, abi: ARENA_DUEL_ABI, functionName: "emergencyFinalize", args: [aid] });
          const r2 = await pub.waitForTransactionReceipt({ hash: h2 });
          log(`  emergencyFinalize(${aid}) tx=${h2} status=${r2.status}`);
        } catch (e2) { log(`  emergencyFinalize failed: ${emsg(e2)}`); }
      }
    } catch (e) {
      log(`  turn() failed: ${emsg(e)}`);
      if (cur >= d.lastTurnBlock + EMERGENCY_FINALIZE_BLOCKS) {
        try {
          const h2 = await wallet.writeContract({ address: arena, abi: ARENA_DUEL_ABI, functionName: "emergencyFinalize", args: [aid] });
          const r2 = await pub.waitForTransactionReceipt({ hash: h2 });
          log(`  emergencyFinalize(${aid}) tx=${h2} status=${r2.status}`);
        } catch (e2) { log(`  emergencyFinalize failed: ${emsg(e2)}`); }
      }
    }
  } else {
    log(`  waiting for turn window: ${d.lastTurnBlock + turnInterval - cur} blocks left`);
  }
}

async function tick(opts: {
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
}) {
  const pub = await hre.viem.getPublicClient();
  const [wallet] = await hre.viem.getWalletClients();
  const { fallback, seeder, deployer, arena, sweepThreshold, seederMin, seederTopup, deployerMin, arenaMin, arenaTopup, turnInterval, activeDuelArenaMin } = opts;

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
    await driveActiveDuel({ pub, wallet, arena, deployer, turnInterval, activeDuelArenaMin, arenaTopup, deployerMin });
  } catch (e: unknown) {
    const msg = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
    log(`duel: drive error: ${msg}`);
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

  let running = true;
  const onSig = () => {
    log("signal received — exiting after current tick");
    running = false;
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

  const ctx = { fallback, seeder, deployer, arena, sweepThreshold, seederMin, seederTopup, deployerMin, arenaMin, arenaTopup, turnInterval, activeDuelArenaMin };

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
