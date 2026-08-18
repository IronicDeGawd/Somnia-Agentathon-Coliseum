/**
 * probe-reactivity-unsubscribe.ts — does unsubscribe actually STOP a live subscription?
 *
 * This is the load-bearing question for "subscribe while a fight runs,
 * unsubscribe when it ends". A one-shot subscription expires by itself, so it can
 * never prove cancellation works. So: arm the EVERY-BLOCK form (what Arena and
 * Bookmaker shipped), watch it burn, cancel it, and watch whether it stops.
 *
 * Also re-measures the burn rate the original decision rested on (~25.8 STT/hour).
 *
 * MEASURED 2026-08-18 on Somnia testnet: the every-block form fired ~10.5 times a
 * second and settled at ~31 STT/hour, so the original figure was right and mildly
 * conservative. After cancelling: 430 firings while running, then ZERO in the
 * following 30 seconds. Unsubscribe genuinely stops it, so gating a subscription
 * to the life of a fight is safe. (The small spend recorded after the cancel is
 * firings already in flight during the ~3 s the cancel took to land, not leakage.)
 *
 *   BURN_S=40 SETTLE_S=30 FUND=35 pnpm exec hardhat run scripts/probe-reactivity-unsubscribe.ts --network somnia
 */
import hre from "hardhat";
import { formatEther, parseEther } from "viem";

const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const burnS   = Number(process.env.BURN_S ?? "40");    // how long to let it run
  const settleS = Number(process.env.SETTLE_S ?? "30");  // how long to watch AFTER cancelling
  const fund    = process.env.FUND ?? "35";

  const pub = await hre.viem.getPublicClient();
  const spike = await hre.viem.deployContract("ReactivitySpike", [60n, 1], { value: parseEther(fund) });
  log(`spike ${spike.address} funded ${fund} STT`);

  const t0 = Date.now();
  const b0 = await pub.getBalance({ address: spike.address });
  let h = await spike.write.armEveryBlock();
  await pub.waitForTransactionReceipt({ hash: h });
  log(`armed EVERY-BLOCK, subscription ${await spike.read.subscriptionId()}`);

  const deadline = Date.now() + burnS * 1000;
  while (Date.now() < deadline) {
    await sleep(5000);
    const f = Number(await spike.read.firings());
    const bal = await pub.getBalance({ address: spike.address });
    const secs = (Date.now() - t0) / 1000;
    log(`  t+${secs.toFixed(0)}s firings=${f} spent=${formatEther(b0 - bal)} STT` +
        (secs > 0 ? `  (${((Number(formatEther(b0 - bal)) / secs) * 3600).toFixed(1)} STT/hour)` : ""));
  }

  const firedBefore = Number(await spike.read.firings());
  const balBefore   = await pub.getBalance({ address: spike.address });
  log("");
  log("cancelling…");
  h = await spike.write.stop();
  await pub.waitForTransactionReceipt({ hash: h });
  const cancelledAt = Number(await spike.read.firings());
  log(`stop() landed — firings at cancel: ${cancelledAt}`);

  // The real test: does the counter keep moving after cancelling?
  await sleep(settleS * 1000);
  const firedAfter = Number(await spike.read.firings());
  const balAfter   = await pub.getBalance({ address: spike.address });

  log("");
  log(`fired during ${burnS}s of running:  ${firedBefore}`);
  log(`fired in ${settleS}s AFTER cancel:  ${firedAfter - cancelledAt}`);
  log(`spent after cancel:               ${formatEther(balBefore - balAfter)} STT`);
  log(firedAfter - cancelledAt === 0
    ? "UNSUBSCRIBE WORKS — the subscription stopped dead. Gating by fight is safe."
    : `STILL FIRING after unsubscribe (${firedAfter - cancelledAt} more) — gating by fight is NOT safe`);

  const d = await spike.write.drain();
  await pub.waitForTransactionReceipt({ hash: d });
  log(`drained; spike balance ${formatEther(await pub.getBalance({ address: spike.address }))} STT`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
