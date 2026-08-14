// ============================================================================
// bind-event-window — point two idle EventDesks at live prediction windows and
// register them with Arena as the WETH and WBTC slots.
//
// Arena keeps its cheap SOMI spot book in the third slot, so a fight trades one
// real coin and two questions. Every fight records its own market set, so
// re-pointing the desks between fights cannot disturb a fight already running.
//
// Run:
//   pnpm exec hardhat run scripts/bind-event-window.ts --network somnia
//
// Env:
//   MIN_LIFE_SEC — window must outlive this, in seconds (default 1200).
//   INTERVALS    — acceptable window lengths in minutes, preferred first
//                  (default "60,240"). The shortest acceptable one wins, because
//                  a shorter window's odds move more over a fight.
//   FUND_EACH    — collateral per desk, whole tokens; default from the manifest.
//   RELEASE      — set to 1 to mark every desk free and exit, without binding.
// ============================================================================

import hre from "hardhat";
import { formatUnits, parseAbiItem } from "viem";
import fs from "fs";
import path from "path";

const MARKET_CREATED = parseAbiItem(
  "event MarketCreated(bytes32 indexed marketId, address indexed market, address indexed pool, uint256 yesId, uint256 noId, address collateral, string asset, uint256 strike, uint64 tradingStart, uint64 expiry, uint256 oracleQuestionId, string question, uint64 intervalSec)",
);

// Windows are only ever published in this log — the pool cannot be asked which
// market it is, and without the id a settled position can never be claimed.
// The indexer is unreliable, so the logs are read directly.
const SCAN_CHUNKS = 200;
const CHUNK = 1000n;

/// A slot's question in a few characters. It becomes part of the action name the
/// model answers with, so it must contain no spaces and no digits.
const NO_LABEL = "0x0000000000000000" as `0x${string}`;
const label = (s: string) =>
  ("0x" + Buffer.from(s, "ascii").toString("hex").padEnd(16, "0")) as `0x${string}`;

type Window = {
  asset: string; pool: `0x${string}`; marketId: `0x${string}`;
  expiry: number; intervalSec: number;
};

async function main() {
  const manifestPath = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const ev = manifest.contracts.EventDesks;
  if (!ev) throw new Error("no contracts.EventDesks in the manifest — run deploy-event-desks.ts first");

  const pub = await hre.viem.getPublicClient();
  const arena = await hre.viem.getContractAt("Arena", manifest.contracts.Arena.address);
  const treasury = await hre.viem.getContractAt("EventTreasury", ev.treasury);
  const desks = await Promise.all(
    (ev.desks as `0x${string}`[]).map((d) => hre.viem.getContractAt("EventDesk", d)),
  );

  if (process.env.RELEASE === "1") {
    for (const desk of desks) {
      if (!(await desk.read.inUse())) continue;
      const hash = await desk.write.setInUse([false]);
      await pub.waitForTransactionReceipt({ hash });
      console.log(`released ${desk.address}`);
    }
    return;
  }

  // ── pick the windows ──────────────────────────────────────────────────────
  const minLife = Number(process.env.MIN_LIFE_SEC ?? 1200);
  const intervals = (process.env.INTERVALS ?? "60,240").split(",").map((s) => Number(s.trim()) * 60);
  const now = Math.floor(Date.now() / 1000);

  const live = (await scanWindows(pub)).filter(
    (w) => w.expiry > now + minLife && intervals.includes(w.intervalSec),
  );

  const pick = (asset: string): Window => {
    const forAsset = live
      .filter((w) => w.asset.toUpperCase() === asset)
      // Shortest acceptable interval first; among equals, the one expiring last.
      .sort((a, b) => intervals.indexOf(a.intervalSec) - intervals.indexOf(b.intervalSec) || b.expiry - a.expiry);
    if (!forAsset.length) {
      throw new Error(
        `no ${asset} window of ${intervals.map((i) => i / 60).join("/")}min with >${minLife}s left. ` +
        `Hourly windows are only this long for part of each hour — wait, lower MIN_LIFE_SEC, or add 240 to INTERVALS.`,
      );
    }
    return forAsset[0];
  };

  const chosen = { ETH: pick("ETH"), BTC: pick("BTC") };
  for (const [asset, w] of Object.entries(chosen)) {
    console.log(`${asset}: ${w.intervalSec / 60}min window, ${w.expiry - now}s left  pool ${w.pool}`);
  }

  // ── claim two idle desks ──────────────────────────────────────────────────
  const free: typeof desks = [];
  for (const desk of desks) if (!(await desk.read.inUse())) free.push(desk);
  if (free.length < 2) {
    throw new Error(`only ${free.length} idle desk(s); a finished fight has not released its desks. Run with RELEASE=1.`);
  }

  const fundEach = BigInt(process.env.FUND_EACH ?? "0") * 10n ** 6n || BigInt(ev.fundEach ?? "50000000");
  const bound: Record<string, `0x${string}`> = {};

  for (const [asset, w] of [["ETH", chosen.ETH], ["BTC", chosen.BTC]] as [string, Window][]) {
    const desk = free.shift()!;

    // bind() retreats from any previous window first, collecting winnings and
    // pulling collateral back, so nothing is stranded in a pool nobody watches.
    let hash = await desk.write.bind([w.pool, w.marketId]);
    await pub.waitForTransactionReceipt({ hash });

    // Only now is there a vault to fund. Top up to the target rather than adding
    // blindly, so a desk carrying winnings from a previous window is not doubled.
    const held6 = ((await desk.read.getWithdrawableBalance([manifest.contracts.Arena.address, ev.collateral])) as bigint) / 10n ** 12n;
    if (held6 < fundEach) {
      const need = fundEach - held6;
      hash = await treasury.write.fundDesk([desk.address, need]);
      await pub.waitForTransactionReceipt({ hash });
    }

    hash = await desk.write.setInUse([true]);
    await pub.waitForTransactionReceipt({ hash });

    const vault = (await desk.read.getWithdrawableBalance([manifest.contracts.Arena.address, ev.collateral])) as bigint;
    console.log(`${asset} desk ${desk.address} bound and holding ${formatUnits(vault, 18)}`);
    bound[asset] = desk.address;
  }

  // ── register with Arena ───────────────────────────────────────────────────
  // The slots are [WETH, WBTC, SOMI]; the SOMI slot keeps the real spot pool,
  // which is already cheap enough. Both desks present 18 decimals to Arena.
  //
  // The labels become the words a fighter reads and answers with, so the SOMI
  // slot is deliberately left unlabelled — it really is a coin, and calling it a
  // question would describe its price as a probability.
  const somi = (await arena.read.POOL_SOMI()) as `0x${string}`;
  const hash = await arena.write.setEventDesks([
    [bound.ETH, bound.BTC, somi],
    [18, 18, 18],
    [label("ETHUP"), label("BTCUP"), NO_LABEL],
  ]);
  await pub.waitForTransactionReceipt({ hash });
  console.log(`\nArena event slots: ETH-Q ${bound.ETH}  BTC-Q ${bound.BTC}  SOMI ${somi}`);

  ev.bound = {
    ETH: { desk: bound.ETH, pool: chosen.ETH.pool, marketId: chosen.ETH.marketId, expiry: chosen.ETH.expiry },
    BTC: { desk: bound.BTC, pool: chosen.BTC.pool, marketId: chosen.BTC.marketId, expiry: chosen.BTC.expiry },
    somiPool: somi,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Recorded the binding under contracts.EventDesks.bound`);
}

async function scanWindows(pub: any): Promise<Window[]> {
  const head = await pub.getBlockNumber();
  const out: Window[] = [];
  for (let i = 0; i < SCAN_CHUNKS; i++) {
    const to = head - BigInt(i) * CHUNK;
    if (to <= CHUNK) break;
    try {
      const logs = await pub.getLogs({ event: MARKET_CREATED, fromBlock: to - (CHUNK - 1n), toBlock: to });
      for (const l of logs) {
        out.push({
          asset: String(l.args.asset),
          pool: l.args.pool,
          marketId: l.args.marketId,
          expiry: Number(l.args.expiry),
          intervalSec: Number(l.args.intervalSec),
        });
      }
    } catch { /* range unavailable */ }
  }
  return out;
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.shortMessage ?? e); process.exit(1); });
