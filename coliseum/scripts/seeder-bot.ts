// ============================================================================
// MM seeder bot — posts a resting BID into the SOMI/USDso pool so user
// STT→USDso sells have a real counterparty to cross (the structural gap on
// testnet, where dreamDEX has no protocol market maker).
// ----------------------------------------------------------------------------
// Funding model: FIXED USDso budget, then idle.
//   - On first run (manifest flag `seederBootstrapped` absent), the deployer
//     transfers SEEDER_USDSO_BUDGET USDso to the seeder wallet, which then
//     deposits it into the pool vault. The flag is then persisted so restarts
//     never re-fund — every filled bid is a bounded, one-way USDso spend.
//   - The seeder accumulates SOMI/STT as bids fill; that STT is NOT recycled
//     back to USDso. The watcher-bot keeps the seeder's STT topped up for gas.
//
// Each tick:
//   1. Read best ask; target bid = bestAsk − SEEDER_SPREAD_TICKS ticks (so the
//      bid is the new best bid but never crosses / takes).
//   2. If we already have a resting bid within SEEDER_REPRICE_TICKS of target,
//      leave it. Otherwise cancel it (refunds USDso to the vault).
//   3. If no resting bid and the vault holds ≥ one min-quantity of USDso,
//      place a fresh GTC bid sized to the available vault USDso.
//   4. If the vault USDso is depleted below a single min order, log + idle.
//
// Runs as the SEEDER wallet (SEEDER_PRIVATE_KEY), not the deployer. The only
// time it uses the deployer key is the one-time USDso bootstrap transfer.
//
// Run:
//   pnpm exec hardhat run scripts/seeder-bot.ts --network somnia
//
// Env (USDso amounts in whole tokens, STT in whole tokens):
//   SEEDER_PRIVATE_KEY    — required, the MM bot wallet that holds the bids
//   SEEDER_USDSO_BUDGET   — one-time USDso to commit to bids (default 3)
//   SEEDER_SPREAD_TICKS   — ticks below best ask to rest the bid (default 2)
//   SEEDER_REPRICE_TICKS  — reprice only if bid drifts > this many ticks (default 5)
//   SEEDER_INTERVAL_S     — loop interval seconds (default 45; 0 = one-shot)
//   DEPLOYER_USDSO_MIN    — never pull the deployer below this USDso (default 0.5)
// ============================================================================

import hre from "hardhat";
import fs from "fs";
import path from "path";
import {
  createWalletClient,
  http,
  parseEther,
  formatEther,
  getAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const POOL_ABI = [
  {
    name: "getPoolParams",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "baseToken_", type: "address" },
      { name: "quoteToken_", type: "address" },
      { name: "makerFeeBpsTimes1k_", type: "uint256" },
      { name: "takerFeeBpsTimes1k_", type: "uint256" },
      { name: "tickSize_", type: "uint256" },
      { name: "minQuantity_", type: "uint256" },
      { name: "lotSize_", type: "uint256" },
    ],
  },
  {
    name: "getBookLevels",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "isBid", type: "bool" },
      { name: "numLevels", type: "uint64" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "price", type: "uint256" },
          { name: "quantity", type: "uint256" },
        ],
      },
    ],
  },
  {
    name: "getOwnOpenOrders",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint128[]" }],
  },
  {
    name: "getOrder",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "orderId", type: "uint128" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "orderId", type: "uint128" },
          { name: "isBid", type: "bool" },
          { name: "owner", type: "address" },
          { name: "userData", type: "uint64" },
          { name: "price", type: "uint256" },
          { name: "fullQuantity", type: "uint256" },
          { name: "quantityRemaining", type: "uint256" },
          { name: "expireTimestampNs", type: "uint64" },
        ],
      },
    ],
  },
  {
    name: "getWithdrawableBalance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "deposit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "placeOrder",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "isBid", type: "bool" },
      { name: "userData", type: "uint64" },
      { name: "price", type: "uint256" },
      { name: "quantity", type: "uint256" },
      { name: "expireTimestampNs", type: "uint64" },
      { name: "orderType", type: "uint8" },
      { name: "selfMatchingOption", type: "uint8" },
      { name: "builder", type: "address" },
      { name: "builderFeeBpsTimes1k", type: "uint96" },
    ],
    outputs: [
      { name: "success", type: "bool" },
      { name: "orderId", type: "uint128" },
    ],
  },
  {
    name: "cancelOrder",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "orderId", type: "uint128" }],
    outputs: [],
  },
  {
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const MAX_UINT256 = (BigInt(1) << BigInt(256)) - BigInt(1);
const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;

const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (...args: unknown[]) => console.log(`[${ts()}]`, ...args);
const errMsg = (e: unknown) =>
  e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);

// Align a raw quantity down to the pool's lot size.
const floorToLot = (qty: bigint, lot: bigint) => (lot > BigInt(0) ? (qty / lot) * lot : qty);

async function main() {
  const network = hre.network.name;
  log(`Seeder bot starting — network: ${network}`);

  const seederPk = process.env.SEEDER_PRIVATE_KEY;
  if (!seederPk) throw new Error("SEEDER_PRIVATE_KEY is required (the MM bot wallet).");

  const manifestPath = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No deployment manifest at deployments/${network}.json.`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const pool = manifest?.external?.poolSomi as `0x${string}` | undefined;
  if (!pool) throw new Error("SOMI/USDso pool (external.poolSomi) missing from manifest.");

  const budget = parseEther(process.env.SEEDER_USDSO_BUDGET ?? "3");
  const spreadTicks = BigInt(process.env.SEEDER_SPREAD_TICKS ?? "2");
  const repriceTicks = BigInt(process.env.SEEDER_REPRICE_TICKS ?? "5");
  const intervalS = parseInt(process.env.SEEDER_INTERVAL_S ?? "45", 10);
  const deployerUsdsoMin = parseEther(process.env.DEPLOYER_USDSO_MIN ?? "0.5");

  const pub = await hre.viem.getPublicClient();
  const rpcUrl = (hre.network.config as { url?: string }).url ?? "https://api.infra.testnet.somnia.network";
  const seederAccount = privateKeyToAccount(seederPk as `0x${string}`);
  const seeder = createWalletClient({ account: seederAccount, chain: pub.chain, transport: http(rpcUrl) });
  const seederAddr = getAddress(seederAccount.address) as `0x${string}`;

  // Pool params — static, read once.
  const params = (await pub.readContract({
    address: pool,
    abi: POOL_ABI,
    functionName: "getPoolParams",
  })) as readonly [`0x${string}`, `0x${string}`, bigint, bigint, bigint, bigint, bigint];
  const [, usdso, , , tickSize, minQuantity, lotSize] = params;

  log(`config:`);
  log(`  SOMI/USDso pool   ${pool}`);
  log(`  USDso (quote)     ${usdso}`);
  log(`  seeder wallet     ${seederAddr}`);
  log(`  budget            ${formatEther(budget)} USDso (one-time)`);
  log(`  tick / minQty     ${formatEther(tickSize)} / ${formatEther(minQuantity)}`);
  log(`  spread / reprice  ${spreadTicks} / ${repriceTicks} ticks`);
  log(`  interval          ${intervalS === 0 ? "one-shot" : `${intervalS}s`}`);

  await bootstrapFunding({
    pub, seeder, seederAddr, manifest, manifestPath, pool, usdso, budget, deployerUsdsoMin,
  });

  const ctx = { pub, seeder, seederAddr, pool, usdso, tickSize, minQuantity, lotSize, spreadTicks, repriceTicks };

  let running = true;
  const onSig = () => {
    log("signal received — cancelling open bids then exiting");
    running = false;
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

  if (intervalS === 0) {
    await tick(ctx);
    return;
  }

  while (running) {
    try {
      await tick(ctx);
    } catch (e) {
      log(`tick error: ${errMsg(e)}`);
    }
    if (!running) break;
    await new Promise<void>((r) => setTimeout(r, intervalS * 1000));
  }

  // Graceful shutdown: cancel resting bids (refunds USDso to the vault) and
  // then withdraw the vault USDso back to the seeder wallet, so nothing is
  // stranded in the book or locked in the pool.
  await cancelOwnBids(ctx).catch((e) => log(`shutdown cancel failed: ${errMsg(e)}`));
  await withdrawVaultUsdso(ctx).catch((e) => log(`shutdown withdraw failed: ${errMsg(e)}`));
  log("seeder stopped");
}

// One-time: deployer funds the seeder with USDso, seeder deposits it into the
// pool vault. Guarded by manifest.seederBootstrapped so it never re-funds —
// that is what makes the loss bounded.
async function bootstrapFunding(o: {
  pub: Awaited<ReturnType<typeof hre.viem.getPublicClient>>;
  seeder: ReturnType<typeof createWalletClient>;
  seederAddr: `0x${string}`;
  manifest: Record<string, unknown>;
  manifestPath: string;
  pool: `0x${string}`;
  usdso: `0x${string}`;
  budget: bigint;
  deployerUsdsoMin: bigint;
}) {
  const { pub, seeder, seederAddr, manifest, manifestPath, pool, usdso, budget, deployerUsdsoMin } = o;

  const vaultBal = (await pub.readContract({
    address: pool, abi: POOL_ABI, functionName: "getWithdrawableBalance", args: [seederAddr, usdso],
  })) as bigint;

  if (manifest.seederBootstrapped) {
    log(`bootstrap: already done (manifest flag set). Vault USDso=${formatEther(vaultBal)}. Skipping fund.`);
    await depositWalletUsdso(o);
    return;
  }

  // Deployer transfers the budget to the seeder wallet (only the shortfall).
  const [deployerWallet] = await hre.viem.getWalletClients();
  const deployer = deployerWallet.account.address;
  const walletBal = (await pub.readContract({
    address: usdso, abi: ERC20_ABI, functionName: "balanceOf", args: [seederAddr],
  })) as bigint;
  const have = vaultBal + walletBal;
  const shortfall = budget > have ? budget - have : BigInt(0);

  if (shortfall > BigInt(0)) {
    const deployerBal = (await pub.readContract({
      address: usdso, abi: ERC20_ABI, functionName: "balanceOf", args: [deployer],
    })) as bigint;
    if (deployerBal < shortfall + deployerUsdsoMin) {
      log(
        `bootstrap: deployer holds ${formatEther(deployerBal)} USDso, cannot send ${formatEther(shortfall)} ` +
        `without dropping below floor ${formatEther(deployerUsdsoMin)}. Funding with what is available.`,
      );
    }
    const sendable = deployerBal > deployerUsdsoMin ? deployerBal - deployerUsdsoMin : BigInt(0);
    const toSend = shortfall < sendable ? shortfall : sendable;
    if (toSend > BigInt(0)) {
      log(`bootstrap: deployer ${deployer} → ${formatEther(toSend)} USDso → seeder ${seederAddr}`);
      const hash = await deployerWallet.writeContract({
        address: usdso, abi: ERC20_ABI, functionName: "transfer", args: [seederAddr, toSend],
      });
      const r = await pub.waitForTransactionReceipt({ hash });
      log(`  fund tx=${hash} status=${r.status}`);
    } else {
      log(`bootstrap: nothing sendable from deployer; proceeding with seeder's existing USDso.`);
    }
  } else {
    log(`bootstrap: seeder already holds ${formatEther(have)} USDso (≥ budget). No transfer.`);
  }

  await depositWalletUsdso(o);

  manifest.seederBootstrapped = true;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  log(`bootstrap: manifest.seederBootstrapped = true (loss now bounded; will not auto-refund).`);
}

// Approve (if needed) and deposit the seeder's wallet USDso into the pool vault.
async function depositWalletUsdso(o: {
  pub: Awaited<ReturnType<typeof hre.viem.getPublicClient>>;
  seeder: ReturnType<typeof createWalletClient>;
  seederAddr: `0x${string}`;
  pool: `0x${string}`;
  usdso: `0x${string}`;
}) {
  const { pub, seeder, seederAddr, pool, usdso } = o;
  const walletBal = (await pub.readContract({
    address: usdso, abi: ERC20_ABI, functionName: "balanceOf", args: [seederAddr],
  })) as bigint;
  if (walletBal === BigInt(0)) return;

  const allowance = (await pub.readContract({
    address: usdso, abi: ERC20_ABI, functionName: "allowance", args: [seederAddr, pool],
  })) as bigint;
  if (allowance < walletBal) {
    log(`deposit: approving USDso → pool`);
    const a = await seeder.writeContract({
      address: usdso, abi: ERC20_ABI, functionName: "approve", args: [pool, MAX_UINT256],
      account: seeder.account!, chain: pub.chain,
    });
    await pub.waitForTransactionReceipt({ hash: a });
  }
  log(`deposit: ${formatEther(walletBal)} USDso → vault`);
  const d = await seeder.writeContract({
    address: pool, abi: POOL_ABI, functionName: "deposit", args: [usdso, walletBal],
    account: seeder.account!, chain: pub.chain,
  });
  const r = await pub.waitForTransactionReceipt({ hash: d });
  log(`  deposit tx=${d} status=${r.status}`);
}

type TickCtx = {
  pub: Awaited<ReturnType<typeof hre.viem.getPublicClient>>;
  seeder: ReturnType<typeof createWalletClient>;
  seederAddr: `0x${string}`;
  pool: `0x${string}`;
  usdso: `0x${string}`;
  tickSize: bigint;
  minQuantity: bigint;
  lotSize: bigint;
  spreadTicks: bigint;
  repriceTicks: bigint;
};

async function ourRestingBid(ctx: TickCtx) {
  // getOwnOpenOrders resolves "own" from msg.sender — eth_call defaults the
  // caller to 0x0, so we MUST set account to the seeder or it reads empty.
  const ids = (await ctx.pub.readContract({
    address: ctx.pool, abi: POOL_ABI, functionName: "getOwnOpenOrders", account: ctx.seederAddr,
  })) as bigint[];
  for (const id of ids) {
    const order = (await ctx.pub.readContract({
      address: ctx.pool, abi: POOL_ABI, functionName: "getOrder", args: [id],
    })) as { orderId: bigint; isBid: boolean; price: bigint; quantityRemaining: bigint };
    if (order.isBid) return order;
  }
  return null;
}

async function cancelOwnBids(ctx: TickCtx) {
  const ids = (await ctx.pub.readContract({
    address: ctx.pool, abi: POOL_ABI, functionName: "getOwnOpenOrders", account: ctx.seederAddr,
  })) as bigint[];
  for (const id of ids) {
    const order = (await ctx.pub.readContract({
      address: ctx.pool, abi: POOL_ABI, functionName: "getOrder", args: [id],
    })) as { isBid: boolean };
    if (!order.isBid) continue;
    log(`  cancel bid orderId=${id}`);
    const hash = await ctx.seeder.writeContract({
      address: ctx.pool, abi: POOL_ABI, functionName: "cancelOrder", args: [id],
      account: ctx.seeder.account!, chain: ctx.pub.chain,
    });
    await ctx.pub.waitForTransactionReceipt({ hash });
  }
}

// Pull the seeder's vault USDso back to its wallet (used on shutdown so the
// budget isn't left locked in the pool after a clean stop).
async function withdrawVaultUsdso(ctx: TickCtx) {
  const bal = (await ctx.pub.readContract({
    address: ctx.pool, abi: POOL_ABI, functionName: "getWithdrawableBalance", args: [ctx.seederAddr, ctx.usdso],
  })) as bigint;
  if (bal === BigInt(0)) return;
  log(`  withdraw ${formatEther(bal)} USDso from vault → seeder wallet`);
  const hash = await ctx.seeder.writeContract({
    address: ctx.pool, abi: POOL_ABI, functionName: "withdraw", args: [ctx.usdso, bal],
    account: ctx.seeder.account!, chain: ctx.pub.chain,
  });
  await ctx.pub.waitForTransactionReceipt({ hash });
}

async function tick(ctx: TickCtx) {
  const { pub, seeder, seederAddr, pool, usdso, tickSize, minQuantity, lotSize, spreadTicks, repriceTicks } = ctx;

  // Best ask drives the target bid (rest just below so we never take).
  const asks = (await pub.readContract({
    address: pool, abi: POOL_ABI, functionName: "getBookLevels", args: [false, BigInt(1)],
  })) as { price: bigint; quantity: bigint }[];
  if (asks.length === 0 || asks[0].price === BigInt(0)) {
    log(`tick: no ask on the book — cannot anchor a bid this round. Skipping.`);
    return;
  }
  const bestAsk = asks[0].price;
  // Guard before the subtraction — bigint underflow would throw, not go negative.
  if (bestAsk <= spreadTicks * tickSize) {
    log(`tick: best ask ${formatEther(bestAsk)} ≤ spread; cannot anchor a bid. Skipping.`);
    return;
  }
  let targetPrice = bestAsk - spreadTicks * tickSize;
  targetPrice = (targetPrice / tickSize) * tickSize; // align to tick grid
  if (targetPrice <= BigInt(0)) {
    log(`tick: computed target bid ≤ 0 (bestAsk=${formatEther(bestAsk)}). Skipping.`);
    return;
  }

  const existing = await ourRestingBid(ctx);
  if (existing) {
    const drift = existing.price > targetPrice ? existing.price - targetPrice : targetPrice - existing.price;
    if (drift <= repriceTicks * tickSize) {
      log(
        `tick: resting bid OK — price=${formatEther(existing.price)} target=${formatEther(targetPrice)} ` +
        `qtyRem=${formatEther(existing.quantityRemaining)}. Holding.`,
      );
      return;
    }
    log(`tick: bid drifted (${formatEther(existing.price)} vs target ${formatEther(targetPrice)}) → reprice`);
    const c = await seeder.writeContract({
      address: pool, abi: POOL_ABI, functionName: "cancelOrder", args: [existing.orderId],
      account: seeder.account!, chain: pub.chain,
    });
    await pub.waitForTransactionReceipt({ hash: c });
  }

  // Size a fresh bid to the available vault USDso (99% to absorb rounding).
  const vault = (await pub.readContract({
    address: pool, abi: POOL_ABI, functionName: "getWithdrawableBalance", args: [seederAddr, usdso],
  })) as bigint;
  const usable = (vault * BigInt(99)) / BigInt(100);
  let qty = floorToLot((usable * parseEther("1")) / targetPrice, lotSize);

  if (qty < minQuantity) {
    log(
      `tick: vault USDso depleted (${formatEther(vault)} → qty ${formatEther(qty)} < minQty ` +
      `${formatEther(minQuantity)}). Idling — fixed budget spent.`,
    );
    return;
  }

  const notional = (targetPrice * qty) / parseEther("1");
  const expireNs = BigInt(Math.floor(Date.now() / 1000) + 3600) * BigInt(1_000_000_000);
  log(
    `tick: placing bid price=${formatEther(targetPrice)} qty=${formatEther(qty)} SOMI ` +
    `(~${formatEther(notional)} USDso of ${formatEther(vault)} vault)`,
  );

  const args = [true, BigInt(0), targetPrice, qty, expireNs, 0, 0, ZERO_ADDR, BigInt(0)] as const;
  try {
    const sim = await pub.simulateContract({
      account: seeder.account, address: pool, abi: POOL_ABI, functionName: "placeOrder", args,
    });
    const [ok, simId] = sim.result as [boolean, bigint];
    if (!ok) {
      log(`  simulate says success=false (orderId=${simId}) — not broadcasting.`);
      return;
    }
  } catch (e) {
    log(`  simulate reverted: ${errMsg(e)} — not broadcasting.`);
    return;
  }

  const hash = await seeder.writeContract({
    address: pool, abi: POOL_ABI, functionName: "placeOrder", args,
    account: seeder.account!, chain: pub.chain,
  });
  const r = await pub.waitForTransactionReceipt({ hash });
  const placed = r.logs.length > 0; // empty logs = silent reject
  log(`  placeOrder tx=${hash} status=${r.status} logs=${r.logs.length} ${placed ? "(resting)" : "(⚠ silent reject)"}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
