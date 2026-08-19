// ============================================================================
// matrix-summary — the README table, generated from the chain.
//
// One row per duel: which market it ran on, how many rounds, how many orders
// actually reached a book, who won, and which assets were traded. Every field is
// read back from events rather than from whatever the test runner believed at the
// time, because the runner only knows what it asked for — not what happened.
//
// Reads only.
//
//   DUELS=39,40,41 pnpm exec hardhat run scripts/matrix-summary.ts --network somnia
//
// Env:
//   DUELS  comma-separated duel ids (required)
//   MD     set to 1 to emit markdown table rows for the README
// ============================================================================
import hre from "hardhat";
import { parseAbiItem } from "viem";
import fs from "fs";
import path from "path";

const man = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"),
);
const ARENA = man.contracts.Arena.address as `0x${string}`;

// Spot pools carry no on-chain label, so their names come from the manifest. A
// truncated address in the table tells a reader nothing about what was traded.
const SPOT_NAMES = new Map<string, string>();
for (const [key, val] of Object.entries(man.external ?? {})) {
  if (typeof val === "string" && /^0x[0-9a-fA-F]{40}$/.test(val)) {
    SPOT_NAMES.set(val.toLowerCase(), key.replace(/^pool/i, "").toUpperCase());
  }
}
for (const [key, val] of Object.entries((man.contracts?.SpotPools ?? {}) as Record<string, string>)) {
  if (typeof val === "string") SPOT_NAMES.set(val.toLowerCase(), key.toUpperCase());
}

const ORDER_PLACED = parseAbiItem(
  "event OrderPlaced(address indexed pool, uint8 indexed fighterId, uint256 duelId, uint128 orderId, bool isBid, uint256 price, uint256 quantity, uint8 orderType)",
);
const RESOLVED = parseAbiItem(
  "event DuelResolved(uint256 indexed duelId, uint8 indexed winnerId, uint256 fighterAValueUsdso, uint256 fighterBValueUsdso)",
);

const FIGHTER_NAMES = ["The Degen", "The Whale", "The Quant", "Diamond Hand", "The Scalper", "The Contrarian"];

async function main() {
  const ids = (process.env.DUELS ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  if (!ids.length) throw new Error("set DUELS=39,40,...");
  const md = process.env.MD === "1";

  const pub = await hre.viem.getPublicClient();
  const arena = await hre.viem.getContractAt("Arena", ARENA);
  const head = await pub.getBlockNumber();

  const rows: string[] = [];
  for (const id of ids) {
    const d = (await arena.read.duels([BigInt(id)])) as any[];
    const startBlock = BigInt(d[3]);
    const turns = Number(d[6]);
    const status = Number(d[8]);
    // Solidity OMITS the uint8[2] lastAction from an auto-getter, so this tuple is
    // 13 fields and `simulated` is the last of them. Reading index 13 gets undefined
    // and quietly reports every practice fight as a real one.
    const simulated = Boolean(d[12]);
    if (startBlock === 0n) { rows.push(`| ${id} | — | — | — | never started | — |`); continue; }

    const pools = (await arena.read.duelPoolsOf([BigInt(id)])) as string[];
    // A slot's kind is a property of the pool, not of the duel — so it is asked of
    // the pool. `simulated` cannot answer it: a spot fight and an events fight both
    // report false.
    const isPerp = await arena.read.isPerpPool([pools[0] as `0x${string}`]) as boolean;
    let question = "";
    try { question = (await arena.read.poolQuestion([pools[0] as `0x${string}`])) as string; } catch {}
    const labelled = question && !/^0x0+$/.test(question);
    const market = simulated ? "Practice" : isPerp ? "Perps" : labelled ? "Events" : "Spot";

    // Names for the assets each slot traded, so a row says WHAT was traded and not
    // just how much.
    const names: string[] = [];
    for (const p of pools) {
      if (/^0x0+$/.test(p)) continue;
      try {
        const q = (await arena.read.poolQuestion([p as `0x${string}`])) as string;
        const txt = Buffer.from(q.slice(2), "hex").toString("utf8").replace(/\0+$/, "");
        if (txt) { names.push(txt); continue; }
      } catch {}
      names.push(SPOT_NAMES.get(p.toLowerCase()) ?? p.slice(0, 8));
    }

    // Orders and the result, scanned from the fight's own first block.
    let orders = 0;
    let winner = status === 3 ? "draw" : "unresolved";
    const traded = new Set<string>();
    for (let b = startBlock; b <= head; b += 900n) {
      const to = b + 899n > head ? head : b + 899n;
      try {
        for (const l of await pub.getLogs({ address: ARENA, event: ORDER_PLACED, fromBlock: b, toBlock: to })) {
          const g = l.args as { duelId: bigint; pool: string };
          if (Number(g.duelId) !== id) continue;
          orders++;
          traded.add(g.pool.toLowerCase());
        }
        for (const l of await pub.getLogs({ address: ARENA, event: RESOLVED, fromBlock: b, toBlock: to })) {
          const g = l.args as { duelId: bigint; winnerId: number };
          if (Number(g.duelId) !== id) continue;
          winner = Number(g.winnerId) === 255 ? "draw" : (FIGHTER_NAMES[Number(g.winnerId)] ?? `#${g.winnerId}`);
        }
      } catch { /* a chunk the RPC refuses is skipped rather than fatal */ }
    }

    const result = winner === "draw" ? "draw" : `**${winner}**`;
    rows.push(md
      ? `| [${id}](https://coliseum.somniaforge.com/duel/${id}/result) | ${market} | ${turns} | ${orders} | ${result} | ${names.join(" ")} |`
      : `duel ${id}  ${market.padEnd(8)} ${String(turns).padStart(2)}r  orders ${String(orders).padStart(3)}  ${winner.padEnd(14)} ${names.join(" ")}`);
  }

  if (md) console.log("| Duel | Market | Rounds | Orders | Result | Markets traded |\n|---|---|---|---|---|---|");
  console.log(rows.join("\n"));
}

main().catch((e) => { console.error(e); process.exit(1); });
