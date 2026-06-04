/**
 * Create two PvP player wallets (CSPRNG), persist keys to .env (gitignored),
 * and fund each with 10 USDso + 8 STT (gas) from the deployer. Idempotent:
 * reuses existing PLAYER1/2 keys in .env if present. Prints addresses only.
 * Run: pnpm exec hardhat run scripts/create-players.ts --network somnia
 */
import hre from "hardhat";
import { parseEther, formatUnits, formatEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import fs from "fs";
import path from "path";

const USDSO = "0x9c32F3827A1a99f0cf9B213de8b53eC3d57bb171" as const;
const ERC20 = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amt", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

const USDSO_EACH = parseEther("10");
const STT_EACH = parseEther("8");

function ensureKey(envPath: string, name: string): `0x${string}` {
  let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
  const re = new RegExp(`^${name}=(0x[0-9a-fA-F]{64})`, "m");
  const m = env.match(re);
  if (m) return m[1] as `0x${string}`;
  const key = generatePrivateKey();
  if (env.length && !env.endsWith("\n")) env += "\n";
  env += `${name}=${key}\n`;
  fs.writeFileSync(envPath, env);
  fs.chmodSync(envPath, 0o600);
  return key;
}

async function main() {
  const envPath = path.join(__dirname, "..", ".env");
  const k1 = ensureKey(envPath, "PLAYER1_PRIVATE_KEY");
  const k2 = ensureKey(envPath, "PLAYER2_PRIVATE_KEY");
  const p1 = privateKeyToAccount(k1).address;
  const p2 = privateKeyToAccount(k2).address;

  const [wallet] = await hre.viem.getWalletClients();
  const pub = await hre.viem.getPublicClient();
  const me = wallet.account.address;
  console.log("Deployer:", me);
  console.log("Player 1:", p1);
  console.log("Player 2:", p2);

  const usdsoBal = async (a: `0x${string}`) => await pub.readContract({ address: USDSO, abi: ERC20, functionName: "balanceOf", args: [a] }) as bigint;

  for (const [label, addr] of [["P1", p1], ["P2", p2]] as const) {
    const haveU = await usdsoBal(addr);
    if (haveU < USDSO_EACH) {
      const tx = await wallet.writeContract({ address: USDSO, abi: ERC20, functionName: "transfer", args: [addr, USDSO_EACH] });
      await pub.waitForTransactionReceipt({ hash: tx });
      console.log(`  ${label} funded 10 USDso (${tx.slice(0, 12)}…)`);
    } else console.log(`  ${label} already has USDso, skip`);

    const haveS = await pub.getBalance({ address: addr });
    if (haveS < STT_EACH) {
      const tx = await wallet.sendTransaction({ to: addr, value: STT_EACH });
      await pub.waitForTransactionReceipt({ hash: tx });
      console.log(`  ${label} funded 8 STT (${tx.slice(0, 12)}…)`);
    } else console.log(`  ${label} already has STT, skip`);
  }

  console.log("\n=== Balances ===");
  for (const [label, addr] of [["Deployer", me], ["Player 1", p1], ["Player 2", p2]] as const) {
    console.log(`${label}: ${formatUnits(await usdsoBal(addr), 18)} USDso · ${formatEther(await pub.getBalance({ address: addr }))} STT`);
  }
}
main().catch((e) => { console.error("create-players failed:", e); process.exitCode = 1; });
