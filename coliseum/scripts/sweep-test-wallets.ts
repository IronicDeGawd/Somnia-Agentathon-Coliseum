/**
 * sweep-test-wallets.ts
 * ---------------------
 * Send every throwaway test wallet's USDso and spare STT to one address.
 *
 * Run at the end of a live test run. The wallets are disposable and their keys live
 * in a scratchpad, so anything left in them is simply lost — this returns it.
 *
 * STT is swept to a floor rather than to zero: an address needs gas to send its own
 * balance, so sweeping everything is impossible and attempting it wastes the
 * transaction. Whatever is under the floor stays where it is.
 *
 *   TO=0x… WALLET_FILE=… pnpm exec hardhat run scripts/sweep-test-wallets.ts --network somnia
 *
 * Env:
 *   TO           — where everything goes. Required; there is no default on purpose.
 *   WALLET_FILE  — the JSON written by make-test-wallets.
 *   KEEP_STT     — STT left behind per wallet for its own gas (default 0.02).
 *   DRY          — set to 1 to report what WOULD move and send nothing.
 */
import hre from "hardhat";
import { createWalletClient, http, parseEther, formatEther, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import fs from "fs";
import path from "path";

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
]);

async function main() {
  const to = process.env.TO as `0x${string}` | undefined;
  if (!to) throw new Error("TO is required — name the address the funds go to");
  const file = process.env.WALLET_FILE;
  if (!file) throw new Error("WALLET_FILE is required");
  const dry = process.env.DRY === "1";
  const keep = parseEther(process.env.KEEP_STT ?? "0.02");

  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "deployments", `${hre.network.name}.json`), "utf-8"));
  const usdso = manifest.external.usdso as `0x${string}`;

  const pub = await hre.viem.getPublicClient();
  const wallets: { address: `0x${string}`; privateKey: `0x${string}` }[] =
    JSON.parse(fs.readFileSync(file, "utf-8"));

  console.log(`${dry ? "DRY RUN — " : ""}sweeping ${wallets.length} wallets to ${to}\n`);
  let usdsoMoved = 0n;
  let sttMoved = 0n;

  for (const wal of wallets) {
    const acct = privateKeyToAccount(wal.privateKey);
    const client = createWalletClient({ account: acct, chain: pub.chain, transport: http("https://dream-rpc.somnia.network") });
    const gasPrice = await pub.getGasPrice();

    const usd = await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [acct.address] }) as bigint;
    if (usd > 0n) {
      if (!dry) {
        const h = await client.writeContract({ address: usdso, abi: ERC20, functionName: "transfer", args: [to, usd], gasPrice, gas: 120000n, type: "legacy" });
        await pub.waitForTransactionReceipt({ hash: h });
      }
      usdsoMoved += usd;
    }

    // Native last, and only what is left after the token transfer's own gas.
    const bal = await pub.getBalance({ address: acct.address });
    const fee = gasPrice * 21000n;
    const send = bal > keep + fee ? bal - keep - fee : 0n;
    if (send > 0n) {
      if (!dry) {
        const h = await client.sendTransaction({ to, value: send, gasPrice, gas: 21000n, type: "legacy" });
        await pub.waitForTransactionReceipt({ hash: h });
      }
      sttMoved += send;
    }
    console.log(`  ${acct.address}  ${formatEther(usd).padStart(12)} USDso  ${formatEther(send).padStart(14)} STT`);
  }

  console.log(`\n  total ${formatEther(usdsoMoved)} USDso and ${formatEther(sttMoved)} STT ${dry ? "would move" : "sent"} to ${to}`);
}

main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
