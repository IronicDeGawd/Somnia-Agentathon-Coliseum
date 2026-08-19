// ============================================================================
// check-rejections — why a fighter's orders are being refused.
//
// duel-tape.ts prints the reason but not the order it belonged to, and the two
// together are what identifies a fault: "pool reverted" on the SOMI pool for a
// SELL is a different bug from "vault below min cost" on WBTC for a BUY. Both
// were live at once on duel 36 and reading them apart is what separated them.
//
// Reads only.
//
//   DUEL=38 pnpm exec hardhat run scripts/check-rejections.ts --network somnia
//
// Env:
//   DUEL   duel id to report on (required)
//   SPAN   how many blocks back to scan (default 6000, ~10 minutes)
// ============================================================================
import hre from "hardhat";
import { parseAbiItem, formatUnits } from "viem";
import fs from "fs";
import path from "path";

const man = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"),
);
const ARENA = man.contracts.Arena.address as `0x${string}`;

const REJECTED = parseAbiItem(
  "event OrderRejected(address indexed pool, uint8 indexed fighterId, uint256 duelId, bool isBid, uint256 price, uint256 quantity, uint8 orderType, string reason)",
);

async function main() {
  const duelId = Number(process.env.DUEL ?? 0);
  if (!duelId) throw new Error("set DUEL=<id>");
  const span = BigInt(process.env.SPAN ?? 6000);

  const pub = await hre.viem.getPublicClient();
  const head = await pub.getBlockNumber();
  const rows: string[] = [];

  // Chunked, because the RPC caps the range a single getLogs may cover.
  for (let b = head - span; b < head; b += 900n) {
    const to = b + 899n > head ? head : b + 899n;
    try {
      const logs = await pub.getLogs({ address: ARENA, event: REJECTED, fromBlock: b, toBlock: to });
      for (const l of logs) {
        const g = l.args as {
          pool: string; fighterId: number; duelId: bigint;
          isBid: boolean; price: bigint; quantity: bigint; reason: string;
        };
        if (Number(g.duelId) !== duelId) continue;
        rows.push(
          `${l.blockNumber} f${g.fighterId} ${g.pool} ${g.isBid ? "buy " : "sell"} ` +
          `@ ${formatUnits(g.price, 18)} qty ${g.quantity} — ${g.reason}`,
        );
      }
    } catch { /* a chunk the RPC refuses is skipped rather than fatal */ }
  }

  console.log(`duel ${duelId}: ${rows.length} rejected order(s) in the last ${span} blocks`);
  if (rows.length) console.log(rows.join("\n"));
}

main().catch((e) => { console.error(e); process.exit(1); });
