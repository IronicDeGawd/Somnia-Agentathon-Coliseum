// ============================================================================
// check-arena-vaults — where the house's spot money actually is.
//
// There are TWO pots per market and they behave differently, which is why this
// reports both. Reporting only the first is how a leak ran unnoticed for months.
//
//   THE DEPOSIT sits inside the pool. `fundPools` puts it there, and a fighter's
//   BUY is paid out of it. It only ever goes down.
//
//   THE ARENA'S OWN BALANCE is where a filled buy DELIVERS the asset, and where a
//   sale's proceeds land. It only ever goes up — in base tokens.
//
// So every purchase moves value from the first pot to the second, and nothing
// moves it back. Measured on duel 38: the WETH deposit fell 200.09 → 173.34 USDso
// while the Arena's own WETH balance rose 0.002 → 0.011. `seedLiquidity` still
// counts the departed USDso as USDso, so `ownerWithdrawSeed` believes money exists
// that does not — the value is sitting in base tokens that nothing sweeps.
//
// Run this before and after a spot fight. THE CHECK THAT MATTERS: a deposit must
// not fall without the matching token balance rising.
//
//   pnpm exec hardhat run scripts/check-arena-vaults.ts --network somnia
//
// Reads only.
// ============================================================================
import hre from "hardhat";
import { formatUnits } from "viem";
import fs from "fs";
import path from "path";

const POOL_ABI = [
  {
    name: "getWithdrawableBalance", type: "function", stateMutability: "view",
    inputs: [{ name: "u", type: "address" }, { name: "t", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "getPoolParams", type: "function", stateMutability: "view", inputs: [],
    outputs: [
      { name: "baseToken", type: "address" }, { name: "quoteToken", type: "address" },
      { name: "makerFeeBpsTimes1k", type: "uint256" }, { name: "takerFeeBpsTimes1k", type: "uint256" },
      { name: "tickSize", type: "uint256" }, { name: "minQuantity", type: "uint256" },
      { name: "lotSize", type: "uint256" },
    ],
  },
] as const;

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

async function main() {
  const m = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"),
  );
  const arena = m.contracts.Arena.address as `0x${string}`;
  const usdso = m.external.usdso as `0x${string}`;
  const pools = [m.external.poolWeth, m.external.poolWbtc, m.external.poolSomi] as `0x${string}`[];
  const labels = ["WETH", "WBTC", "SOMI"];

  const pub = await hre.viem.getPublicClient();
  console.log(`Arena: ${arena}\n`);

  let depositTotal = 0n;

  for (let i = 0; i < 3; i++) {
    const pool = pools[i];
    const deposit = await pub.readContract({
      address: pool, abi: POOL_ABI, functionName: "getWithdrawableBalance", args: [arena, usdso],
    }) as bigint;
    depositTotal += deposit;

    // The asset this market trades, asked of the pool rather than assumed — one of
    // them is the chain's own coin and has no token contract at all.
    let base = "0x0000000000000000000000000000000000000000" as `0x${string}`;
    try {
      const p = await pub.readContract({ address: pool, abi: POOL_ABI, functionName: "getPoolParams" }) as readonly unknown[];
      base = p[0] as `0x${string}`;
    } catch { /* a pool that will not answer is reported as unknown below */ }

    const code = base === "0x0000000000000000000000000000000000000000"
      ? "0x"
      : await pub.getCode({ address: base });
    const isNative = !code || code === "0x";

    let heldStr = "n/a";
    let allowStr = "n/a";
    if (!isNative) {
      const [held, allow, dec] = await Promise.all([
        pub.readContract({ address: base, abi: ERC20_ABI, functionName: "balanceOf", args: [arena] }) as Promise<bigint>,
        pub.readContract({ address: base, abi: ERC20_ABI, functionName: "allowance", args: [arena, pool] }) as Promise<bigint>,
        pub.readContract({ address: base, abi: ERC20_ABI, functionName: "decimals" }) as Promise<number>,
      ]);
      heldStr = `${formatUnits(held, Number(dec))} ${labels[i]}`;
      allowStr = allow === 0n ? "0 (a sell is authorised per order)" : formatUnits(allow, Number(dec));
    }

    const quoteAllow = await pub.readContract({
      address: usdso, abi: ERC20_ABI, functionName: "allowance", args: [arena, pool],
    }) as bigint;

    console.log(`  ${labels[i]}`);
    console.log(`    deposit in the pool      ${formatUnits(deposit, 18)} USDso   (a buy is paid from here)`);
    console.log(`    arena's own holding      ${heldStr}${isNative ? "   (the chain's own coin — no token contract)" : "   (a fill is delivered here)"}`);
    console.log(`    allowance on the asset   ${allowStr}`);
    console.log(`    allowance on USDso       ${formatUnits(quoteAllow, 18)}   (nonzero = the pool may bill the arena directly)`);
  }

  const arenaUsdso = await pub.readContract({
    address: usdso, abi: ERC20_ABI, functionName: "balanceOf", args: [arena],
  }) as bigint;
  const arenaStt = await pub.getBalance({ address: arena });

  console.log(`\n  arena's own USDso            ${formatUnits(arenaUsdso, 18)}`);
  console.log(`  arena STT (also the fuel)    ${formatUnits(arenaStt, 18)}`);
  console.log(`  total USDso in the deposits  ${formatUnits(depositTotal, 18)}`);
  console.log(`\n  A deposit that has fallen without the matching holding rising is the leak.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
