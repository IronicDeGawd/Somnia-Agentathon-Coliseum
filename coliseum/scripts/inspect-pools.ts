/**
 * Query each dreamDEX pool's getPoolParams (real 7-tuple) and the base/quote token decimals.
 * Tells us exactly what minQuantity / lotSize / tickSize each pool enforces so the Arena
 * can size FOK orders properly.
 */
import hre from "hardhat";
import { formatUnits } from "viem";
import fs from "fs";

const POOL_PARAMS_ABI = [{
  name: "getPoolParams",
  type: "function",
  stateMutability: "view",
  inputs: [],
  outputs: [
    { name: "baseToken", type: "address" },
    { name: "quoteToken", type: "address" },
    { name: "makerFeeBpsTimes1k", type: "uint256" },
    { name: "takerFeeBpsTimes1k", type: "uint256" },
    { name: "tickSize", type: "uint256" },
    { name: "minQuantity", type: "uint256" },
    { name: "lotSize", type: "uint256" },
  ],
}] as const;

const ERC20_META_ABI = [
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

const BOOK_ABI = [{
  name: "getBookLevels", type: "function", stateMutability: "view",
  inputs: [{ name: "isBid", type: "bool" }, { name: "numLevels", type: "uint64" }],
  outputs: [{
    name: "levels", type: "tuple[]", components: [
      { name: "price", type: "uint256" },
      { name: "quantity", type: "uint256" },
    ],
  }],
}] as const;

async function main() {
  const m = JSON.parse(fs.readFileSync("deployments/somnia.json", "utf-8"));
  const pools: { name: string; addr: `0x${string}` }[] = [
    { name: "WETH", addr: m.external.poolWeth },
    { name: "WBTC", addr: m.external.poolWbtc },
    { name: "SOMI", addr: m.external.poolSomi },
  ];

  const pub = await hre.viem.getPublicClient();

  for (const { name, addr } of pools) {
    console.log(`\n=== ${name}/USDso  ${addr} ===`);
    let params: any;
    try {
      params = await pub.readContract({ address: addr, abi: POOL_PARAMS_ABI, functionName: "getPoolParams" });
    } catch (e: any) {
      console.log("  getPoolParams reverted:", e.shortMessage || e.message);
      continue;
    }

    const [base, quote, makerFee, takerFee, tickSize, minQty, lotSize] = params;
    let baseDecimals = 18, baseSymbol = "?";
    let quoteDecimals = 18, quoteSymbol = "?";
    try {
      baseDecimals = (await pub.readContract({ address: base, abi: ERC20_META_ABI, functionName: "decimals" })) as number;
      baseSymbol = (await pub.readContract({ address: base, abi: ERC20_META_ABI, functionName: "symbol" })) as string;
    } catch {}
    try {
      quoteDecimals = (await pub.readContract({ address: quote, abi: ERC20_META_ABI, functionName: "decimals" })) as number;
      quoteSymbol = (await pub.readContract({ address: quote, abi: ERC20_META_ABI, functionName: "symbol" })) as string;
    } catch {}

    console.log(`  base:        ${base}  ${baseSymbol} (decimals=${baseDecimals})`);
    console.log(`  quote:       ${quote}  ${quoteSymbol} (decimals=${quoteDecimals})`);
    console.log(`  makerFee:    ${makerFee}  takerFee: ${takerFee} (bps × 1000)`);
    console.log(`  tickSize:    ${tickSize}  (= ${formatUnits(tickSize, quoteDecimals)} ${quoteSymbol})`);
    console.log(`  minQuantity: ${minQty}  (= ${formatUnits(minQty, baseDecimals)} ${baseSymbol})`);
    console.log(`  lotSize:     ${lotSize}  (= ${formatUnits(lotSize, baseDecimals)} ${baseSymbol})`);

    // Read best bid/ask
    try {
      const asks = (await pub.readContract({ address: addr, abi: BOOK_ABI, functionName: "getBookLevels", args: [false, 3n] })) as any[];
      const bids = (await pub.readContract({ address: addr, abi: BOOK_ABI, functionName: "getBookLevels", args: [true, 3n] })) as any[];
      console.log(`  top 3 asks:`);
      for (const lv of asks) console.log(`    price ${formatUnits(lv.price, quoteDecimals)}  qty ${formatUnits(lv.quantity, baseDecimals)}`);
      console.log(`  top 3 bids:`);
      for (const lv of bids) console.log(`    price ${formatUnits(lv.price, quoteDecimals)}  qty ${formatUnits(lv.quantity, baseDecimals)}`);
    } catch (e: any) {
      console.log("  book read error:", e.shortMessage || e.message);
    }

    // Compute notional minimum (minQty * mid price in USDso)
    try {
      const asks = (await pub.readContract({ address: addr, abi: BOOK_ABI, functionName: "getBookLevels", args: [false, 1n] })) as any[];
      if (asks.length > 0) {
        const askPrice = asks[0].price as bigint;
        const minNotionalRaw = (minQty as bigint) * askPrice / (10n ** BigInt(baseDecimals));
        console.log(`  min affordable order = ${formatUnits(minNotionalRaw, quoteDecimals)} ${quoteSymbol}`);
      }
    } catch {}
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
