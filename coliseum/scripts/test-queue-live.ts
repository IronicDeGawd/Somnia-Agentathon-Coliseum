/**
 * Live test of the deployed Matchmaker queue path (single wallet):
 *   approve -> queue(fighter, 3) -> getSlot -> cancelQueue -> getSlot
 * Proves deposit pull, slot occupancy, and refund work on-chain.
 * A full match needs a 2nd funded wallet; this verifies the entry/exit path.
 */
import hre from "hardhat";
import { formatUnits } from "viem";

const MM      = "0x92ddaca48f65586e9d8c117ae4252813e120a157";
const USDSO   = "0x9c32F3827A1a99f0cf9B213de8b53eC3d57bb171";
const TIER    = 3;   // tier-3 = cheapest (~0.95 USDso)
const FIGHTER = 0;   // The Degen

const MM_ABI = [
  { name: "halfDeposit", type: "function", stateMutability: "view", inputs: [{ type: "uint16" }], outputs: [{ type: "uint256" }] },
  { name: "getSlot", type: "function", stateMutability: "view", inputs: [{ type: "uint16" }],
    outputs: [{ name: "player", type: "address" }, { name: "fighter", type: "uint8" }, { name: "deposit", type: "uint256" }, { name: "queuedBlock", type: "uint64" }] },
  { name: "queue", type: "function", stateMutability: "nonpayable", inputs: [{ type: "uint8" }, { type: "uint16" }], outputs: [] },
  { name: "cancelQueue", type: "function", stateMutability: "nonpayable", inputs: [{ type: "uint16" }], outputs: [] },
] as const;
const E20 = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

const f = (x: bigint) => formatUnits(x, 18);

async function main() {
  const [w] = await hre.viem.getWalletClients();
  const pub = await hre.viem.getPublicClient();
  const me = w.account.address;
  console.log("Wallet:", me);

  const bal0 = await pub.readContract({ address: USDSO, abi: E20, functionName: "balanceOf", args: [me] }) as bigint;
  const half = await pub.readContract({ address: MM, abi: MM_ABI, functionName: "halfDeposit", args: [TIER] }) as bigint;
  console.log(`USDso balance: ${f(bal0)}`);
  console.log(`halfDeposit(${TIER}): ${f(half)} USDso`);
  if (bal0 < half) { console.log("Insufficient USDso for this tier. Abort."); return; }

  // 1. Approve
  const allow = await pub.readContract({ address: USDSO, abi: E20, functionName: "allowance", args: [me, MM] }) as bigint;
  if (allow < half) {
    console.log(`Approving ${f(half)} USDso to Matchmaker...`);
    const ah = await w.writeContract({ address: USDSO, abi: E20, functionName: "approve", args: [MM, half] });
    await pub.waitForTransactionReceipt({ hash: ah });
  } else { console.log("Allowance already sufficient."); }

  // 2. queue
  console.log(`queue(fighter=${FIGHTER}, turns=${TIER})...`);
  const qh = await w.writeContract({ address: MM, abi: MM_ABI, functionName: "queue", args: [FIGHTER, TIER] });
  const qr = await pub.waitForTransactionReceipt({ hash: qh });
  console.log(`  TX ${qh} status=${qr.status} logs=${qr.logs.length}`);

  // 3. getSlot
  const slot = await pub.readContract({ address: MM, abi: MM_ABI, functionName: "getSlot", args: [TIER] }) as readonly [string, number, bigint, bigint];
  console.log(`  slot: player=${slot[0]} fighter=${slot[1]} deposit=${f(slot[2])} queuedBlock=${slot[3]}`);
  const inSlot = slot[0].toLowerCase() === me.toLowerCase();
  console.log(`  we are in the slot: ${inSlot}`);

  const bal1 = await pub.readContract({ address: USDSO, abi: E20, functionName: "balanceOf", args: [me] }) as bigint;
  console.log(`  USDso after queue: ${f(bal1)} (delta ${f(bal1 - bal0)})`);

  // 4. cancelQueue (CANCEL_DELAY_BLOCKS=1; next tx is a new block on Somnia)
  console.log("cancelQueue(3)...");
  const ch = await w.writeContract({ address: MM, abi: MM_ABI, functionName: "cancelQueue", args: [TIER] });
  const cr = await pub.waitForTransactionReceipt({ hash: ch });
  console.log(`  TX ${ch} status=${cr.status} logs=${cr.logs.length}`);

  const slot2 = await pub.readContract({ address: MM, abi: MM_ABI, functionName: "getSlot", args: [TIER] }) as readonly [string, number, bigint, bigint];
  const bal2 = await pub.readContract({ address: USDSO, abi: E20, functionName: "balanceOf", args: [me] }) as bigint;
  console.log(`  slot after cancel: player=${slot2[0]} (empty=${slot2[0] === "0x0000000000000000000000000000000000000000"})`);
  console.log(`  USDso after cancel: ${f(bal2)} (refunded ${f(bal2 - bal1)})`);

  console.log(`\n=== RESULT ===`);
  console.log(`queue worked:  ${inSlot}`);
  console.log(`refund worked: ${bal2 === bal0}`);
}
main().catch((e) => { console.error("FAILED:", e?.shortMessage || e); process.exitCode = 1; });
