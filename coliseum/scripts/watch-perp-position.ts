// ============================================================================
// watch-perp-position — tell me the moment a perps fighter is actually in a market.
//
// Exists because a populated position panel has never been SEEN. These fighters
// open and close inside a turn or two, so pointing a browser at a fight and hoping
// is how you get a screenshot of the flat state over and over. This polls the
// margin bank and prints a line the moment a position is open, so the browser can
// be driven at the right second.
//
// Prints one line per poll where something is open, and nothing when nobody is —
// which makes it safe to wrap in a watch that only notifies on real events.
//
//   DUEL=45 pnpm exec hardhat run scripts/watch-perp-position.ts --network somnia
//
// Env:
//   DUEL     the duel to watch (required)
//   EVERY    seconds between polls (default 10)
//   FOR      give up after this many seconds (default 1800)
//
// Reads only.
// ============================================================================
import hre from "hardhat";
import { formatUnits } from "viem";
import fs from "fs";
import path from "path";

const man = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"),
);
const ARENA = man.contracts.Arena.address as `0x${string}`;
const BANK = man.contracts.PerpDesks.marginBank as `0x${string}`;

const BANK_ABI = [{
  name: "getPosition", type: "function", stateMutability: "view",
  inputs: [{ type: "address" }, { type: "address" }],
  outputs: [
    { name: "size", type: "int128" }, { name: "avgEntryPrice", type: "uint128" },
    { name: "entryFundingIndex", type: "int256" }, { name: "lastUpdatedTimestampNs", type: "uint64" },
  ],
}] as const;

const DESK_ABI = [{
  name: "market", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }],
}] as const;

async function main() {
  const duelId = BigInt(process.env.DUEL ?? 0);
  if (duelId === 0n) throw new Error("set DUEL=<id>");
  const every = Number(process.env.EVERY ?? 10) * 1000;
  const until = Date.now() + Number(process.env.FOR ?? 1800) * 1000;

  const pub = await hre.viem.getPublicClient();
  const arena = await hre.viem.getContractAt("Arena", ARENA);

  const desks = (await arena.read.duelPoolsOf([duelId])) as `0x${string}`[];
  const duel = (await arena.read.duels([duelId])) as any[];
  const fighters = [Number(duel[0]), Number(duel[1])];

  // The duel records DESKS; the bank keys positions by the MARKET behind each desk.
  // Resolving that once up front is what makes every poll a plain read.
  const markets: { desk: string; market: `0x${string}` }[] = [];
  for (const d of desks) {
    if (/^0x0+$/.test(d)) continue;
    try {
      const mkt = await pub.readContract({ address: d, abi: DESK_ABI, functionName: "market" }) as `0x${string}`;
      markets.push({ desk: d, market: mkt });
    } catch { /* a desk that will not name its market cannot be watched */ }
  }
  if (!markets.length) throw new Error(`duel ${duelId} has no perps desks — is it a perps fight?`);

  const accounts: Record<number, `0x${string}`> = {};
  for (const f of fighters) {
    const r = (await arena.read.perpPositionOf([duelId, f])) as readonly unknown[];
    accounts[f] = r[3] as `0x${string}`;
  }

  while (Date.now() < until) {
    for (const f of fighters) {
      const acct = accounts[f];
      if (!acct || /^0x0+$/.test(acct)) continue;
      for (const { market } of markets) {
        try {
          const p = await pub.readContract({
            address: BANK, abi: BANK_ABI, functionName: "getPosition", args: [acct, market],
          }) as readonly [bigint, bigint, bigint, bigint];
          const size = p[0];
          if (size !== 0n) {
            const dir = size > 0n ? "LONG " : "SHORT";
            console.log(
              `OPEN duel ${duelId} fighter ${f} ${dir} size ${size} entry ${formatUnits(p[1], 18)} ` +
              `market ${market} — screenshot /duel/${duelId} NOW`,
            );
          }
        } catch { /* one unreadable market must not stop the watch */ }
      }
    }
    // A duel that has resolved will never open another position.
    const st = Number(((await arena.read.duels([duelId])) as any[])[8]);
    if (st === 3) { console.log(`duel ${duelId} resolved — nothing more to catch`); return; }
    await new Promise((r) => setTimeout(r, every));
  }
  console.log(`gave up on duel ${duelId} — no position seen in the window`);
}

main().catch((e) => { console.error(e); process.exit(1); });
