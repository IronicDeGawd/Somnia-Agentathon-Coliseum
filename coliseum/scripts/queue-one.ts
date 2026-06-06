/**
 * queue-one.ts — queue a single bot wallet into the Matchmaker.
 *
 * Usage:
 *   PLAYER=1 TURNS=3 pnpm exec hardhat run scripts/queue-one.ts --network somnia
 *   PLAYER=2 TURNS=3 pnpm exec hardhat run scripts/queue-one.ts --network somnia
 *
 * Defaults: PLAYER=1, TURNS=3
 */

import "dotenv/config";
import { createWalletClient, createPublicClient, http, maxUint256, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";

const somnia = defineChain({
  id: 50312,
  name: "Somnia Shannon Testnet",
  nativeCurrency: { name: "Somnia Token", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://dream-rpc.somnia.network"] } },
  testnet: true,
});

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
function fmtU(v: bigint) {
  return parseFloat(formatUnits(v, 18)).toFixed(4);
}

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

const MATCHMAKER_ABI = [
  { name: "halfDeposit", type: "function", stateMutability: "view", inputs: [{ name: "turns", type: "uint16" }], outputs: [{ type: "uint256" }] },
  { name: "queue", type: "function", stateMutability: "nonpayable", inputs: [{ name: "fighter", type: "uint8" }, { name: "turns", type: "uint16" }], outputs: [] },
] as const;

const HISTORY_ABI = [
  { name: "totalDuels", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

async function main() {
  const playerNum = process.env.PLAYER ?? "1";
  const turns = Number(process.env.TURNS ?? "3") as 3 | 6 | 9 | 15;
  const fighter = Number(process.env.FIGHTER ?? "-1");

  const keyEnv = playerNum === "2" ? process.env.PLAYER2_PRIVATE_KEY : process.env.PLAYER1_PRIVATE_KEY;
  if (!keyEnv) throw new Error(`PLAYER${playerNum}_PRIVATE_KEY not set`);

  const manifest = require("../deployments/somnia.json");
  const c = manifest.contracts;
  const addr = (v: unknown): `0x${string}` =>
    typeof v === "string" ? (v as `0x${string}`) : ((v as { address: string }).address as `0x${string}`);
  const matchmkAddr = addr(c.Matchmaker);
  const usdsoAddr   = manifest.external?.usdso as `0x${string}`;
  const historyAddr = c.DuelHistory ? addr(c.DuelHistory) : undefined;

  const account = privateKeyToAccount(keyEnv as `0x${string}`);
  const publicClient = createPublicClient({ chain: somnia, transport: http() });
  const wallet = createWalletClient({ account, chain: somnia, transport: http() });

  log(`Player ${playerNum}: ${account.address}`);
  log(`Matchmaker: ${matchmkAddr}  turns=${turns}`);

  // Pick fighter index
  let fighterIndex = fighter >= 0 ? fighter : 0;
  if (fighter < 0 && historyAddr) {
    try {
      const total = (await publicClient.readContract({ address: historyAddr, abi: HISTORY_ABI, functionName: "totalDuels" })) as bigint;
      fighterIndex = Number(total % BigInt(6));
      if (playerNum === "2") fighterIndex = (fighterIndex + 1) % 6;
    } catch { /* non-fatal */ }
  }
  log(`Fighter index: ${fighterIndex}`);

  const halfDeposit = (await publicClient.readContract({ address: matchmkAddr, abi: MATCHMAKER_ABI, functionName: "halfDeposit", args: [turns] })) as bigint;
  log(`halfDeposit(${turns}): ${fmtU(halfDeposit)} USDso`);

  const usdBal = (await publicClient.readContract({ address: usdsoAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] })) as bigint;
  const sttBal = await publicClient.getBalance({ address: account.address });
  log(`Balances: USDso=${fmtU(usdBal)}  STT=${fmtU(sttBal)}`);

  if (usdBal < halfDeposit) {
    throw new Error(`Insufficient USDso: have ${fmtU(usdBal)}, need ${fmtU(halfDeposit)}`);
  }

  const allowance = (await publicClient.readContract({ address: usdsoAddr, abi: ERC20_ABI, functionName: "allowance", args: [account.address, matchmkAddr] })) as bigint;
  if (allowance < halfDeposit) {
    log("Approving USDso → Matchmaker...");
    const approveTx = await wallet.writeContract({ address: usdsoAddr, abi: ERC20_ABI, functionName: "approve", args: [matchmkAddr, maxUint256] });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    log(`  approve tx=${approveTx} ✓`);
  } else {
    log("Allowance sufficient — skipping approve");
  }

  log(`Queuing player ${playerNum} (fighter=${fighterIndex}, turns=${turns})...`);
  const queueTx = await wallet.writeContract({ address: matchmkAddr, abi: MATCHMAKER_ABI, functionName: "queue", args: [fighterIndex, turns] });
  await publicClient.waitForTransactionReceipt({ hash: queueTx });
  log(`  queue tx=${queueTx} ✓`);
  log(`Done — P${playerNum} is now in the queue.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
