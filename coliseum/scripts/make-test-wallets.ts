/**
 * make-test-wallets.ts
 * --------------------
 * Create funded throwaway players so several fights can run at once.
 *
 * Parallel testing needs separate wallets, not separate scripts: transactions
 * from one address are ordered, so two fights driven from the same key queue up
 * behind each other and any burst collides on the nonce. A wallet per player
 * removes that entirely.
 *
 * USDso is minted straight to each wallet (the token has no owner and no cap),
 * and gas is sent from the operator.
 *
 *   COUNT=6 STT_EACH=1 USDSO_EACH=40 pnpm exec hardhat run scripts/make-test-wallets.ts --network somnia
 *
 * Keys are written to the scratchpad path in WALLET_FILE, never to the repo.
 */
import hre from "hardhat";
import { formatEther, parseEther, parseUnits, parseAbi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import fs from "fs";
import path from "path";

const USDSO = "0x9c32F3827A1a99f0cf9B213de8b53eC3d57bb171" as const;
const ERC20 = parseAbi([
  "function mint(address,uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

async function main() {
  const count = Number(process.env.COUNT ?? "6");
  const sttEach = parseEther(process.env.STT_EACH ?? "1");
  const usdsoEach = parseUnits(process.env.USDSO_EACH ?? "40", 18);
  const file = process.env.WALLET_FILE;
  if (!file) throw new Error("WALLET_FILE is required — keep keys out of the repo");

  const pub = await hre.viem.getPublicClient();
  const [op] = await hre.viem.getWalletClients();

  const opStt = await pub.getBalance({ address: op.account.address });
  const need = sttEach * BigInt(count);
  if (opStt < need + parseEther("5")) {
    throw new Error(`operator holds ${formatEther(opStt)} STT; needs ${formatEther(need)} plus a working float`);
  }

  const wallets: { address: string; privateKey: string }[] = [];
  for (let i = 0; i < count; i++) {
    const pk = generatePrivateKey();
    wallets.push({ address: privateKeyToAccount(pk).address, privateKey: pk });
  }

  for (const [i, w] of wallets.entries()) {
    // Gas first: a wallet holding tokens it cannot pay to move is useless.
    let hash = await op.sendTransaction({ to: w.address as `0x${string}`, value: sttEach });
    await pub.waitForTransactionReceipt({ hash });
    hash = await op.writeContract({
      address: USDSO, abi: ERC20, functionName: "mint", args: [w.address as `0x${string}`, usdsoEach],
    });
    await pub.waitForTransactionReceipt({ hash });
    console.log(`player${i + 1}  ${w.address}  ${formatEther(sttEach)} STT  ${formatEther(usdsoEach)} USDso`);
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(wallets, null, 2) + "\n", { mode: 0o600 });
  console.log(`\n${count} wallets written to ${file}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.shortMessage ?? e); process.exit(1); });
