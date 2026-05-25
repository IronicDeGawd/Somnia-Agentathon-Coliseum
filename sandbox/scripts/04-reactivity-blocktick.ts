/**
 * Test 4 — Reactivity BlockTick (ON-CHAIN handler)
 *
 * BYPASSES the SDK validator (which has a bug: rejects emitter=precompile,
 * but BlockTick requires emitter=precompile). Calls the precompile directly.
 *
 * Recipe:
 *   1. Deploy BlockTickHandler (extends SomniaEventHandler)
 *   2. Fund it with ≥33 STT
 *   3. Call precompile.subscribe() with BlockTick filter
 *   4. Wait for Ticked() events from the handler
 *
 * Run: npm run test:reactivity
 */

import hre from "hardhat";
import { keccak256, toHex, parseEther, formatEther, parseGwei } from "viem";
import "dotenv/config";

const PRECOMPILE = "0x0000000000000000000000000000000000000100" as const;
const TIMEOUT_MS = 60_000;
const TICKS_WANTED = 3;

const PRECOMPILE_ABI = [
  {
    name: "subscribe",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "subscriptionData",
        type: "tuple",
        components: [
          { name: "eventTopics",             type: "bytes32[4]" },
          { name: "origin",                  type: "address" },
          { name: "caller",                  type: "address" },
          { name: "emitter",                 type: "address" },
          { name: "handlerContractAddress",  type: "address" },
          { name: "handlerFunctionSelector", type: "bytes4" },
          { name: "priorityFeePerGas",       type: "uint64" },
          { name: "maxFeePerGas",            type: "uint64" },
          { name: "gasLimit",                type: "uint64" },
          { name: "isGuaranteed",            type: "bool" },
          { name: "isCoalesced",             type: "bool" },
        ],
      },
    ],
    outputs: [{ name: "subscriptionId", type: "uint256" }],
  },
] as const;

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;

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

  // --- Step 1: Deploy handler ---
  let handlerAddress = process.env.HANDLER_ADDRESS as `0x${string}` | undefined;
  if (!handlerAddress) {
    console.log("Deploying BlockTickHandler...");
    const handler = await hre.viem.deployContract("BlockTickHandler");
    handlerAddress = handler.address;
    console.log("Deployed:", handlerAddress);
    console.log(`  (set HANDLER_ADDRESS=${handlerAddress} to reuse)\n`);
  } else {
    console.log("Reusing handler at:", handlerAddress, "\n");
  }

  // --- Step 2: Fund handler ---
  console.log("=== Step 2: Fund handler with 33 STT ===");
  const handlerBal = await pub.getBalance({ address: handlerAddress });
  console.log("Current handler balance:", formatEther(handlerBal), "STT");
  if (handlerBal < parseEther("32")) {
    const fundHash = await wallet.sendTransaction({
      to: handlerAddress, value: parseEther("33"),
    });
    await pub.waitForTransactionReceipt({ hash: fundHash });
    console.log("Funded:", fundHash);
  } else {
    console.log("  Already funded.");
  }
  console.log();

  // --- Step 3: Call precompile.subscribe() directly ---
  console.log("=== Step 3: precompile.subscribe() with BlockTick filter ===");

  const blockTickTopic = keccak256(toHex("BlockTick(uint64)"));
  console.log("  BlockTick topic:", blockTickTopic);
  console.log("  Emitter (precompile):", PRECOMPILE);

  // onEvent(address,bytes32[],bytes) selector — from SomniaEventHandler ABI
  const onEventSelector = keccak256(toHex("onEvent(address,bytes32[],bytes)")).slice(0, 10) as `0x${string}`;
  console.log("  Handler selector:", onEventSelector);

  const subscriptionData = {
    eventTopics: [blockTickTopic, ZERO_BYTES32, ZERO_BYTES32, ZERO_BYTES32] as readonly [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`],
    origin: ZERO_ADDR,
    caller: ZERO_ADDR,
    emitter: PRECOMPILE,
    handlerContractAddress: handlerAddress,
    handlerFunctionSelector: onEventSelector,
    priorityFeePerGas: parseGwei("2"),
    maxFeePerGas: parseGwei("10"),
    gasLimit: 500_000n,
    isGuaranteed: false,
    isCoalesced: false,
  };

  const subHash = await wallet.writeContract({
    address: PRECOMPILE,
    abi: PRECOMPILE_ABI,
    functionName: "subscribe",
    args: [subscriptionData],
  });
  console.log("Subscribe TX:", subHash);
  const subReceipt = await pub.waitForTransactionReceipt({ hash: subHash });
  console.log("Confirmed in block:", subReceipt.blockNumber.toString());
  console.log("Logs:", subReceipt.logs.length);
  if (subReceipt.status !== "success") {
    throw new Error("Subscribe tx reverted");
  }
  console.log("✅ Subscription is LIVE\n");

  // --- Step 4: Watch for Ticked events ---
  console.log(`=== Step 4: Watching Ticked events (want ${TICKS_WANTED}, timeout ${TIMEOUT_MS/1000}s) ===`);
  const contract = await hre.viem.getContractAt("BlockTickHandler", handlerAddress);

  const fromBlock = subReceipt.blockNumber;
  let observed = 0;
  const seen = new Set<string>();
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline && observed < TICKS_WANTED) {
    const events = await contract.getEvents.Ticked({}, { fromBlock });
    for (const ev of events) {
      const args = ev.args as Record<string, unknown>;
      const blockNum = (args.blockNumber as bigint)?.toString() ?? "?";
      if (seen.has(blockNum)) continue;
      seen.add(blockNum);
      observed += 1;
      console.log(`  Tick #${observed} — block ${blockNum}, count=${(args.tickCount as bigint)?.toString()}`);
      if (observed >= TICKS_WANTED) break;
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  const finalCount = await contract.read.tickCount() as bigint;
  console.log(`\nOn-chain tickCount: ${finalCount.toString()}`);
  console.log(`Handler balance: ${formatEther(await pub.getBalance({ address: handlerAddress }))} STT`);

  if (observed >= TICKS_WANTED) {
    console.log(`\n✅ Reactivity BlockTick VERIFIED — handler invoked ${observed}+ times`);
  } else {
    console.log(`\n⚠️  Only ${observed}/${TICKS_WANTED} ticks observed`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
