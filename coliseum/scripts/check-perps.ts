// ============================================================================
// check-perps — where all the perps money is, and what is stuck.
//
// The perps equivalent of check-arena-vaults.ts, and it needs to exist for a
// reason that does not apply to the other markets: on spot and events the money
// sits in pool vaults at addresses the manifest already names, so you can read it
// with three calls. On perps it is spread across the float and a growing set of
// per-fighter accounts, each a separate contract holding real collateral. If you
// cannot enumerate those, you cannot tell whether anything is missing.
//
// Run:
//   pnpm exec hardhat run scripts/check-perps.ts --network somnia
//
// Env:
//   ACCOUNTS=1  — list every account, not just the ones holding something.
//
// Reads only. Nothing here sends a transaction.
//
// If it reports stuck collateral, the recovery sequence is:
//   1. registry.forceClose(account, market, isBid, price, quantity)  — owner picks
//      a price aggressive enough to actually clear the book
//   2. registry.retryRelease(duelId, fighterId)                      — flattens,
//      drains, un-quarantines, returns the account to circulation
//   Or, when a position can never be closed:
//   3. registry.rescueAccount(account)  — takes back whatever the bank will
//      release, leaving the position open. Worth re-running later: a stuck
//      position's margin requirement moves with the market's open-interest factor,
//      so collateral frozen behind it frees up over time.
// ============================================================================

import hre from "hardhat";
import { formatUnits } from "viem";
import fs from "fs";
import path from "path";

const MARGIN_STATUS = ["Healthy", "MarginCall", "PartialLiquidation", "CloseOut"];

/** 18-decimal USDso, padded so columns line up. */
const usd = (v: bigint, width = 12) => formatUnits(v, 18).padStart(width);

async function main() {
  const manifestPath = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

  const perps = manifest.contracts.PerpDesks;
  if (!perps?.registry) {
    console.log("No contracts.PerpDesks in the manifest — perps is not deployed on this network.");
    return;
  }

  const arenaAddr = manifest.contracts.Arena.address as `0x${string}`;
  const usdsoAddr = manifest.external.usdso as `0x${string}`;

  const registry = await hre.viem.getContractAt("PerpAccountRegistry", perps.registry as `0x${string}`);
  const arena = await hre.viem.getContractAt("Arena", arenaAddr);
  const token = await hre.viem.getContractAt("MockERC20", usdsoAddr);

  console.log(`Arena:    ${arenaAddr}`);
  console.log(`Registry: ${perps.registry}`);
  console.log(`Bank:     ${perps.marginBank}\n`);

  // ── Wiring ───────────────────────────────────────────────────────────────
  const [ready, wired] = await arena.read.perpStatus() as [boolean, string];
  console.log(`Arena wired to registry: ${ready ? "yes" : "NO"} (${wired})`);
  if (ready && wired.toLowerCase() !== (perps.registry as string).toLowerCase()) {
    // The manifest and the chain disagreeing about which registry is live is the
    // one wiring fault that leaves collateral somewhere nothing points at.
    console.log("  *** MISMATCH: Arena points at a DIFFERENT registry than the manifest records.");
    console.log("  *** The manifest's registry may still hold collateral nothing is watching.");
  }

  // ── The float ────────────────────────────────────────────────────────────
  const float = await registry.read.floatBalance() as bigint;
  const free = await registry.read.freeCount() as bigint;
  const total = await registry.read.accountCount() as bigint;
  console.log(`\nFloat (unlent):   ${usd(float)} USDso`);
  console.log(`Accounts:         ${total} total, ${free} free to lease`);

  // ── Every account ────────────────────────────────────────────────────────
  // Read in pages, because the list only grows and a single call would eventually
  // exceed the node's gas cap for a view.
  const accounts: string[] = [];
  for (let start = 0n; start < total; start += 50n) {
    accounts.push(...(await registry.read.accountsPaginated([start, 50n]) as string[]));
  }

  let postedTotal = 0n;
  let looseTotal = 0n;
  let stuckTotal = 0n;
  const stuck: { account: string; duelId: bigint; fighterId: number; equity: bigint; markets: string[] }[] = [];
  const rows: string[] = [];

  for (const account of accounts) {
    const r = await registry.read.accountReport([account]) as [
      bigint, boolean, boolean, boolean, bigint, bigint, number, bigint, string[],
    ];
    const [tag, leased, quarantined, priceable, equity, imReq, status, loose, openMarkets] = r;
    const [duelId, fighterId] = await registry.read.unpackTag([tag]) as [bigint, number];

    const posted = equity > 0n ? equity : 0n;
    postedTotal += posted;
    looseTotal += loose;

    const idle = !leased && !quarantined && posted === 0n && loose === 0n && openMarkets.length === 0;
    if (idle && process.env.ACCOUNTS !== "1") continue;

    const state = quarantined ? "STUCK" : (leased ? "in fight" : "idle");
    rows.push(
      `  ${account}  ${state.padEnd(9)}` +
      ` equity ${usd(equity, 11)}  margin req ${usd(imReq, 9)}` +
      `  ${priceable ? MARGIN_STATUS[status] ?? String(status) : "UNPRICEABLE"}` +
      (openMarkets.length ? `  open:${openMarkets.length}` : "") +
      (loose > 0n ? `  LOOSE ${usd(loose, 1)}` : "") +
      (tag !== 0n ? `  duel ${duelId}/f${fighterId}` : ""),
    );

    if (quarantined) {
      stuckTotal += posted;
      stuck.push({ account, duelId, fighterId, equity, markets: openMarkets });
    }
  }

  console.log(`Posted as margin: ${usd(postedTotal)} USDso  (sum of positive account equity)`);
  if (looseTotal > 0n) {
    // Collateral sitting in an account rather than posted means a deposit failed.
    console.log(`Loose in accounts:${usd(looseTotal)} USDso  *** a deposit failed; sweepAccountToken recovers it`);
  }
  console.log(`Perps total:      ${usd(float + postedTotal + looseTotal)} USDso`);

  if (rows.length) {
    console.log(`\nAccounts${process.env.ACCOUNTS === "1" ? "" : " holding something or in a fight"}:`);
    for (const row of rows) console.log(row);
  }

  // ── What is stuck ────────────────────────────────────────────────────────
  if (stuck.length === 0) {
    console.log("\nNothing quarantined. Every account either idle or in a live fight.");
  } else {
    console.log(`\n*** ${stuck.length} QUARANTINED — collateral out of circulation: ${usd(stuckTotal, 1)} USDso`);
    for (const s of stuck) {
      console.log(`  ${s.account}  duel ${s.duelId} fighter ${s.fighterId}  equity ${usd(s.equity, 1)}`);
      for (const market of s.markets) {
        // Print the size and which way, because the recovery order has to be the
        // opposite side and exactly this quantity.
        const [size] = await hre.viem.getContractAt("MockMarginBank", perps.marginBank as `0x${string}`)
          .then((b) => b.read.getPosition([s.account, market as `0x${string}`])) as [bigint, bigint, bigint, bigint];
        const name = (perps.desks as { market: string; perpPool: string }[])
          .find((d) => d.perpPool.toLowerCase() === market.toLowerCase())?.market ?? market;
        console.log(`      ${name}: size ${size} — close with forceClose(isBid=${size < 0n}, quantity=${size < 0n ? -size : size})`);
      }
    }
  }

  // ── The markets, and what each tier would be offered right now ───────────
  console.log("\nMargin for one smallest position, right now:");
  for (const d of perps.desks as { market: string; perpPool: string }[]) {
    const [tradable, im] = await registry.read.marketCost([d.perpPool as `0x${string}`]) as [boolean, bigint];
    console.log(`  ${d.market.padEnd(4)} ${tradable ? usd(im, 10) : "untradable".padStart(10)}`);
  }

  console.log("\nWhat each tier would be offered if a fight started now:");
  for (const turns of [3, 6, 9, 15]) {
    const budget = await arena.read.perpBudgetFor([turns]) as bigint;
    try {
      const picked = await arena.read.perpMarketsFor([turns]) as string[];
      const names = picked.map((a) =>
        (perps.desks as { market: string; desk: string }[])
          .find((d) => d.desk.toLowerCase() === a.toLowerCase())?.market ?? "?");
      console.log(`  ${String(turns).padStart(2)} rounds, ${usd(budget, 6)} USDso: ${names.join(" ")}`);
    } catch {
      console.log(`  ${String(turns).padStart(2)} rounds, ${usd(budget, 6)} USDso: FEWER THAN THREE MARKETS QUALIFY — the tier cannot start`);
    }
  }

  // ── Can the float still start fights? ────────────────────────────────────
  // Worth stating outright, because a short float is the failure that presents as
  // "the queue is broken" rather than as anything about money.
  const topTier = await arena.read.perpBudgetFor([15]) as bigint;
  const fightsFundable = float / (topTier * 2n);
  console.log(`\nTop-tier fights the float can still fund: ${fightsFundable}`);
  if (fightsFundable === 0n) {
    console.log("  *** The float cannot fund a top-tier fight. Starts will revert FloatTooSmall,");
    console.log("  *** which reaches the player as a failed queue with no explanation.");
    console.log("  *** Top it up with arena.fundPerpFloat(amount).");
  }

  const arenaUsdso = await token.read.balanceOf([arenaAddr]) as bigint;
  const escrowed = await arena.read.escrowedPot() as bigint;
  const seed = await arena.read.seedLiquidity() as bigint;
  console.log(`\nArena USDso ${usd(arenaUsdso, 1)}  (escrowed pots ${usd(escrowed, 1)}, owner seed ${usd(seed, 1)})`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
