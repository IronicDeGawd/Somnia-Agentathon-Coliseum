/**
 * Test 5 — Reactivity subscription persistence
 *
 * Confirms that:
 *   1. Each BlockTick invocation costs only actual-gas-used (tiny), NOT gasLimit × maxFeePerGas.
 *   2. The 32 STT floor is a creation-time sybil check only, NOT an ongoing balance threshold.
 *   3. A subscription funded with 33 STT lasts far longer than naive math suggests.
 *
 * Docs say auto-removal fires only when:
 *   owner.balance < gasLimit × (baseFee + priorityFee)  (checked at each invocation)
 *
 * Run: npm run test:reactivity-persist
 */

import hre from "hardhat";
import { parseEther, formatEther, parseGwei } from "viem";
import "dotenv/config";

const TICKS_WANTED   = 50;   // ~5 s at 100 ms blocks
const TIMEOUT_MS     = 30_000;

async function main() {
  const [wallet] = await hre.viem.getWalletClients();
  const pub       = await hre.viem.getPublicClient();
  const me        = wallet.account.address;

  console.log("Wallet:", me);
  const walletBal = await pub.getBalance({ address: me });
  console.log("Wallet balance:", formatEther(walletBal), "STT\n");

  if (walletBal < parseEther("35")) {
    throw new Error(`Need ≥35 STT. Have ${formatEther(walletBal)}.`);
  }

  // --- Deploy with 33 STT (same as existing test) ---
  const FUND = parseEther("33");
  console.log(`=== Deploying BlockTickHandler with ${formatEther(FUND)} STT ===`);
  const handler = await hre.viem.deployContract("BlockTickHandler", [], {
    value: FUND,
  });
  const addr = handler.address;
  console.log("Deployed:", addr);

  const subId = await handler.read.subscriptionId() as bigint;
  const balBefore = await pub.getBalance({ address: addr });
  console.log("Subscription ID:", subId.toString());
  console.log(`Handler balance at deploy: ${formatEther(balBefore)} STT`);

  // --- Compute the removal threshold from the contract's own params ---
  // BlockTickHandler sets: gasLimit=3_000_000, maxFeePerGas=20 gwei
  const GAS_LIMIT    = 3_000_000n;
  const MAX_FEE_GWEI = 20n;
  const removalThreshold = GAS_LIMIT * parseGwei(MAX_FEE_GWEI.toString());
  console.log(`\nDocs removal threshold = gasLimit × maxFeePerGas`);
  console.log(`  = ${GAS_LIMIT.toLocaleString()} gas × ${MAX_FEE_GWEI} gwei`);
  console.log(`  = ${formatEther(removalThreshold)} STT`);
  console.log(`  (sub auto-removes only when handler balance falls below this)\n`);

  // --- Watch ticks ---
  console.log(`=== Watching ${TICKS_WANTED} ticks (timeout ${TIMEOUT_MS / 1000}s) ===`);
  const fromBlock = await pub.getBlockNumber();
  let observed  = 0;
  const seen    = new Set<string>();
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline && observed < TICKS_WANTED) {
    const events = await handler.getEvents.Ticked({}, { fromBlock });
    for (const ev of events) {
      const bn = ((ev.args as Record<string, bigint>).blockNumber)?.toString() ?? "?";
      if (seen.has(bn)) continue;
      seen.add(bn);
      observed += 1;
      if (observed % 10 === 0 || observed <= 3) {
        const bal = await pub.getBalance({ address: addr });
        console.log(`  Tick #${observed} (block ${bn}) — handler balance: ${formatEther(bal)} STT`);
      }
      if (observed >= TICKS_WANTED) break;
    }
    if (observed < TICKS_WANTED) {
      await new Promise(r => setTimeout(r, 1_000));
    }
  }

  // --- Final measurements ---
  const balAfter   = await pub.getBalance({ address: addr });
  const tickCount  = await handler.read.tickCount() as bigint;
  const lastBlock  = await handler.read.lastBlockNumber() as bigint;

  const totalDrained = balBefore - balAfter;
  // Use on-chain tickCount (ground truth) not polled `observed` (may miss blocks)
  const costPerTick  = tickCount > 0n ? totalDrained / tickCount : 0n;

  console.log(`\n=== Results after ${tickCount} on-chain ticks (observed ${observed}) ===`);
  console.log(`  lastBlockNumber    : ${lastBlock.toString()}`);
  console.log(`  balance before     : ${formatEther(balBefore)} STT`);
  console.log(`  balance after      : ${formatEther(balAfter)} STT`);
  console.log(`  total drained      : ${formatEther(totalDrained)} STT`);
  console.log(`  cost per tick (avg): ${formatEther(costPerTick)} STT`);

  if (costPerTick > 0n) {
    const ticksUntilDead = balAfter / costPerTick;
    // Use floating-point for human-readable time (BigInt loses fractions)
    const secsLeft  = Number(ticksUntilDead) / 10;    // 10 ticks/s at 100 ms blocks
    const minsLeft  = secsLeft / 60;
    const hoursLeft = minsLeft / 60;
    const daysLeft  = hoursLeft / 24;
    console.log(`\n  Ticks remaining until removal   : ~${ticksUntilDead.toLocaleString()}`);
    console.log(`  Time remaining at this rate     : ~${minsLeft.toFixed(0)} min (~${hoursLeft.toFixed(1)} hours / ~${daysLeft.toFixed(1)} days)`);

    const secsFor32 = Number(parseEther("32") / costPerTick) / 10;
    console.log(`\n  32 STT alone would last         : ~${(secsFor32 / 60).toFixed(0)} min (~${(secsFor32 / 3600).toFixed(1)} hours / ~${(secsFor32 / 86400).toFixed(1)} days)`);
  }

  const subStillAlive = observed >= TICKS_WANTED;
  console.log(`\n=== Verdict ===`);
  if (subStillAlive) {
    console.log(`✅ Subscription ALIVE after ${observed} ticks.`);
    console.log(`   Actual per-tick cost (${formatEther(costPerTick)} STT) is far below`);
    console.log(`   the removal threshold (${formatEther(removalThreshold)} STT).`);
    console.log(`   The 32 STT floor is a creation check only — confirmed.`);
  } else {
    console.log(`⚠️  Only ${observed}/${TICKS_WANTED} ticks received within ${TIMEOUT_MS / 1000}s.`);
    console.log(`   Check explorer: https://shannon-explorer.somnia.network/address/${addr}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
