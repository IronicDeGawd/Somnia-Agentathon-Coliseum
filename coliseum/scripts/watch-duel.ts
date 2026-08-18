/**
 * watch-duel.ts
 * -------------
 * Prints a duel's live state every few seconds: rounds completed, each
 * fighter's holdings on every active market, and the running valuation.
 *
 *   DUEL_ID=1 POLLS=20 pnpm exec hardhat run scripts/watch-duel.ts --network somnia
 */
import hre from "hardhat";
import { formatEther } from "viem";
import fs from "fs";
import path from "path";

const STATUS = ["None", "Active", "Finalizing", "Resolved"];

async function main() {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"));
  const arena = await hre.viem.getContractAt("Arena", manifest.contracts.Arena.address);
  const pub = await hre.viem.getPublicClient();

  const duelId = BigInt(process.env.DUEL_ID ?? "1");
  const polls = Number(process.env.POLLS ?? "12");
  const everyMs = Number(process.env.EVERY_MS ?? "6000");

  const pools = [
    ["WETH", (await arena.read.POOL_WETH()) as `0x${string}`, 0x01],
    ["WBTC", (await arena.read.POOL_WBTC()) as `0x${string}`, 0x02],
    ["SOMI", (await arena.read.POOL_SOMI()) as `0x${string}`, 0x04],
  ] as [string, `0x${string}`, number][];

  let last = "";
  for (let i = 0; i < polls; i++) {
    const d = (await arena.read.duels([duelId])) as unknown[];
    const status = Number(d[8]);
    const done = Number(d[5]);
    const turns = Number(d[6]);
    const mask = Number(d[7]);
    const fA = Number(d[0]), fB = Number(d[1]);

    const parts: string[] = [];
    for (const [name, pool, bit] of pools) {
      if ((mask & bit) === 0) continue;
      for (const [label, fid] of [["A", fA], ["B", fB]] as [string, number][]) {
        const bal = (await arena.read.fighterBalances([pool, duelId, fid])) as unknown[];
        parts.push(`${label}:${name} base ${formatEther(bal[0] as bigint)} quote ${formatEther(bal[1] as bigint)}`);
      }
    }
    const block = await pub.getBlockNumber();
    const line = `[block ${block}] ${STATUS[status]}  round ${Math.ceil(done / 2)}/${turns}  moves ${done}/${turns * 2}\n    ${parts.join("\n    ")}`;
    if (line.replace(/\[block \d+\]/, "") !== last) {
      console.log(line);
      last = line.replace(/\[block \d+\]/, "");
    }
    if (status === 3) { console.log(`\nRESOLVED — winnerSlot ${d[11]}`); return; }
    if (i < polls - 1) await new Promise((r) => setTimeout(r, everyMs));
  }
}

main().catch((e) => { console.error(e?.shortMessage ?? e); process.exit(1); });
