/**
 * Test 4 — Reactivity BlockTick (self-subscribing handler)
 *
 * The handler's constructor calls SomniaExtensions.subscribe() at deploy time,
 * paying with the 32 STT msg.value. One TX = deploy + fund + subscribe.
 *
 * Run: npm run test:reactivity
 */

import hre from "hardhat";
import { parseEther, formatEther } from "viem";
import "dotenv/config";

const TIMEOUT_MS = 90_000;
const TICKS_WANTED = 3;

async function main() {
  const [wallet] = await hre.viem.getWalletClients();
  const pub = await hre.viem.getPublicClient();
  const me = wallet.account.address;

  console.log("Wallet:", me);
  const bal = await pub.getBalance({ address: me });
  console.log("Balance:", formatEther(bal), "STT\n");

  if (bal < parseEther("35")) {
    throw new Error(`Need ≥35 STT. Have ${formatEther(bal)}.`);
  }

  // --- Deploy + auto-subscribe in one TX ---
  console.log("=== Deploying BlockTickHandler with 33 STT (self-subscribes in constructor) ===");
  const handler = await hre.viem.deployContract("BlockTickHandler", [], {
    value: parseEther("33"),
  });
  const handlerAddress = handler.address;
  console.log("Deployed:", handlerAddress);

  const subId = await handler.read.subscriptionId() as bigint;
  console.log("Subscription ID:", subId.toString());
  console.log(`Handler balance: ${formatEther(await pub.getBalance({ address: handlerAddress }))} STT\n`);

  // --- Watch for Ticked events ---
  console.log(`=== Watching Ticked events (want ${TICKS_WANTED}, timeout ${TIMEOUT_MS/1000}s) ===`);
  const fromBlock = await pub.getBlockNumber();
  console.log("Starting from block:", fromBlock.toString());

  let observed = 0;
  const seen = new Set<string>();
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline && observed < TICKS_WANTED) {
    const events = await handler.getEvents.Ticked({}, { fromBlock });
    for (const ev of events) {
      const args = ev.args as Record<string, unknown>;
      const blockNum = (args.blockNumber as bigint)?.toString() ?? "?";
      if (seen.has(blockNum)) continue;
      seen.add(blockNum);
      observed += 1;
      console.log(`  Tick #${observed} — block ${blockNum}, count=${(args.tickCount as bigint)?.toString()}`);
      if (observed >= TICKS_WANTED) break;
    }
    if (observed < TICKS_WANTED) {
      process.stdout.write(".");
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  const finalCount = await handler.read.tickCount() as bigint;
  const finalBlock = await handler.read.lastBlockNumber() as bigint;
  const handlerBal = await pub.getBalance({ address: handlerAddress });

  console.log(`\n\nFinal state:`);
  console.log(`  tickCount: ${finalCount.toString()}`);
  console.log(`  lastBlockNumber: ${finalBlock.toString()}`);
  console.log(`  handler balance: ${formatEther(handlerBal)} STT (started 33)`);

  if (observed >= TICKS_WANTED) {
    console.log(`\n✅ Reactivity BlockTick VERIFIED — handler invoked ${observed}+ times`);
  } else {
    console.log(`\n⚠️  Only ${observed}/${TICKS_WANTED} ticks observed`);
    console.log("    Subscription was created but handler may have reverted or sub deactivated.");
    console.log("    Check: https://shannon-explorer.somnia.network/address/" + handlerAddress);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
