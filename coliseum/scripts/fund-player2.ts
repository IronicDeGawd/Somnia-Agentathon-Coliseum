/**
 * fund-player2.ts
 * ---------------
 * Manual USDso transfer from Player1 to Player2.
 *
 * P2 only ever spends its deposit, so it drains over time and the daily duel
 * stops being able to queue. daily-duel.ts now tops P2 up on its own, so this
 * is the manual escape hatch for topping up out of band or by a custom amount.
 *
 * Run:
 *   USDSO_ADDRESS=0x… FUND_AMOUNT=6 pnpm exec hardhat run scripts/fund-player2.ts --network somnia
 *
 * Required env:
 *   USDSO_ADDRESS        — USDso token address
 *   PLAYER1_PRIVATE_KEY  — sender
 *   PLAYER2_PRIVATE_KEY  — recipient (address only; the key is not spent)
 *   FUND_AMOUNT          — optional, whole USDso, defaults to 6
 */

import hre from "hardhat";
import { createWalletClient, http, parseUnits, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const USDSO = process.env.USDSO_ADDRESS as `0x${string}`;
const ERC20 = [
  { name: "transfer", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

async function main() {
  const pub = await hre.viem.getPublicClient();
  const p1 = privateKeyToAccount(process.env.PLAYER1_PRIVATE_KEY as `0x${string}`);
  const p2 = privateKeyToAccount(process.env.PLAYER2_PRIVATE_KEY as `0x${string}`);
  const amount = parseUnits(process.env.FUND_AMOUNT ?? "6", 18);
  const wallet = createWalletClient({ account: p1, chain: pub.chain, transport: http() });
  console.log("P1", p1.address, "->", "P2", p2.address, formatUnits(amount, 18), "USDso");
  const hash = await wallet.writeContract({ address: USDSO, abi: ERC20, functionName: "transfer", args: [p2.address, amount] });
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log("tx", hash, "status", r.status);
  for (const [n, a] of [["P1", p1.address], ["P2", p2.address]] as const) {
    const b = await pub.readContract({ address: USDSO, abi: ERC20, functionName: "balanceOf", args: [a] });
    console.log(n, formatUnits(b as bigint, 18), "USDso");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
