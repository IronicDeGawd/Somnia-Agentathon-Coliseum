// check-liquidations — did the venue ever liquidate one of our fighters, and when?
//
// THIS IS THE ANSWER TO "HOW DO WE SHOW MARGIN STATES ON A FIGHT THAT IS OVER".
//
// A margin state cannot be asked for after the fact: it is a live calculation, and
// the link from a fighter to its rented trading account is deleted at the final
// bell, so the registry answers "healthy" forever. For a long time that looked like
// the end of it.
//
// It is not, because a liquidation is something the venue DOES, and the venue writes
// down what it does. `LiquidationEngine.AccountLiquidated` is indexed by account and
// carries `marginStatusBefore` and `marginStatusAfter` — the exact numbers the UI
// renders. So the drama is permanent; we were asking the wrong contract.
//
// What is NOT recoverable this way is a plain margin call, because that is a
// threshold being crossed rather than an action anyone takes. Nothing emits it.
//
// Addresses come from the protocol's own testnet manifest
// (somnia-chain/somnia-dex-protocol, deployments/testnet/perps-protocol.json). The
// margin bank does not expose a getter for the engine — `liquidationEngine()`
// reverts — so it is pinned here rather than discovered.
//
//   DUELS=80,83 pnpm exec hardhat run scripts/check-liquidations.ts --network somnia
//   FROM=60 pnpm exec hardhat run scripts/check-liquidations.ts --network somnia
//
// Env:
//   DUELS  comma-separated duel ids. Or FROM=<id> to sweep from there to the newest.
//   ENGINE override the liquidation engine address.
import hre from "hardhat";
import { formatUnits, parseAbiItem } from "viem";
import fs from "fs";
import path from "path";

/** From the protocol's testnet manifest. Pinned: the bank will not name it. */
const LIQUIDATION_ENGINE = "0xe01ef816783DC5f95B1982cacF9d0E3DB1bC2f28";

const ACCOUNT_LIQUIDATED = parseAbiItem(
  "event AccountLiquidated(address indexed account, uint256 positionsProcessed, uint8 stageReached, uint8 marginStatusBefore, uint8 marginStatusAfter)",
);
const POSITION_LIQUIDATED = parseAbiItem(
  "event PositionLiquidated(address indexed account, address indexed perpPool, int128 sizeDelta, uint256 markPrice)",
);
const LEASED = parseAbiItem(
  "event Leased(uint256 indexed duelId, uint8 indexed fighterId, address indexed account, uint256 budget)",
);

const STATUS = ["healthy", "margin call", "partial liquidation", "close-out"];
const statusWord = (s: number) => STATUS[s] ?? `unknown (${s})`;

const CHUNK = 1000n;

/**
 * getLogs in windows the public node will actually answer.
 *
 * Counts refusals and reports them. A window wider than the node's cap comes back
 * as an empty result rather than an error, so silence and "nothing happened" look
 * identical — measured on this very venue, where 5,000 blocks returned nothing while
 * 1,000 returned 260.
 */
async function scan(pub: any, args: any): Promise<{ logs: any[]; refused: number; windows: number }> {
  const out: any[] = [];
  let refused = 0, windows = 0;
  for (let b = args.fromBlock; b <= args.toBlock; b += CHUNK) {
    const to = b + CHUNK - 1n > args.toBlock ? args.toBlock : b + CHUNK - 1n;
    windows++;
    try {
      out.push(...await pub.getLogs({ ...args, fromBlock: b, toBlock: to }));
    } catch { refused++; }
  }
  return { logs: out, refused, windows };
}

async function main() {
  const m = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "deployments", `${hre.network.name}.json`), "utf-8"));
  const arena    = m.contracts.Arena.address as `0x${string}`;
  const registry = m.contracts.PerpDesks.registry as `0x${string}`;
  const engine   = (process.env.ENGINE ?? LIQUIDATION_ENGINE) as `0x${string}`;

  const pub = await hre.viem.getPublicClient();
  const arenaC = await hre.viem.getContractAt("Arena", arena);
  const nextId = await arenaC.read.nextDuelId() as bigint;

  const ids = process.env.DUELS
    ? process.env.DUELS.split(",").map((s) => BigInt(s.trim()))
    : Array.from(
        { length: Number(nextId) - Number(process.env.FROM ?? 1) },
        (_, i) => BigInt(Number(process.env.FROM ?? 1) + i),
      );

  console.log(`engine ${engine}   registry ${registry}`);
  let anyFound = false, totalRefused = 0;

  for (const duelId of ids) {
    const d = await arenaC.read.duels([duelId]) as any[];
    const startBlock = d[3] as bigint;
    const lastTurn   = d[4] as bigint;
    const turns      = Number(d[6]);
    if (startBlock === 0n) continue;

    // Which accounts this fight rented. Read rather than assumed: the pool of
    // accounts is reused across fights, so an address alone means nothing without
    // the fight it was leased for.
    const to = (lastTurn > startBlock ? lastTurn : startBlock) + 1500n;
    const leased = await scan(pub, { address: registry, event: LEASED, args: { duelId }, fromBlock: startBlock, toBlock: to });
    totalRefused += leased.refused;
    const accounts = leased.logs.map((l: any) => l.args.account as `0x${string}`);
    if (accounts.length === 0) continue;   // not a perps fight

    let hits = 0;
    for (const [label, ev] of [["ACCOUNT", ACCOUNT_LIQUIDATED], ["POSITION", POSITION_LIQUIDATED]] as const) {
      for (const account of accounts) {
        const r = await scan(pub, { address: engine, event: ev as any, args: { account }, fromBlock: startBlock, toBlock: to });
        totalRefused += r.refused;
        for (const l of r.logs) {
          const a = l.args as any;
          hits++; anyFound = true;
          if (label === "ACCOUNT") {
            console.log(
              `  duel ${duelId}  ${account.slice(0, 10)}  LIQUIDATED  ` +
              `${statusWord(Number(a.marginStatusBefore))} -> ${statusWord(Number(a.marginStatusAfter))}  ` +
              `stage ${a.stageReached}, ${a.positionsProcessed} position(s)  blk ${l.blockNumber}`,
            );
          } else {
            console.log(
              `  duel ${duelId}  ${account.slice(0, 10)}  position closed by venue  ` +
              `size delta ${a.sizeDelta} at ${formatUnits(a.markPrice, 18)}  blk ${l.blockNumber}`,
            );
          }
        }
      }
    }
    if (hits === 0) {
      console.log(`  duel ${duelId}  ${turns}r  ${accounts.length} account(s) — no liquidation`);
    }
  }

  if (!anyFound) {
    console.log("\n  No liquidation has ever happened to one of our fighters.");
    console.log("  That is the honest result, not a broken query: the states have never been reached.");
  }
  if (totalRefused > 0) {
    console.log(`\n  !! ${totalRefused} block windows were refused — the findings above are a floor, not a total.`);
  }
}

main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exit(1); });
