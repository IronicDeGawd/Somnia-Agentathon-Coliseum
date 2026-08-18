/**
 * claim-all.ts
 * ------------
 * Collect every finished match's payout for the throwaway players.
 *
 * Also how the arena is emptied: escrowed stake is released by the FIRST claim
 * on a match, and parts cannot be rewired while anything is still escrowed. So
 * an unclaimed payout blocks the next deploy.
 *
 *   WALLET_FILE=... pnpm exec hardhat run scripts/claim-all.ts --network somnia
 */
import hre from "hardhat";
import { createWalletClient, http, formatEther, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import fs from "fs";
import path from "path";

const MM = parseAbi([
  "function matches(uint256 duelId) view returns (address playerA, address playerB, uint256 totalPot, bool recovered, bool settledA, bool settledB)",
  "function claimWinnings(uint256 duelId)",
]);

async function main() {
  const file = process.env.WALLET_FILE;
  if (!file) throw new Error("WALLET_FILE is required");

  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "deployments", `${hre.network.name}.json`), "utf-8"));
  const mmAddr = manifest.contracts.Matchmaker.address as `0x${string}`;

  const pub = await hre.viem.getPublicClient();
  const arena = await hre.viem.getContractAt("Arena", manifest.contracts.Arena.address);
  const chain = (await hre.viem.getWalletClients())[0].chain;
  const rpc = process.env.RPC_HTTP ?? "https://dream-rpc.somnia.network";

  const wallets = JSON.parse(fs.readFileSync(file, "utf-8")) as { address: string; privateKey: string }[];
  const byAddress = new Map(wallets.map((w) => [w.address.toLowerCase(), w]));

  const next = (await arena.read.nextDuelId()) as bigint;
  console.log(`escrowed before: ${formatEther((await arena.read.escrowedPot()) as bigint)} USDso`);

  for (let id = 1n; id < next; id++) {
    const duel = (await arena.read.duels([id])) as unknown[];
    if (Number(duel[8]) !== 3) continue;                        // not resolved

    const match = (await pub.readContract({ address: mmAddr, abi: MM, functionName: "matches", args: [id] })) as unknown[];
    const [pA, pB, , , settledA, settledB] = match as [string, string, bigint, boolean, boolean, boolean];
    if (pA === "0x0000000000000000000000000000000000000000") continue;   // not a queued match

    for (const [who, settled] of [[pA, settledA], [pB, settledB]] as [string, boolean][]) {
      if (settled) continue;
      const w = byAddress.get(who.toLowerCase());
      if (!w) { console.log(`#${id} ${who} is not one of ours — skipping`); continue; }
      const client = createWalletClient({
        account: privateKeyToAccount(w.privateKey as `0x${string}`), chain, transport: http(rpc),
      });
      try {
        const hash = await client.writeContract({
          address: mmAddr, abi: MM, functionName: "claimWinnings", args: [id], gas: BigInt(3_000_000),
        });
        await pub.waitForTransactionReceipt({ hash });
        console.log(`#${id} claimed by ${who}`);
      } catch (e) {
        const msg = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
        console.log(`#${id} ${who} claim failed: ${msg.split("\n")[0]}`);
      }
    }
  }

  console.log(`escrowed after:  ${formatEther((await arena.read.escrowedPot()) as bigint)} USDso`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.shortMessage ?? e); process.exit(1); });
