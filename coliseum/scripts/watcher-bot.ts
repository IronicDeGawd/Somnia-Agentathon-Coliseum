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
//   4. Refuses to drain the deployer below DEPLOYER_MIN_STT.
//   5. Logs every action with timestamp; one-shots when WATCHER_INTERVAL_S=0.
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

const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (...args: unknown[]) => console.log(`[${ts()}]`, ...args);

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
}) {
  const pub = await hre.viem.getPublicClient();
  const [wallet] = await hre.viem.getWalletClients();
  const { fallback, seeder, deployer, arena, sweepThreshold, seederMin, seederTopup, deployerMin, arenaMin, arenaTopup } = opts;

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
  log(`  deployer floor   ${formatEther(deployerMin)} STT`);

  let running = true;
  const onSig = () => {
    log("signal received — exiting after current tick");
    running = false;
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

  const ctx = { fallback, seeder, deployer, arena, sweepThreshold, seederMin, seederTopup, deployerMin, arenaMin, arenaTopup };

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
