// ============================================================================
// probe-perps — answer the load-bearing questions of the perps plan against the
// LIVE dreamDEX perpetuals protocol, before any Arena code is written.
//
// Everything asserted in context/plan/perps-market.md about the protocol was READ
// out of the org's Solidity, not observed. This script observes it. If any check
// below fails, the plan changes shape rather than the implementation working
// around it.
//
//   pnpm exec hardhat run scripts/probe-perps.ts --network somnia
//
// Env: PRIVATE_KEY — funded testnet key. Needs ~25 USDso and a little STT.
//      MARKET=BTC|ETH|SOL  (default BTC — the most expensive, so the worst case)
// ============================================================================

import hre from "hardhat";
import { formatEther, formatUnits, parseAbi, keccak256, toHex, type Address } from "viem";

const MARGIN_BANK = "0xdd4A14A2763FDa39b9759D2D4150DB0e0f085C4E" as Address;
const USDSO       = "0x9c32F3827A1a99f0cf9B213de8b53eC3d57bb171" as Address;

const MARKETS: Record<string, { pool: Address; baseDecimals: number; label: string }> = {
  BTC: { pool: "0x3892A5179F8eA0C810c45d1630546c0317b0e5B6", baseDecimals: 8,  label: "BTC-PERP" },
  ETH: { pool: "0x6A7224a4Ad765D6134c4F29200E67B1f6b62c29e", baseDecimals: 18, label: "ETH-PERP" },
  SOL: { pool: "0x4d3892D19e684677615b83ec2c912085A08472aF", baseDecimals: 9,  label: "SOL-PERP" },
};

const poolAbi = parseAbi([
  "function getBookLevels(bool isBid, uint64 numLevels) view returns ((uint256 price, uint256 quantity)[])",
  "function tryGetMarkPrice() view returns (bool ok, uint256 price)",
  "function getOneBase() view returns (uint256)",
  "function getEffectiveIMF() view returns (uint256)",
  "function getOrderBookParameters() view returns (uint256 tickSize, uint256 minQuantity, uint256 lotSize)",
  "function marginBank() view returns (address)",
  "function isRestricted() view returns (bool)",
]);
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function mint(address,uint256)",
]);

/// The five typed rejections the order book reverts with, plus the margin ones we
/// might trip. Named so a refusal is identified rather than merely observed — the
/// whole point of proving these is knowing WHICH one fired.
const KNOWN_ERRORS = [
  "FillOrKillNotFillable()", "ImmediateOrCancelNoFill()", "PostOnlyWouldCross()",
  "SelfMatchCancelTaker()", "OrderAlreadyExpired()", "OnlyApprovedContracts()",
  "QuantityBelowMinimum()", "InvalidPrice()", "InvalidQuantity()",
  "InsufficientMarginAfterWithdrawal()", "InsufficientCollateral()",
  "InsufficientMargin()", "MarketRestricted()", "FillPriceOutsideBand()",
  "InvalidAmount()", "WithdrawalBelowCreditFloor()",
];
const SIGS = new Map(KNOWN_ERRORS.map((s) => [keccak256(toHex(s)).slice(0, 10), s]));
function nameError(raw: string | undefined): string {
  if (!raw || raw === "0x") return "revert with no data";
  const sel = raw.slice(0, 10);
  return SIGS.get(sel) ?? `unrecognised selector ${sel}`;
}

const results: { q: string; verdict: "PASS" | "FAIL" | "INFO"; detail: string }[] = [];
function record(q: string, verdict: "PASS" | "FAIL" | "INFO", detail: string) {
  results.push({ q, verdict, detail });
  const tag = verdict === "PASS" ? "  ok  " : verdict === "FAIL" ? " FAIL " : " info ";
  console.log(`[${tag}] ${q}\n         ${detail}`);
}

async function main() {
  const which = (process.env.MARKET ?? "BTC").toUpperCase();
  const m = MARKETS[which];
  if (!m) throw new Error(`MARKET must be one of ${Object.keys(MARKETS).join(", ")}`);

  const pub = await hre.viem.getPublicClient();
  const [me] = await hre.viem.getWalletClients();
  console.log(`\n=== perps probe — ${m.label} ===`);
  console.log(`caller : ${me.account.address}`);
  console.log(`pool   : ${m.pool}\n`);

  // ── The market, as it stands right now ────────────────────────────────────
  const read = <T,>(fn: string, args: any[] = []) =>
    pub.readContract({ address: m.pool, abi: poolAbi, functionName: fn as any, args }) as Promise<T>;

  const [tickSize, minQuantity, lotSize] = await read<[bigint, bigint, bigint]>("getOrderBookParameters");
  const oneBase     = await read<bigint>("getOneBase");
  const [markOk, mark] = await read<[boolean, bigint]>("tryGetMarkPrice");
  const effIMF      = await read<bigint>("getEffectiveIMF");
  const restricted  = await read<boolean>("isRestricted");
  const bankOnPool  = await read<Address>("marginBank");
  const bid = await read<{ price: bigint; quantity: bigint }[]>("getBookLevels", [true, 1n]);
  const ask = await read<{ price: bigint; quantity: bigint }[]>("getBookLevels", [false, 1n]);

  if (!bid.length || !ask.length) throw new Error("book is one-sided right now; retry shortly");
  if (restricted) throw new Error("market is close-only right now; retry shortly");

  const notional1Lot = (minQuantity * mark) / oneBase;
  console.log(`tick=${formatEther(tickSize)}  minQuantity=${formatUnits(minQuantity, m.baseDecimals)}  lot=${formatUnits(lotSize, m.baseDecimals)}`);
  console.log(`oneBase=${oneBase} (10^${m.baseDecimals})   markPrice=${formatEther(mark)} (fresh=${markOk})`);
  console.log(`bid=${formatEther(bid[0].price)} x ${formatUnits(bid[0].quantity, m.baseDecimals)}   ask=${formatEther(ask[0].price)} x ${formatUnits(ask[0].quantity, m.baseDecimals)}`);
  console.log(`notional of ONE minimum lot = ${formatEther(notional1Lot)} USDso\n`);

  record(
    "marginBank on the pool matches the manifest",
    bankOnPool.toLowerCase() === MARGIN_BANK.toLowerCase() ? "PASS" : "FAIL",
    `pool reports ${bankOnPool}`,
  );
  record(
    "effective IMF vs the static 500bps in config",
    "INFO",
    `getEffectiveIMF()=${effIMF} bps → margin for one lot ≈ ${formatEther((notional1Lot * effIMF) / 10000n)} USDso ` +
    `(static 500bps would predict ${formatEther((notional1Lot * 500n) / 10000n)})`,
  );

  // ── Q0. Is minting collateral really permissionless? ──────────────────────
  // Not load-bearing for the design, but it decides whether funding six fighter
  // accounts a fight needs a faucet operator or one call.
  try {
    const h = await me.writeContract({ address: USDSO, abi: erc20, functionName: "mint", args: [me.account.address, 10n ** 18n] });
    await pub.waitForTransactionReceipt({ hash: h });
    record("Q0 collateral mint is permissionless", "PASS", "minted 1 USDso to self");
  } catch (e: any) {
    record("Q0 collateral mint is permissionless", "INFO", `refused: ${nameError(e?.data ?? e?.cause?.data)} — fall back to existing balance`);
  }

  // ── Deploy the probe ──────────────────────────────────────────────────────
  const probe = await hre.viem.deployContract("PerpProbe", [USDSO, MARGIN_BANK]);
  console.log(`\nprobe deployed: ${probe.address}\n`);

  // ── Q2. Can a contract hold margin? ───────────────────────────────────────
  const DEPOSIT = 25n * 10n ** 18n;
  const ah = await me.writeContract({ address: USDSO, abi: erc20, functionName: "approve", args: [probe.address, DEPOSIT] });
  await pub.waitForTransactionReceipt({ hash: ah });
  try {
    const h = await probe.write.fund([DEPOSIT]);
    await pub.waitForTransactionReceipt({ hash: h });
    record("Q2 a CONTRACT can deposit margin (no KYC / linked-wallet gate)", "PASS", `deposited ${formatEther(DEPOSIT)} USDso`);
  } catch (e: any) {
    record("Q2 a CONTRACT can deposit margin", "FAIL", nameError(e?.data ?? e?.cause?.data));
    throw new Error("cannot fund the probe — everything below depends on it");
  }

  const show = async (when: string) => {
    const s = await probe.read.state([m.pool]) as [boolean, bigint, bigint, bigint, bigint, number];
    const [ok, equity, withdrawable, size, entry, status] = s;
    console.log(
      `    ${when.padEnd(22)} equity=${ok ? formatEther(equity) : "STALE"}  withdrawable=${formatEther(withdrawable)}  ` +
      `size=${formatUnits(size, m.baseDecimals)}  entry=${entry === 0n ? "-" : formatEther(entry)}  status=${status}`,
    );
    return { ok, equity, withdrawable, size, entry, status };
  };
  const opened = await show("after funding");

  // ── Q1 + Q3. A contract places its OWN order, and a FLAT account goes SHORT.
  // Aggressive enough to cross the resting bid, but only a few ticks through it so
  // the fill-price band cannot trip. IOC, so a partial fill is kept.
  const sellPrice = bid[0].price - 10n * tickSize;
  let short: Awaited<ReturnType<typeof show>>;
  try {
    const h = await probe.write.trade([m.pool, false, 4919n /* userData round-trip */, sellPrice, minQuantity, 2]);
    await pub.waitForTransactionReceipt({ hash: h });
    short = await show("after SHORT 1 lot");
    record(
      "Q1 a CONTRACT can place its own perp order (no allowlisting)",
      "PASS",
      "plain placeOrder admitted from a contract — the OnlyApprovedContracts gate really is only on the ...For variants",
    );
    record(
      "Q3 a FLAT account can go SHORT",
      short.size < 0n ? "PASS" : "FAIL",
      `position size = ${formatUnits(short.size, m.baseDecimals)} (negative means genuinely short, not a refused sell)`,
    );
  } catch (e: any) {
    record("Q1 a CONTRACT can place its own perp order", "FAIL", nameError(e?.data ?? e?.cause?.data));
    throw new Error("contract trading is refused — the plan's whole account model is invalid");
  }

  // ── Margin actually consumed, against the plan's $3.24 prediction ─────────
  const marginUsed = opened.withdrawable - short.withdrawable;
  record(
    "margin actually consumed by one minimum lot",
    "INFO",
    `${formatEther(marginUsed)} USDso  (plan predicted ${formatEther((notional1Lot * effIMF) / 10000n)} from notional x effective IMF)`,
  );

  // ── Q4. Is equity marking the short correctly? ─────────────────────────────
  // The mark cannot be moved on demand, so assert the RELATIONSHIP instead:
  // equity must equal deposit + size x (mark - entry) / oneBase, sign included.
  // If that holds, a falling mark necessarily raises a short's score.
  const [, markNow] = await read<[boolean, bigint]>("tryGetMarkPrice");
  const pnl = (short.size * (markNow - BigInt(short.entry))) / oneBase;
  const expected = DEPOSIT + pnl;
  const drift = short.equity > expected ? short.equity - expected : expected - short.equity;
  record(
    "Q4 equity marks a SHORT with the correct sign",
    drift <= 10n ** 15n ? "PASS" : "FAIL",
    `equity=${formatEther(short.equity)} vs deposit+signedPnL=${formatEther(expected)} ` +
    `(entry=${formatEther(BigInt(short.entry))}, mark=${formatEther(markNow)}, drift=${formatEther(drift)}). ` +
    `Negative size x rising mark = loss, so a FALLING mark pays the short.`,
  );

  // ── Q5. Money is stuck while the position is open ─────────────────────────
  const [pullOk, pullErr] = await probe.simulate.tryPull([DEPOSIT]).then((r) => r.result as [boolean, string]);
  record(
    "Q5 withdrawal is REFUSED while a position is open",
    pullOk ? "FAIL" : "PASS",
    pullOk ? "withdrawal succeeded with a position open — the money-out asymmetry does not exist" : `refused with ${nameError(pullErr)}`,
  );

  // ── A non-crossing order REVERTS rather than returning false ──────────────
  // Arena's order path checks `if (!success)`. If a rejection reverts instead, the
  // try/catch is what saves the turn — worth proving, not assuming.
  const noCrossPrice = ask[0].price + 10n * tickSize;
  for (const [typeName, orderType] of [["FOK", 1], ["IOC", 2]] as const) {
    const [ok, , err] = await probe.simulate
      .tryTrade([m.pool, false, 0n, noCrossPrice, minQuantity, orderType])
      .then((r) => r.result as [boolean, bigint, string]);
    record(
      `a ${typeName} sell that crosses nothing is REJECTED, and by revert`,
      ok ? "FAIL" : "PASS",
      ok ? "it was accepted — expected a rejection" : `reverted with ${nameError(err)} (a custom error: catch Error(string) would NOT match)`,
    );
  }

  // ── Flip short -> long in ONE order, then flatten ─────────────────────────
  const buyPrice = ask[0].price + 10n * tickSize;
  const flipHash = await probe.write.trade([m.pool, true, 4920n, buyPrice, minQuantity * 2n, 2]);
  await pub.waitForTransactionReceipt({ hash: flipHash });
  const flipped = await show("after LONG 2 lots");
  record(
    "a single order flips SHORT -> LONG (closing is taking the other side)",
    flipped.size > 0n ? "PASS" : "FAIL",
    `size ${formatUnits(short.size, m.baseDecimals)} -> ${formatUnits(flipped.size, m.baseDecimals)} — no separate Close action needed`,
  );

  const flatHash = await probe.write.trade([m.pool, false, 4921n, sellPrice, flipped.size > 0n ? flipped.size : minQuantity, 2]);
  await pub.waitForTransactionReceipt({ hash: flatHash });
  const flat = await show("after FLATTEN");
  record(
    "position can be returned to flat",
    flat.size === 0n ? "PASS" : "FAIL",
    `size = ${formatUnits(flat.size, m.baseDecimals)}`,
  );

  // ── Q5b. Once flat, the money comes back ──────────────────────────────────
  const before = await pub.readContract({ address: USDSO, abi: erc20, functionName: "balanceOf", args: [me.account.address] }) as bigint;
  try {
    const h = await probe.write.pull([flat.withdrawable]);
    await pub.waitForTransactionReceipt({ hash: h });
    const after = await pub.readContract({ address: USDSO, abi: erc20, functionName: "balanceOf", args: [me.account.address] }) as bigint;
    record("Q5b once FLAT the margin comes back out", "PASS", `recovered ${formatEther(after - before)} USDso`);
    const cost = DEPOSIT > flat.withdrawable ? DEPOSIT - flat.withdrawable : 0n;
    record(
      "round-trip cost of short -> flip -> flatten",
      "INFO",
      `${formatEther(cost)} USDso of the ${formatEther(DEPOSIT)} deposited (spread + funding; fees are zero)`,
    );
  } catch (e: any) {
    record("Q5b once FLAT the margin comes back out", "FAIL", nameError(e?.data ?? e?.cause?.data));
  }

  const sh = await probe.write.sweep([USDSO]);
  await pub.waitForTransactionReceipt({ hash: sh });

  // ── Verdict ───────────────────────────────────────────────────────────────
  const failed = results.filter((r) => r.verdict === "FAIL");
  console.log(`\n=== ${results.filter(r => r.verdict === "PASS").length} passed, ${failed.length} failed, ` +
              `${results.filter(r => r.verdict === "INFO").length} measurements ===`);
  if (failed.length) {
    console.log("\nFAILURES — the plan needs revising before implementation:");
    for (const f of failed) console.log(`  - ${f.q}: ${f.detail}`);
    process.exitCode = 1;
  } else {
    console.log("\nEvery load-bearing assumption holds. Probe address (throwaway):", probe.address);
  }
}

main().catch((e) => { console.error(e?.shortMessage ?? e); process.exitCode = 1; });
