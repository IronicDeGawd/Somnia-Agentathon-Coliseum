// ============================================================================
// probe-event-desk — deploy an EventDesk against a LIVE dreamDEX event-contract
// window and drive a full buy/sell round trip through it, exactly as Arena
// would. This is the proof that the translator works against the real thing,
// not just against a mock.
//
// Run:
//   pnpm exec hardhat run scripts/probe-event-desk.ts --network somnia
//
// Env:
//   PRIVATE_KEY — funded testnet key; stands in for Arena so it can trade.
// ============================================================================

import hre from "hardhat";
import { formatUnits, parseAbi, parseAbiItem } from "viem";

const SCALE = 10n ** 12n;
const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;

// MarketCreated on dreamDEX's market creator — the indexer-free discovery path.
const MARKET_CREATED = parseAbiItem(
  "event MarketCreated(bytes32 indexed marketId, address indexed market, address indexed pool, uint256 yesId, uint256 noId, address collateral, string asset, uint256 strike, uint64 tradingStart, uint64 expiry, uint256 oracleQuestionId, string question, uint64 intervalSec)",
);

const binaryPool = parseAbi([
  "function getBookLevels(bool isBid, uint64 numLevels) view returns ((uint256 price, uint256 quantity)[])",
  "function marketExpiryNs() view returns (uint64)",
  "function getWithdrawableBalance(address user, address token) view returns (uint256)",
]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

async function main() {
  const pub = await hre.viem.getPublicClient();
  const [me] = await hre.viem.getWalletClients();
  console.log("caller (stands in for Arena):", me.account.address);

  // ── 1. find a live window with more life than a long duel needs ───────────
  const head = await pub.getBlockNumber();
  const now = Math.floor(Date.now() / 1000);
  const found: any[] = [];
  for (let i = 0; i < 40; i++) {
    const to = head - BigInt(i * 1000);
    try {
      const logs = await pub.getLogs({ event: MARKET_CREATED, fromBlock: to - 999n, toBlock: to });
      found.push(...logs.map((l) => l.args));
    } catch { /* range unavailable */ }
  }
  // Prefer the SHORTEST window that still has room for a few rounds. A window
  // expiring inside the hour is what makes Arena's hard-coded +3600s expiry
  // illegal — and that is the case the clamp exists for. Picking a long window
  // would let the order through without ever testing the translation.
  const MIN_LIFE = Number(process.env.MIN_LIFE_SEC ?? 300);
  const live = found
    .filter((a) => Number(a.expiry) > now + MIN_LIFE)
    .sort((a, b) => Number(a.expiry) - Number(b.expiry));
  if (!live.length) throw new Error(`no window with >${MIN_LIFE}s of life; try again shortly`);

  const m = live[0];
  console.log(`\nwindow : ${m.asset} ${Number(m.intervalSec) / 60}min`);
  console.log(`         pool=${m.pool}  expires in ${Number(m.expiry) - now}s`);

  // ── 2. deploy the desk, pointing it at this window ────────────────────────
  const desk = await hre.viem.deployContract("EventDesk", [me.account.address]);
  await desk.write.bind([m.pool]);
  console.log(`\ndesk deployed and bound: ${desk.address}`);
  console.log(`  collateral : ${await desk.read.collateral()}`);

  const [base, quote, , , tick, minQty, lot] = await desk.read.getPoolParams();
  console.log(`  grid (18dp): tick=${tick} minQuantity=${minQty} lot=${lot}`);
  console.log(`  base=${base}\n  quote=${quote}`);

  // ── 3. fund it, the way Arena funds a pool ────────────────────────────────
  console.log("\n-- funding via EventTreasury (the desk knows nothing about faucets) --");
  const treasury = await hre.viem.deployContract("EventTreasury", [quote]);
  await treasury.write.approveDesk([desk.address, true]);
  await treasury.write.refill([50n * 10n ** 6n]);
  const fundHash = await treasury.write.fundDesk([desk.address, 50n * 10n ** 6n]);
  await pub.waitForTransactionReceipt({ hash: fundHash });   // reads must not overtake the write
  const vault18 = await desk.read.getWithdrawableBalance([me.account.address, quote]);
  console.log(`  vault seen by Arena: ${formatUnits(vault18, 18)} (18dp)`);

  // ── 4. reads: the desk must agree with the raw pool, scaled ───────────────
  console.log("\n-- book, through the desk vs raw --");
  for (const isBid of [true, false]) {
    const raw = await pub.readContract({ address: m.pool, abi: binaryPool, functionName: "getBookLevels", args: [isBid, 1n] });
    const via = await desk.read.getBookLevels([isBid, 1n]);
    if (!raw.length || !via.length) { console.log(`  ${isBid ? "bid" : "ask"}: empty`); continue; }
    const ok = via[0].price === raw[0].price * SCALE;
    console.log(`  ${isBid ? "bid" : "ask"}: raw=${raw[0].price} desk=${via[0].price} ${ok ? "OK" : "MISMATCH"}`);
  }
  const bid = await desk.read.getBookLevels([true, 1n]);
  const ask = await desk.read.getBookLevels([false, 1n]);
  if (!ask.length) throw new Error("ask side empty — nothing to buy right now");
  const mid = (bid[0].price + ask[0].price) / 2n;
  console.log(`  midMarkPrice as Arena would compute it: ${formatUnits(mid, 18)}`);

  // ── 5. BUY through the desk. Arena passes a +3600s expiry; the pool would
  //       reject it outright. If this fills, the clamp works on the real pool.
  const arenaExpiry = BigInt(now + 3600) * 1_000_000_000n;
  const marketExpiry = await pub.readContract({ address: m.pool, abi: binaryPool, functionName: "marketExpiryNs" });
  console.log(`\n-- BUY via desk --`);
  console.log(`  Arena would send expiry ${arenaExpiry}`);
  console.log(`  market's own expiry is  ${marketExpiry}  (${arenaExpiry > marketExpiry ? "Arena's is TOO LATE — clamp required" : "within range"})`);

  const qty18 = 10n ** 18n;                       // one whole contract
  const limit18 = ask[0].price + 50_000n * SCALE; // pay up to +5c
  let hash = await desk.write.placeOrder([true, 0n, limit18, qty18, arenaExpiry, 0, 0, ZERO, 0n]);
  await pub.waitForTransactionReceipt({ hash });
  console.log(`  filled: ${hash}`);
  console.log(`  YES held (18dp): ${formatUnits(await desk.read.yesBalance18(), 18)}`);

  // ── 6. the sweep: nothing may be left loose on the desk ───────────────────
  const loose = await pub.readContract({ address: quote, abi: erc20, functionName: "balanceOf", args: [desk.address] });
  console.log(`  loose collateral on desk after fill: ${formatUnits(loose, 6)} ${loose === 0n ? "(swept)" : "(NOT SWEPT)"}`);

  // ── 7. SELL it back ───────────────────────────────────────────────────────
  console.log(`\n-- SELL via desk --`);
  const bid2 = await desk.read.getBookLevels([true, 1n]);
  if (!bid2.length) { console.log("  bid side empty; holding to expiry instead"); }
  else {
    const held = await desk.read.yesBalance18();
    const sellLimit = bid2[0].price > 50_000n * SCALE ? bid2[0].price - 50_000n * SCALE : 1000n * SCALE;
    hash = await desk.write.placeOrder([false, 0n, sellLimit, held, arenaExpiry, 0, 0, ZERO, 0n]);
    await pub.waitForTransactionReceipt({ hash });
    console.log(`  sold: ${hash}`);
    console.log(`  YES held (18dp): ${formatUnits(await desk.read.yesBalance18(), 18)}`);
  }

  const finalVault = await desk.read.getWithdrawableBalance([me.account.address, quote]);
  const finalLoose = await pub.readContract({ address: quote, abi: erc20, functionName: "balanceOf", args: [desk.address] });
  console.log(`\n=== RESULT ===`);
  console.log(`  vault as Arena sees it: ${formatUnits(finalVault, 18)}`);
  console.log(`  loose on desk:          ${formatUnits(finalLoose, 6)}`);
  console.log(`  resolvedPrice18:        ${await desk.read.resolvedPrice18()} (max = still trading)`);
  console.log(`  desk: ${desk.address}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
