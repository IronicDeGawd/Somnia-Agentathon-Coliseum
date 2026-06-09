// ============================================================================
// REDEPLOY REQUIRED BEFORE PRODUCTION
// ----------------------------------------------------------------------------
// The currently-live testnet Arena (deployments/somnia.json) was deployed
// BEFORE the vault recovery patch. Its seeded pool USDso is permanently
// stuck — Arena has no withdrawFromPool / sweepToken on that version.
//
// This script now includes those owner functions. The next time you deploy
// to testnet you get the recovery path. Until then, treat any USDso you
// fundPools into the old Arena as burned.
// ============================================================================

import hre from "hardhat";
import { parseEther, formatEther } from "viem";
import fs from "fs";
import path from "path";

const IS_LOCAL =
  hre.network.name === "localhost" || hre.network.name === "hardhat";

async function deployLocal(deployer: `0x${string}`) {
  console.log("Deploying mock contracts for local dry-run...");

  const usdso = await hre.viem.deployContract("MockERC20", ["USDso", "USDso"]);
  const poolWeth = await hre.viem.deployContract("MockSpotPool");
  const poolWbtc = await hre.viem.deployContract("MockSpotPool");
  const poolSomi = await hre.viem.deployContract("MockSpotPool");

  // MockPlatform stands in for the Somnia Agents platform
  const platform = await hre.viem.deployContract("MockPlatform");

  console.log("  MockERC20 (USDso):", usdso.address);
  console.log("  MockSpotPool (WETH):", poolWeth.address);
  console.log("  MockSpotPool (WBTC):", poolWbtc.address);
  console.log("  MockSpotPool (SOMI):", poolSomi.address);
  console.log("  MockPlatform:", platform.address);

  return {
    usdso: usdso.address as `0x${string}`,
    poolWeth: poolWeth.address as `0x${string}`,
    poolWbtc: poolWbtc.address as `0x${string}`,
    poolSomi: poolSomi.address as `0x${string}`,
    platform: platform.address as `0x${string}`,
  };
}

async function main() {
  const network = hre.network.name;
  console.log(`\nColiseum deploy — network: ${network}`);

  const walletClients = await hre.viem.getWalletClients();
  if (!walletClients.length) throw new Error("No wallet clients — set PRIVATE_KEY in .env");
  const deployer = walletClients[0].account.address;
  const publicClient = await hre.viem.getPublicClient();

  const balance = await publicClient.getBalance({ address: deployer });
  console.log(`Deployer: ${deployer}`);
  console.log(`Balance:  ${formatEther(balance)} STT`);

  if (!IS_LOCAL && balance < parseEther("70")) {
    throw new Error(`Insufficient balance: need ≥70 STT, have ${formatEther(balance)}`);
  }

  let addresses: {
    usdso: `0x${string}`;
    poolWeth: `0x${string}`;
    poolWbtc: `0x${string}`;
    poolSomi: `0x${string}`;
    platform: `0x${string}`;
  };

  if (IS_LOCAL) {
    addresses = await deployLocal(deployer);
  } else {
    const usdso = process.env.USDSO_ADDRESS;
    const poolWeth = process.env.POOL_WETH_ADDRESS;
    const poolWbtc = process.env.POOL_WBTC_ADDRESS;
    const poolSomi = process.env.POOL_SOMI_ADDRESS;
    const platform = process.env.PLATFORM_ADDRESS;

    if (!usdso || !poolWeth || !poolWbtc || !poolSomi || !platform) {
      throw new Error(
        "Missing env vars: USDSO_ADDRESS, POOL_WETH_ADDRESS, POOL_WBTC_ADDRESS, POOL_SOMI_ADDRESS, PLATFORM_ADDRESS"
      );
    }

    const addrRe = /^0x[0-9a-fA-F]{40}$/;
    const envAddrs: [string, string][] = [
      ["USDSO_ADDRESS", usdso],
      ["POOL_WETH_ADDRESS", poolWeth],
      ["POOL_WBTC_ADDRESS", poolWbtc],
      ["POOL_SOMI_ADDRESS", poolSomi],
      ["PLATFORM_ADDRESS", platform],
    ];
    for (const [name, val] of envAddrs) {
      if (!addrRe.test(val)) {
        throw new Error(`invalid address for ${name}: ${val}`);
      }
    }

    addresses = {
      usdso: usdso as `0x${string}`,
      poolWeth: poolWeth as `0x${string}`,
      poolWbtc: poolWbtc as `0x${string}`,
      poolSomi: poolSomi as `0x${string}`,
      platform: platform as `0x${string}`,
    };
  }

  const turnIntervalBlocks = IS_LOCAL ? 1n : 600n;
  const reactivityFund = parseEther("33");

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${network}.json`);

  // Merge over any existing manifest so contracts deployed by SEPARATE scripts
  // (SwapFallback, DuelHistory) are preserved across a core redeploy — the
  // watcher reads SwapFallback from here and crashes if it goes missing.
  function writeManifest(partial: Record<string, any>) {
    let existing: Record<string, any> = {};
    try { existing = JSON.parse(fs.readFileSync(outFile, "utf8")); } catch { /* fresh */ }
    const merged = {
      ...existing,
      ...partial,
      contracts: { ...(existing.contracts ?? {}), ...((partial as any).contracts ?? {}) },
    };
    const json = JSON.stringify(merged, null, 2);
    try {
      fs.writeFileSync(outFile, json);
    } catch (err) {
      console.error("writeFileSync failed — manifest contents follow:");
      console.log(json);
    }
  }

  // 1. FighterRegistry — reused on testnet (immutable persona data; a redeploy
  //    would churn the frontend address and drop any live-tuned prompts). Fresh
  //    only on local dry-runs.
  let registryAddress: `0x${string}`;
  if (IS_LOCAL) {
    console.log("\nDeploying FighterRegistry...");
    const reg = await hre.viem.deployContract("FighterRegistry");
    registryAddress = reg.address;
    console.log(`  FighterRegistry: ${registryAddress}`);
  } else {
    let priorManifest: any = {};
    try { priorManifest = JSON.parse(fs.readFileSync(outFile, "utf8")); } catch { /* none */ }
    if (!priorManifest?.contracts?.FighterRegistry?.address) {
      throw new Error("No existing FighterRegistry in manifest to reuse — run on local or deploy one first.");
    }
    registryAddress = priorManifest.contracts.FighterRegistry.address as `0x${string}`;
    console.log(`\nReusing FighterRegistry: ${registryAddress}`);
  }
  writeManifest({ network, deployer, contracts: { FighterRegistry: { address: registryAddress } }, external: addresses });

  // 2. Arena
  // Per-pool base-token decimals (verified via scripts/inspect-pools.ts):
  // WETH = 18, WBTC = 8, SOMI = 18. Local mocks all use 18.
  const baseDecimals: [number, number, number] = IS_LOCAL ? [18, 18, 18] : [18, 8, 18];
  console.log(`Deploying Arena... (baseDecimals=${JSON.stringify(baseDecimals)})`);
  const arena = await hre.viem.deployContract(
    "Arena",
    [
      registryAddress,
      addresses.usdso,
      addresses.poolWeth,
      addresses.poolWbtc,
      addresses.poolSomi,
      addresses.platform,
      turnIntervalBlocks,
      baseDecimals,
    ],
    { value: reactivityFund }
  );
  console.log(`  Arena:           ${arena.address}`);
  const subId = await arena.read.subscriptionId() as bigint;
  console.log(`  subscriptionId:  ${subId} (0 = precompile skipped on local)`);
  writeManifest({
    network,
    deployer,
    contracts: {
      FighterRegistry: { address: registryAddress },
      Arena: { address: arena.address, subscriptionId: subId.toString(), turnIntervalBlocks: turnIntervalBlocks.toString() },
    },
    external: addresses,
  });

  // 2b. DuelHistory — append-only settled-duel ledger. Its `arena` is immutable,
  //     so each new Arena needs a fresh DuelHistory wired via setDuelHistory;
  //     without it, resolved duels never reach the frontend's settled ledger.
  console.log("Deploying DuelHistory...");
  const history = await hre.viem.deployContract("DuelHistory", [arena.address]);
  console.log(`  DuelHistory:     ${history.address}`);
  const setHistTx = await arena.write.setDuelHistory([history.address]);
  await publicClient.waitForTransactionReceipt({ hash: setHistTx });
  const wiredHist = (await arena.read.duelHistory()) as `0x${string}`;
  if (wiredHist.toLowerCase() !== history.address.toLowerCase()) {
    throw new Error(`setDuelHistory failed: arena.duelHistory=${wiredHist}, expected ${history.address}`);
  }
  console.log(`  setDuelHistory wired OK`);

  // 3. Matchmaker — PvP matchmaking layer; pairs human players into Arena duels.
  //    Deployed before the Bookmaker so the Bookmaker can hold its address and
  //    block a duel's two players from betting on their own fight.
  console.log("Deploying Matchmaker...");
  const matchmaker = await hre.viem.deployContract(
    "Matchmaker",
    [arena.address, addresses.usdso, registryAddress]
  );
  console.log(`  Matchmaker:      ${matchmaker.address}`);

  // 4. Bookmaker — gets the same registry + platform as the Arena so its
  //    LLM Bookmaker agent can read fighter prompts and fire inferNumber requests.
  //    Also gets the Matchmaker so placeBet can reject the duel's own players.
  console.log("Deploying Bookmaker...");
  const bookmaker = await hre.viem.deployContract(
    "Bookmaker",
    [arena.address, addresses.usdso, registryAddress, matchmaker.address, addresses.platform, turnIntervalBlocks],
    { value: reactivityFund }
  );
  console.log(`  Bookmaker:       ${bookmaker.address}`);

  // 5. Fund pools (testnet only, deployer must hold USDso and approve arena first)
  if (!IS_LOCAL) {
    const perPool = parseEther(process.env.USDSO_PER_POOL ?? "50");
    const total = perPool * 3n;
    // Per scripts/inspect-pools.ts (2026-05-26): min affordable orders are
    // WETH ~$2.10, WBTC ~$7.69, SOMI ~$0.17. Each fighter gets perPool / 2 of vault
    // capacity, so to enable WBTC trades the per-pool seed must be >= ~16 USDso.
    const WBTC_MIN_PER_POOL = parseEther("16");
    if (perPool < WBTC_MIN_PER_POOL) {
      console.log(`\nWARNING: USDSO_PER_POOL=${formatEther(perPool)} is below ~16 USDso —`);
      console.log(`  fighters will skip WBTC trades ("below minQuantity"). WETH + SOMI will still work.`);
      console.log(`  Set USDSO_PER_POOL=20 (or higher) for full 3-market trading.\n`);
    }
    console.log(`Funding pools with ${formatEther(perPool)} USDso each (${formatEther(total)} total)...`);
    const usdsoContract = await hre.viem.getContractAt("MockERC20", addresses.usdso);
    const approveTx = await usdsoContract.write.approve([arena.address, total]);
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    const fundTx = await arena.write.fundPools([perPool]);
    await publicClient.waitForTransactionReceipt({ hash: fundTx });
    console.log("  Pools funded.");
  }

  // 6. Optional simulated-market deployment (SIM_MARKET=1)
  let simAddresses: {
    simPoolWeth: `0x${string}`;
    simPoolWbtc: `0x${string}`;
    simPoolSomi: `0x${string}`;
  } | undefined;

  if (process.env.SIM_MARKET === "1") {
    console.log("\nSIM_MARKET=1 — deploying simulated pool set...");

    const simWeth = await hre.viem.deployContract("MockSpotPool");
    const simWbtc = await hre.viem.deployContract("MockSpotPool");
    const simSomi = await hre.viem.deployContract("MockSpotPool");
    console.log(`  sim WETH pool: ${simWeth.address}`);
    console.log(`  sim WBTC pool: ${simWbtc.address}`);
    console.log(`  sim SOMI pool: ${simSomi.address}`);

    // Initial mark prices (18-decimal USDso-quoted). The injector will update
    // these continuously; these are just sane starting points.
    const SIM_PRICE_WETH = parseEther("3000");   // ~$3000
    const SIM_PRICE_WBTC = parseEther("6000");   // lowered from 65000 so a min
                                                 // order is affordable at the
                                                 // demo seed (see MIN_QTY note)
    const SIM_PRICE_SOMI = parseEther("1");      // ~$1

    // Book quantity — large enough that fighter orders of minQuantity always fill.
    const BOOK_QTY = parseEther("1000"); // 1e21

    // Each fighter BUY trades exactly minQuantity (Arena does not scale order
    // size by capacity), costing minQuantity * price / 1e18 USDso, and that cost
    // is withdrawn from the pool seed — so seed / minCost = how many buys a pool
    // supports before drying up. minQuantity = 1e14 (0.0001 base, 18-dec) keeps
    // each buy cheap so the demo seed lasts many turns:
    //   WETH: 0.0001 * 3000 = 0.30 USDso   WBTC: 0.0001 * 6000 = 0.60 USDso
    //   SOMI: 0.0001 * 1    = 0.0001 USDso
    // At an 8-USDso sim seed that's ~13-26 buys per pool — lively across all three.
    // Use address(0) as nominal base — MockSpotPool never pulls base tokens; Arena
    // only transfers USDso (the quote). So base identity doesn't matter for fills.
    const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;
    const TICK_SIZE   = 1_000_000_000_000_000n;  // 1e15
    const MIN_QTY    = 100_000_000_000_000n;     // 1e14
    const LOT_SIZE   = 1n;

    async function initSimPool(
      pool: typeof simWeth,
      price: bigint,
      label: string,
    ) {
      // setPoolParams(base, quote=USDso, tickSize, minQuantity, lotSize)
      let tx = await pool.write.setPoolParams([
        ZERO_ADDR,
        addresses.usdso,
        TICK_SIZE,
        MIN_QTY,
        LOT_SIZE,
      ]);
      await publicClient.waitForTransactionReceipt({ hash: tx });

      tx = await pool.write.setMarkPrice([price]);
      await publicClient.waitForTransactionReceipt({ hash: tx });

      // Bid: price * 0.999, Ask: price * 1.001 (0.1% spread each side)
      const bid = (price * 999n) / 1000n;
      const ask = (price * 1001n) / 1000n;
      tx = await pool.write.setBookLevel([true, bid, BOOK_QTY]);
      await publicClient.waitForTransactionReceipt({ hash: tx });
      tx = await pool.write.setBookLevel([false, ask, BOOK_QTY]);
      await publicClient.waitForTransactionReceipt({ hash: tx });

      console.log(`  ${label}: mark=${formatEther(price)} bid=${formatEther(bid)} ask=${formatEther(ask)}`);
    }

    await initSimPool(simWeth, SIM_PRICE_WETH, "WETH");
    await initSimPool(simWbtc, SIM_PRICE_WBTC, "WBTC");
    await initSimPool(simSomi, SIM_PRICE_SOMI, "SOMI");

    // Register the sim pool set with the Arena
    const simDecimalsTx = await arena.write.setSimPools([
      simWeth.address,
      simWbtc.address,
      simSomi.address,
      [18, 18, 18],
    ]);
    await publicClient.waitForTransactionReceipt({ hash: simDecimalsTx });
    console.log("  setSimPools done.");

    // Fund the sim pools with USDso
    const simPerPool = parseEther(process.env.SIM_USDSO_PER_POOL ?? "7");
    const simTotal = simPerPool * 3n;
    const usdsoContract = await hre.viem.getContractAt("MockERC20", addresses.usdso);
    const simApproveTx = await usdsoContract.write.approve([arena.address, simTotal]);
    await publicClient.waitForTransactionReceipt({ hash: simApproveTx });
    const simFundTx = await arena.write.fundSimPools([simPerPool]);
    await publicClient.waitForTransactionReceipt({ hash: simFundTx });
    console.log(`  fundSimPools: ${formatEther(simPerPool)} USDso each (${formatEther(simTotal)} total).`);

    simAddresses = {
      simPoolWeth: simWeth.address as `0x${string}`,
      simPoolWbtc: simWbtc.address as `0x${string}`,
      simPoolSomi: simSomi.address as `0x${string}`,
    };
  }

  // 7. Write final deployment manifest
  const block = await publicClient.getBlockNumber();

  const externalWithSim = simAddresses
    ? { ...addresses, ...simAddresses }
    : addresses;

  const manifest = {
    network,
    block: block.toString(),
    deployer,
    contracts: {
      FighterRegistry: { address: registryAddress },
      Arena: {
        address: arena.address,
        subscriptionId: subId.toString(),
        turnIntervalBlocks: turnIntervalBlocks.toString(),
      },
      DuelHistory: { address: history.address },
      Bookmaker: { address: bookmaker.address },
      Matchmaker: { address: matchmaker.address },
    },
    external: externalWithSim,
  };

  writeManifest(manifest);
  console.log(`\nDeployment manifest written to deployments/${network}.json`);

  // 8. Summary table
  console.log("\n┌────────────────────┬────────────────────────────────────────────┐");
  console.log("│ Contract           │ Address                                    │");
  console.log("├────────────────────┼────────────────────────────────────────────┤");
  console.log(`│ FighterRegistry    │ ${registryAddress} │`);
  console.log(`│ Arena              │ ${arena.address} │`);
  console.log(`│ DuelHistory        │ ${history.address} │`);
  console.log(`│ Bookmaker          │ ${bookmaker.address} │`);
  console.log(`│ Matchmaker         │ ${matchmaker.address} │`);
  if (simAddresses) {
    console.log("├────────────────────┼────────────────────────────────────────────┤");
    console.log(`│ sim WETH pool      │ ${simAddresses.simPoolWeth} │`);
    console.log(`│ sim WBTC pool      │ ${simAddresses.simPoolWbtc} │`);
    console.log(`│ sim SOMI pool      │ ${simAddresses.simPoolSomi} │`);
  }
  console.log("└────────────────────┴────────────────────────────────────────────┘");
  console.log("\nDeploy complete.");
}

main().catch((err) => {
  console.error("deploy failed:", err);
  process.exitCode = 1;
});
