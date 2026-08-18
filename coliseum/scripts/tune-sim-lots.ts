/**
 * tune-sim-lots.ts — retune the simulated pools' lot sizes, then re-cache them on
 * the Arena.
 *
 * A duel's trading capital is derived from `minQuantity x markPrice`, so the lot
 * size and the price are one dial, not two. Once the simulated market tracks real
 * dreamDEX marks (WETH ~1900, WBTC ~64500), the old lot sizes make a single buy
 * cost more than a whole duel's deposit. This sets each lot to a target USD cost
 * instead, keeping tier deposits affordable at realistic prices.
 *
 * The target used to be 30 cents a lot, which made practice the DEAREST market —
 * dearer than the real-coin-free events market at every tier. That is backwards:
 * practice risks nothing, so it must be the cheapest way in. A lot is now priced
 * to match a prediction question's smallest order, a third of a cent.
 *
 * Arena caches minQuantity/lotSize/tickSize in `poolMeta`, so setPoolParams alone
 * is not enough — setSimPools must be called afterwards to refresh the cache.
 * Both sim pools' setters are unpermissioned; setSimPools is owner-only.
 *
 * Run: pnpm exec hardhat run scripts/tune-sim-lots.ts --network somnia
 *      DRY=1 to print the plan without sending transactions.
 */
import "dotenv/config";
import hre from "hardhat";
import { formatEther, parseEther } from "viem";

/**
 * Target USD cost of one lot, per pool.
 *
 * Set BELOW a prediction question's smallest order, which measures about
 * two-thirds of a tenth of a cent per slot, so practice comes out strictly
 * cheapest at every tier. There is no floor to respect here: the books are mock,
 * the token is mock, and nothing rounds to zero because a lot still values at
 * ~4e14 wei against an 18-decimal base.
 *
 * Note the deposit covers BOTH fighters, so a tier's total is
 * 2 x turns x sum(lot cost over active slots) — a lot's cost lands in the
 * per-side figure four times over at a 2-slot tier, not once.
 */
const TARGET_LOT_USD: Record<string, number> = {
  WETH: 0.0004,
  WBTC: 0.0004,
  SOMI: 0.0004,
};

const MOCK_POOL_ABI = [
  { name: "getPoolParams", type: "function", stateMutability: "view", inputs: [],
    outputs: [
      { name: "baseToken", type: "address" }, { name: "quoteToken", type: "address" },
      { name: "makerFee", type: "uint256" }, { name: "takerFee", type: "uint256" },
      { name: "tickSize", type: "uint256" }, { name: "minQuantity", type: "uint256" },
      { name: "lotSize", type: "uint256" },
    ] },
  { name: "setPoolParams", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "baseToken", type: "address" }, { name: "quoteToken", type: "address" },
      { name: "tickSize", type: "uint256" }, { name: "minQuantity", type: "uint256" },
      { name: "lotSize", type: "uint256" },
    ], outputs: [] },
  { name: "getMarkPrice", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const ARENA_ABI = [
  { name: "setSimPools", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "weth", type: "address" }, { name: "wbtc", type: "address" },
      { name: "somi", type: "address" }, { name: "baseDecimals", type: "uint8[3]" },
    ], outputs: [] },
  { name: "minDepositForKind", type: "function", stateMutability: "view",
    inputs: [{ name: "turns", type: "uint16" }, { name: "marketKind", type: "uint8" }], outputs: [{ type: "uint256" }] },
] as const;

const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

async function main() {
  const dry = process.env.DRY === "1";
  const network = hre.network.name;
  const manifest = require(`../deployments/${network}.json`);
  const arena = (typeof manifest.contracts.Arena === "string"
    ? manifest.contracts.Arena
    : manifest.contracts.Arena.address) as `0x${string}`;

  const pools: Record<string, `0x${string}`> = {
    WETH: manifest.external.simPoolWeth,
    WBTC: manifest.external.simPoolWbtc,
    SOMI: manifest.external.simPoolSomi,
  };

  const pub = await hre.viem.getPublicClient();
  const [wallet] = await hre.viem.getWalletClients();
  log(`arena ${arena}  owner ${wallet.account.address}  dry=${dry}`);

  for (const [label, pool] of Object.entries(pools)) {
    const params = await pub.readContract({ address: pool, abi: MOCK_POOL_ABI, functionName: "getPoolParams" });
    const mark = (await pub.readContract({ address: pool, abi: MOCK_POOL_ABI, functionName: "getMarkPrice" })) as bigint;
    if (mark === BigInt(0)) { log(`${label}: mark price is 0 — skipping (start the injector first)`); continue; }

    // minQuantity such that minQuantity * mark / 1e18 == target USD.
    const target = parseEther(String(TARGET_LOT_USD[label]));
    const minQty = (target * BigInt(1e18)) / mark;
    const oldCost = (params[5] * mark) / BigInt(1e18);
    const newCost = (minQty * mark) / BigInt(1e18);

    log(`${label}: mark ${formatEther(mark)} | minQty ${params[5]} -> ${minQty} | lot cost $${formatEther(oldCost)} -> $${formatEther(newCost)}`);
    if (dry) continue;

    const h = await wallet.writeContract({
      address: pool, abi: MOCK_POOL_ABI, functionName: "setPoolParams",
      // Preserve base/quote/tick exactly as deployed; only the lot dial changes.
      args: [params[0], params[1], params[4], minQty, params[6]],
    });
    await pub.waitForTransactionReceipt({ hash: h });
    log(`  setPoolParams ok ${h}`);
  }

  if (!dry) {
    // Sim pools are registered with 18-decimal bases across the board.
    const h = await wallet.writeContract({
      address: arena, abi: ARENA_ABI, functionName: "setSimPools",
      args: [pools.WETH, pools.WBTC, pools.SOMI, [18, 18, 18]],
    });
    await pub.waitForTransactionReceipt({ hash: h });
    log(`setSimPools (poolMeta re-cached) ok ${h}`);
  }

  // Quote all three markets side by side. The point of the retune is the ORDER of
  // these columns: practice must come out under events, or the safest way to try
  // the game is also the dearest.
  const KINDS = [["spot", 0], ["practice", 1], ["events", 2]] as const;
  log("per side, USDso:");
  for (const turns of [3, 6, 9, 15] as const) {
    const cols: string[] = [];
    for (const [name, kind] of KINDS) {
      try {
        const total = (await pub.readContract({
          address: arena, abi: ARENA_ABI, functionName: "minDepositForKind", args: [turns, kind],
        })) as bigint;
        cols.push(`${name} ${Number(formatEther(total / BigInt(2))).toFixed(4)}`);
      } catch {
        cols.push(`${name} n/a`);        // that market's pools are not registered
      }
    }
    log(`  tier ${String(turns).padStart(2)}: ${cols.join("  |  ")}`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
