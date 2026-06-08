// ============================================================================
// sim-market — simulated-pool price injector.
// ----------------------------------------------------------------------------
// Long-running script that drives the three MockSpotPool contracts that back
// simulated duels. Every ~5 seconds it advances each pool's mark price via a
// random walk and refreshes the bid/ask book levels so fighter orders always
// fill at a plausible price.
//
// Design:
//   • ±0.3% random walk per tick (independent per pool).
//   • 5% chance of a ±2% "regime" move, so prices drift in bursts rather than
//     purely diffusing.
//   • Bid always = floor(mark * 0.999), Ask = ceil(mark * 1.001) — 0.1% spread.
//   • Book quantity = 1e21 (1000 base tokens) — large enough that any fighter
//     minQuantity (1e15) is guaranteed to fill.
//   • Prices are lower-bounded at 1e12 (never go to zero).
//
// Run:
//   pnpm exec hardhat run scripts/sim-market.ts --network somnia
//
// Env:
//   PRIVATE_KEY        — deployer key (same as watcher/seeder; owner of pools)
//   SIM_TICK_MS        — ms between update rounds (default 5000)
// ============================================================================

import hre from "hardhat";
import fs from "fs";
import path from "path";
import { parseEther, formatEther } from "viem";

// ── ABI (only the three write functions + getMarkPrice we need) ──────────────

const MOCK_POOL_ABI = [
  {
    name: "setMarkPrice",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "price", type: "uint256" }],
    outputs: [],
  },
  {
    name: "setBookLevel",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "isBid", type: "bool" },
      { name: "price", type: "uint256" },
      { name: "quantity", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "getMarkPrice",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

// ── Helpers ──────────────────────────────────────────────────────────────────

const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (...args: unknown[]) => console.log(`[${ts()}]`, ...args);

const BOOK_QTY  = parseEther("1000");     // 1e21 — always fills minQuantity=1e15
const PRICE_MIN = 1_000_000_000_000n;     // 1e12 — floor to prevent zero

/** Advance price by one random-walk tick. */
function nextPrice(current: bigint): bigint {
  // 5% chance of a "regime" move (±2%), otherwise a normal tick (±0.3%).
  const isRegime = Math.random() < 0.05;
  const bpRange  = isRegime ? 200n : 3n;   // basis points (×10 for 0.1 bp precision)

  // Signed basis-point delta in [-bpRange, +bpRange].
  const bpAbs   = BigInt(Math.floor(Math.random() * Number(bpRange)));
  const up      = Math.random() < 0.5;
  const delta   = up ? (current * bpAbs) / 1000n : -(current * bpAbs) / 1000n;

  const next = current + delta;
  return next < PRICE_MIN ? PRICE_MIN : next;
}

/** Update one pool: setMarkPrice + setBookLevel(bid) + setBookLevel(ask). */
async function updatePool(opts: {
  pub:    Awaited<ReturnType<typeof hre.viem.getPublicClient>>;
  wallet: Awaited<ReturnType<typeof hre.viem.getWalletClients>>[number];
  addr:   `0x${string}`;
  label:  string;
  price:  bigint;
}): Promise<bigint> {
  const { pub, wallet, addr, label, price } = opts;

  const bid = (price * 999n) / 1000n;
  const ask = (price * 1001n + 999n) / 1000n;  // ceiling

  try {
    const h1 = await wallet.writeContract({
      address: addr,
      abi: MOCK_POOL_ABI,
      functionName: "setMarkPrice",
      args: [price],
    });
    await pub.waitForTransactionReceipt({ hash: h1 });

    const h2 = await wallet.writeContract({
      address: addr,
      abi: MOCK_POOL_ABI,
      functionName: "setBookLevel",
      args: [true, bid, BOOK_QTY],
    });
    await pub.waitForTransactionReceipt({ hash: h2 });

    const h3 = await wallet.writeContract({
      address: addr,
      abi: MOCK_POOL_ABI,
      functionName: "setBookLevel",
      args: [false, ask, BOOK_QTY],
    });
    await pub.waitForTransactionReceipt({ hash: h3 });

    log(`${label}: mark=${formatEther(price)} bid=${formatEther(bid)} ask=${formatEther(ask)}`);
  } catch (err) {
    log(`${label}: update error — ${err instanceof Error ? err.message : String(err)}`);
  }

  return price;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const network = hre.network.name;
  log(`sim-market starting — network: ${network}`);

  // Load manifest
  const manifestPath = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(manifestPath)) {
    log(`ERROR: No deployment manifest at deployments/${network}.json — run deploy first.`);
    process.exitCode = 1;
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  const poolAddrs = {
    WETH: manifest?.external?.simPoolWeth as `0x${string}` | undefined,
    WBTC: manifest?.external?.simPoolWbtc as `0x${string}` | undefined,
    SOMI: manifest?.external?.simPoolSomi as `0x${string}` | undefined,
  };

  if (!poolAddrs.WETH || !poolAddrs.WBTC || !poolAddrs.SOMI) {
    log("ERROR: Sim pool addresses missing from manifest (external.simPoolWeth/Wbtc/Somi).");
    log("       Deploy with SIM_MARKET=1 first.");
    process.exitCode = 1;
    return;
  }

  log(`  sim WETH: ${poolAddrs.WETH}`);
  log(`  sim WBTC: ${poolAddrs.WBTC}`);
  log(`  sim SOMI: ${poolAddrs.SOMI}`);

  const tickMs = parseInt(process.env.SIM_TICK_MS ?? "5000", 10);
  log(`  tick interval: ${tickMs}ms`);

  // Chain + wallet setup (same pattern as seeder-bot / watcher-bot)
  const pub = await hre.viem.getPublicClient();
  const walletClients = await hre.viem.getWalletClients();
  if (!walletClients.length) {
    log("ERROR: No wallet clients — set PRIVATE_KEY in .env");
    process.exitCode = 1;
    return;
  }
  const wallet = walletClients[0];
  const deployer = wallet.account.address;
  log(`  deployer: ${deployer}`);

  // Seed current prices from the chain so we continue where we left off
  const readMark = async (addr: `0x${string}`): Promise<bigint> =>
    (await pub.readContract({
      address: addr,
      abi: MOCK_POOL_ABI,
      functionName: "getMarkPrice",
    })) as bigint;

  let prices: Record<string, bigint> = {
    WETH: (await readMark(poolAddrs.WETH)) || parseEther("3000"),
    WBTC: (await readMark(poolAddrs.WBTC)) || parseEther("65000"),
    SOMI: (await readMark(poolAddrs.SOMI)) || parseEther("1"),
  };

  log(`  initial prices — WETH: ${formatEther(prices.WETH)} WBTC: ${formatEther(prices.WBTC)} SOMI: ${formatEther(prices.SOMI)}`);

  // Graceful shutdown
  let running = true;
  const onSig = () => { log("Shutting down…"); running = false; };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

  // Main loop
  while (running) {
    const roundStart = Date.now();

    for (const [label, addr] of [
      ["WETH", poolAddrs.WETH],
      ["WBTC", poolAddrs.WBTC],
      ["SOMI", poolAddrs.SOMI],
    ] as const) {
      if (!running) break;
      const newPrice = nextPrice(prices[label]);
      prices[label] = await updatePool({ pub, wallet, addr, label, price: newPrice });
    }

    // Sleep for the remainder of the tick interval
    const elapsed = Date.now() - roundStart;
    const sleep = Math.max(0, tickMs - elapsed);
    await new Promise<void>((res) => {
      const t = setTimeout(res, sleep);
      // Allow early exit on signal
      const check = setInterval(() => { if (!running) { clearTimeout(t); clearInterval(check); res(); } }, 200);
    });
  }

  log("sim-market stopped.");
}

main().catch((err) => {
  console.error("sim-market fatal:", err);
  process.exitCode = 1;
});
