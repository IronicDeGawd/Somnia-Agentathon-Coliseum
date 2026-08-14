/**
 * claim-match.ts
 * --------------
 * Claim a finished match's payout for the operator wallet.
 *
 * Also the way an Arena is emptied. Escrowed stake is released by the FIRST
 * claim on a match — that claim is what pulls the pot out of Arena — and Arena
 * refuses to have its parts rewired while anything is still escrowed. So a
 * pending claim from an old fight blocks a redeploy until someone collects.
 * The other player's share stays theirs to claim afterwards.
 *
 *   DUEL_ID=1 pnpm exec hardhat run scripts/claim-match.ts --network somnia
 */
import hre from "hardhat";
import { formatEther } from "viem";
import fs from "fs";
import path from "path";

async function main() {
  const duelId = BigInt(process.env.DUEL_ID ?? "1");
  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "deployments", `${hre.network.name}.json`), "utf-8"));

  const pub = await hre.viem.getPublicClient();
  const [wallet] = await hre.viem.getWalletClients();
  const me = wallet.account.address;

  const arena = await hre.viem.getContractAt("Arena", manifest.contracts.Arena.address);
  const mm = await hre.viem.getContractAt("Matchmaker", manifest.contracts.Matchmaker.address);

  const duel = (await arena.read.duels([duelId])) as unknown[];
  const status = Number(duel[8]);
  const winnerSlot = Number(duel[11]);
  if (status !== 3) throw new Error(`duel ${duelId} is not resolved (status ${status})`);

  const match = (await mm.read.matches([duelId])) as unknown[];
  const [playerA, playerB] = [match[0] as string, match[1] as string];
  const outcome = winnerSlot === 2 ? "draw" : `slot ${winnerSlot} won`;
  console.log(`Duel ${duelId}: ${outcome}`);
  console.log(`  A ${playerA}\n  B ${playerB}`);
  console.log(`  escrowed in Arena: ${formatEther((await arena.read.escrowedPot()) as bigint)}`);

  const isPlayer = [playerA, playerB].some((p) => p.toLowerCase() === me.toLowerCase());
  if (!isPlayer) throw new Error(`operator ${me} is not a player in this match`);

  const hash = await mm.write.claimWinnings([duelId]);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log(`\nclaimWinnings tx: ${hash} (block ${receipt.blockNumber})`);
  console.log(`  escrowed in Arena now: ${formatEther((await arena.read.escrowedPot()) as bigint)}`);
  console.log(`  the other player's share is still theirs to claim`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.shortMessage ?? e); process.exit(1); });
