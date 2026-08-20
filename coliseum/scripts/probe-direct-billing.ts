// ============================================================================
// probe-direct-billing — does the venue bill a buyer directly, or only from a
// deposit it already holds?
//
// This is the question the whole house-float problem turns on. Today a buy is
// paid out of USDso the Arena DEPOSITED with the pool, and that deposit only
// ever falls. If the pool will instead pull payment straight from the buyer's
// own wallet against an allowance — which is exactly how selling already works
// here — then the deposit is legacy and the drain is not a fault to be plumbed
// around, it is a step to delete.
//
// The test runs from the DEPLOYER, not the Arena, so it needs no contract
// change and no rewire. Preconditions checked, not assumed: the deployer must
// hold ZERO deposit at the pool, so a fill can only have been paid directly.
//
//   pnpm exec hardhat run scripts/probe-direct-billing.ts --network somnia
//
// Spends a few USDso and receives the asset back. Set DRY=1 to stop before the
// order is placed.
// ============================================================================
import hre from "hardhat";
import { formatUnits, parseUnits } from "viem";
import fs from "fs";
import path from "path";

const POOL_ABI = [
  { name: "getWithdrawableBalance", type: "function", stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "getPoolParams", type: "function", stateMutability: "view", inputs: [], outputs: [
      { name: "baseToken", type: "address" }, { name: "quoteToken", type: "address" },
      { name: "makerFeeBpsTimes1k", type: "uint256" }, { name: "takerFeeBpsTimes1k", type: "uint256" },
      { name: "tickSize", type: "uint256" }, { name: "minQuantity", type: "uint256" },
      { name: "lotSize", type: "uint256" } ] },
  { name: "getBookLevels", type: "function", stateMutability: "view",
    inputs: [{ type: "bool" }, { type: "uint64" }],
    outputs: [{ type: "tuple[]", components: [{ name: "price", type: "uint256" }, { name: "quantity", type: "uint256" }] }] },
  { name: "placeOrder", type: "function", stateMutability: "nonpayable", inputs: [
      { name: "isBid", type: "bool" }, { name: "userData", type: "uint64" },
      { name: "price", type: "uint256" }, { name: "quantity", type: "uint256" },
      { name: "expireTimestampNs", type: "uint64" }, { name: "orderType", type: "uint8" },
      { name: "selfMatchingOption", type: "uint8" }, { name: "builder", type: "address" },
      { name: "builderFeeBpsTimes1k", type: "uint96" } ],
    outputs: [{ type: "bool" }, { type: "uint128" }] },
] as const;

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"));
  const usdso = m.external.usdso as `0x${string}`;
  const pool = m.external.poolWeth as `0x${string}`;

  const pub = await hre.viem.getPublicClient();
  const [me] = await hre.viem.getWalletClients();
  const who = me.account.address;

  const params = await pub.readContract({ address: pool, abi: POOL_ABI, functionName: "getPoolParams" }) as readonly unknown[];
  const base = params[0] as `0x${string}`;
  const minQuantity = params[5] as bigint;
  const lotSize = params[6] as bigint;
  const baseDec = Number(await pub.readContract({ address: base, abi: ERC20_ABI, functionName: "decimals" }));

  const asks = await pub.readContract({ address: pool, abi: POOL_ABI, functionName: "getBookLevels", args: [false, BigInt(1)] }) as readonly { price: bigint }[];
  if (asks.length === 0) { console.log("No one is offering. Nothing to buy against. Try again later."); return; }
  const ask = asks[0].price;

  // Buy the smallest lot the venue will accept, at a price that crosses.
  let qty = minQuantity > lotSize ? minQuantity : lotSize;
  if (lotSize > BigInt(0) && qty % lotSize !== BigInt(0)) qty = ((qty / lotSize) + BigInt(1)) * lotSize;
  // Tick-align, exactly as the Arena does — an unaligned price is refused.
  const tickSize = params[4] as bigint;
  let price = ask + (ask / BigInt(100));      // 1% through, so it takes
  if (tickSize > BigInt(0)) price = ((price / tickSize) + BigInt(1)) * tickSize;
  const cost = (price * qty) / BigInt(10) ** BigInt(baseDec);

  // Fill-or-kill with a real expiry, matching _placeOrderForFighter: orderType 1
  // and an expiry one hour out in NANOseconds. A zero expiry is rejected outright,
  // which is what a first attempt at this probe hit.
  const block = await pub.getBlock();
  const expireNs = (block.timestamp + BigInt(3600)) * BigInt(1_000_000_000);
  const ORDER_TYPE = 1;

  const depositBefore = await pub.readContract({ address: pool, abi: POOL_ABI, functionName: "getWithdrawableBalance", args: [who, usdso] }) as bigint;
  const usdsoBefore = await pub.readContract({ address: usdso, abi: ERC20_ABI, functionName: "balanceOf", args: [who] }) as bigint;
  const baseBefore = await pub.readContract({ address: base, abi: ERC20_ABI, functionName: "balanceOf", args: [who] }) as bigint;

  console.log(`buyer                ${who}`);
  console.log(`its deposit at pool  ${formatUnits(depositBefore, 18)} USDso   <-- MUST be 0 for this to prove anything`);
  console.log(`its own USDso        ${formatUnits(usdsoBefore, 18)}`);
  console.log(`its own base         ${formatUnits(baseBefore, baseDec)}`);
  console.log(`buying               ${formatUnits(qty, baseDec)} at ${formatUnits(price, 18)} = ${formatUnits(cost, 18)} USDso\n`);

  if (depositBefore !== BigInt(0)) {
    console.log("ABORT: this wallet already has a deposit at the pool, so a fill would not tell us which pot paid.");
    return;
  }
  if (usdsoBefore < cost) { console.log("ABORT: not enough USDso in the wallet."); return; }
  if (process.env.DRY === "1") { console.log("DRY=1 — stopping before the order."); return; }

  // The allowance is the whole point: the ONLY route to this money is transferFrom.
  await me.writeContract({ address: usdso, abi: ERC20_ABI, functionName: "approve", args: [pool, BigInt(0)] });
  const aHash = await me.writeContract({ address: usdso, abi: ERC20_ABI, functionName: "approve", args: [pool, cost] });
  await pub.waitForTransactionReceipt({ hash: aHash });
  console.log(`allowance granted to the pool: ${formatUnits(await pub.readContract({ address: usdso, abi: ERC20_ABI, functionName: "allowance", args: [who, pool] }) as bigint, 18)} USDso`);

  let ok = true;
  try {
    const hash = await me.writeContract({
      address: pool, abi: POOL_ABI, functionName: "placeOrder",
      args: [true, BigInt(0), price, qty, expireNs, ORDER_TYPE, 0, "0x0000000000000000000000000000000000000000", BigInt(0)],
    });
    const rcpt = await pub.waitForTransactionReceipt({ hash });
    console.log(`order tx ${hash}  status=${rcpt.status}  gas=${rcpt.gasUsed}`);
    ok = rcpt.status === "success";
  } catch (e: any) {
    ok = false;
    console.log("order REVERTED, full error:\n" + (e.message || String(e)));
  }

  const usdsoAfter = await pub.readContract({ address: usdso, abi: ERC20_ABI, functionName: "balanceOf", args: [who] }) as bigint;
  const baseAfter = await pub.readContract({ address: base, abi: ERC20_ABI, functionName: "balanceOf", args: [who] }) as bigint;
  const depositAfter = await pub.readContract({ address: pool, abi: POOL_ABI, functionName: "getWithdrawableBalance", args: [who, usdso] }) as bigint;

  console.log(`\n  USDso   ${formatUnits(usdsoBefore, 18)} -> ${formatUnits(usdsoAfter, 18)}`);
  console.log(`  base    ${formatUnits(baseBefore, baseDec)} -> ${formatUnits(baseAfter, baseDec)}`);
  console.log(`  deposit ${formatUnits(depositBefore, 18)} -> ${formatUnits(depositAfter, 18)}`);

  const paidDirect = usdsoAfter < usdsoBefore;
  const gotAsset = baseAfter > baseBefore || depositAfter > BigInt(0);
  console.log(`\n  VERDICT: ${
    !ok ? "the order did not go through — the deposit may be mandatory (read the revert above)"
    : paidDirect ? "THE POOL BILLS DIRECTLY. Money left the wallet with no deposit involved — the deposit is optional."
    : gotAsset ? "filled without touching the wallet's USDso — unexpected; inspect the transfers on this tx"
    : "the order rested on the book instead of filling; it did not cross. Re-run when the book is tighter."
  }`);

  // Leave nothing standing.
  await me.writeContract({ address: usdso, abi: ERC20_ABI, functionName: "approve", args: [pool, BigInt(0)] });
  console.log("  allowance revoked.");
}

main().catch((e) => { console.error(e); process.exit(1); });
