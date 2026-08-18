/**
 * queue-pair.ts
 * -------------
 * Put two throwaway players through the real matchmaking queue, so a fight
 * starts the way a player's would rather than being started by the operator.
 *
 * This is the path neither live fight so far has exercised: both were started
 * directly by the owner, skipping the queue entirely.
 *
 *   PAIR=0 TURNS=3 MARKET=2 WALLET_FILE=... pnpm exec hardhat run scripts/queue-pair.ts --network somnia
 *
 * Env:
 *   PAIR        — which pair of wallets to use (0 = players 1&2, 1 = 3&4, ...).
 *   TURNS       — 3, 6, 9 or 15.
 *   MARKET      — 0 spot coins, 1 practice, 2 events, 3 perps.
 *   FIGHTERS    — "0,1" registry indices; must differ.
 *   WALLET_FILE — JSON from make-test-wallets.ts.
 */
import hre from "hardhat";
import { createWalletClient, http, formatEther, maxUint256, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import fs from "fs";
import path from "path";

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const MM = parseAbi([
  "function halfDeposit(uint16 turns, uint8 marketKind) view returns (uint256)",
  "function queue(uint8 fighter, uint16 turns, uint8 marketKind)",
  "function getSlot(uint16 turns, uint8 marketKind) view returns (address player, uint8 fighter, uint256 deposit, uint64 queuedAt)",
  "function pendingCount(uint16 turns, uint8 marketKind) view returns (uint256)",
]);
const MARKET_NAME = ["spot", "practice", "events", "perps"];

async function main() {
  const pair = Number(process.env.PAIR ?? "0");
  const turns = Number(process.env.TURNS ?? "3");
  const market = Number(process.env.MARKET ?? "2");
  const [fA, fB] = (process.env.FIGHTERS ?? "0,1").split(",").map(Number);
  const file = process.env.WALLET_FILE;
  if (!file) throw new Error("WALLET_FILE is required");

  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "deployments", `${hre.network.name}.json`), "utf-8"));
  const mmAddr = manifest.contracts.Matchmaker.address as `0x${string}`;
  const arenaAddr = manifest.contracts.Arena.address as `0x${string}`;
  const usdso = manifest.external.usdso as `0x${string}`;

  const pub = await hre.viem.getPublicClient();
  const arena = await hre.viem.getContractAt("Arena", arenaAddr);
  const chain = (await hre.viem.getWalletClients())[0].chain;
  const rpc = process.env.RPC_HTTP ?? "https://dream-rpc.somnia.network";

  const all = JSON.parse(fs.readFileSync(file, "utf-8")) as { address: string; privateKey: string }[];
  const picked = [all[pair * 2], all[pair * 2 + 1]];
  if (!picked[0] || !picked[1]) throw new Error(`wallet file has no pair ${pair}`);

  const clients = picked.map((w) =>
    createWalletClient({ account: privateKeyToAccount(w.privateKey as `0x${string}`), chain, transport: http(rpc) }));

  const tag = `${turns}r ${MARKET_NAME[market]}`;
  const half = (await pub.readContract({ address: mmAddr, abi: MM, functionName: "halfDeposit", args: [turns, market] })) as bigint;
  console.log(`[${tag}] deposit per player ${formatEther(half)} USDso`);

  const before = (await arena.read.getActiveDuelIds()) as bigint[];

  for (const [i, client] of clients.entries()) {
    const me = client.account.address;
    const bal = (await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [me] })) as bigint;
    if (bal < half) throw new Error(`${me} holds ${formatEther(bal)} USDso, needs ${formatEther(half)}`);

    const allowance = (await pub.readContract({ address: usdso, abi: ERC20, functionName: "allowance", args: [me, mmAddr] })) as bigint;
    if (allowance < half) {
      const h = await client.writeContract({ address: usdso, abi: ERC20, functionName: "approve", args: [mmAddr, maxUint256] });
      await pub.waitForTransactionReceipt({ hash: h });
    }

    // The SECOND queue call is the one that pairs and starts the fight, so it
    // needs the gas headroom a duel start actually costs.
    const hash = await client.writeContract({
      address: mmAddr, abi: MM, functionName: "queue",
      args: [i === 0 ? fA : fB, turns, market],
      gas: BigInt(9_000_000),
    });
    const r = await pub.waitForTransactionReceipt({ hash });
    console.log(`[${tag}] player${pair * 2 + i + 1} queued fighter ${i === 0 ? fA : fB}  ${r.status}  ${hash}`);
  }

  const after = (await arena.read.getActiveDuelIds()) as bigint[];
  const started = after.filter((id) => !before.includes(id));
  if (started.length) {
    console.log(`[${tag}] STARTED duel #${started.join(", #")}`);
    const [prompt, allowed] = (await arena.read.previewTurnPrompt([started[0], fA])) as [string, string[]];
    console.log(`[${tag}] prompt: ${prompt}`);
    console.log(`[${tag}] allowed: ${allowed.join(", ")}`);
    if (/[0-9]/.test(prompt)) console.log(`[${tag}] WARNING: a digit reached the prompt`);
  } else {
    const pending = (await pub.readContract({ address: mmAddr, abi: MM, functionName: "pendingCount", args: [turns, market] })) as bigint;
    const slot = (await pub.readContract({ address: mmAddr, abi: MM, functionName: "getSlot", args: [turns, market] })) as unknown[];
    console.log(`[${tag}] no duel started — pending ${pending}, slot holder ${slot[0]}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.shortMessage ?? e); process.exit(1); });
