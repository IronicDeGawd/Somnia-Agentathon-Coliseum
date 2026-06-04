// ============================================================================
// Arena + DuelHistory migration deploy.
// ----------------------------------------------------------------------------
// Redeploys the core contracts so the Arena carries the DuelHistory hook. Because
// Bookmaker and Matchmaker hold the Arena address as `immutable`, all four are
// redeployed together (Arena → DuelHistory → Bookmaker → Matchmaker), then
// arena.setDuelHistory wires the sink.
//
// REUSES (testnet): the existing FighterRegistry + external addresses (USDso,
// pools, platform) from deployments/somnia.json — registry data is immutable, so
// reusing keeps the frontend FighterRegistry address stable.
//
// SKIPS fundPools by default (deployer USDso is low; the new Arena has
// withdrawFromPool so pools can be funded — and recovered — later when duels run).
// Set USDSO_PER_POOL to fund at deploy time.
//
// Local dry-run (mocks): pnpm exec hardhat run scripts/deploy-arena-history.ts
// Testnet broadcast:    pnpm exec hardhat run scripts/deploy-arena-history.ts --network somnia
// ============================================================================

import hre from "hardhat";
import { parseEther, formatEther } from "viem";
import fs from "fs";
import path from "path";

const IS_LOCAL = hre.network.name === "localhost" || hre.network.name === "hardhat";

async function main() {
  const network = hre.network.name;
  console.log(`\nArena+DuelHistory migration — network: ${network}`);

  const walletClients = await hre.viem.getWalletClients();
  if (!walletClients.length) throw new Error("No wallet clients — set PRIVATE_KEY in .env");
  const deployer = walletClients[0].account.address;
  const publicClient = await hre.viem.getPublicClient();
  const balance = await publicClient.getBalance({ address: deployer });
  console.log(`Deployer: ${deployer}`);
  console.log(`Balance:  ${formatEther(balance)} STT`);
  if (!IS_LOCAL && balance < parseEther("70")) {
    throw new Error(`Insufficient balance: need >=70 STT, have ${formatEther(balance)}`);
  }

  const manifestPath = path.join(__dirname, "..", "deployments", `${network}.json`);

  // ── Resolve registry + external addresses ────────────────────────────────
  let registryAddr: `0x${string}`;
  let external: { usdso: `0x${string}`; poolWeth: `0x${string}`; poolWbtc: `0x${string}`; poolSomi: `0x${string}`; platform: `0x${string}` };
  let prior: any = {};

  if (IS_LOCAL) {
    console.log("\nLocal dry-run: deploying mocks + fresh registry...");
    const usdso = await hre.viem.deployContract("MockERC20", ["USDso", "USDso"]);
    const poolWeth = await hre.viem.deployContract("MockSpotPool");
    const poolWbtc = await hre.viem.deployContract("MockSpotPool");
    const poolSomi = await hre.viem.deployContract("MockSpotPool");
    const platform = await hre.viem.deployContract("MockPlatform");
    const registry = await hre.viem.deployContract("FighterRegistry");
    registryAddr = registry.address;
    external = {
      usdso: usdso.address, poolWeth: poolWeth.address, poolWbtc: poolWbtc.address,
      poolSomi: poolSomi.address, platform: platform.address,
    };
  } else {
    prior = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    registryAddr = prior.contracts.FighterRegistry.address;
    external = prior.external;
    console.log(`\nReusing FighterRegistry: ${registryAddr}`);
    console.log(`Reusing external:        ${JSON.stringify(external)}`);
  }

  const turnIntervalBlocks = IS_LOCAL ? 1n : 600n;
  const baseDecimals: [number, number, number] = IS_LOCAL ? [18, 18, 18] : [18, 8, 18];
  const reactivityFund = parseEther("33");

  // ── 1. Arena ─────────────────────────────────────────────────────────────
  console.log(`\nDeploying Arena... (baseDecimals=${JSON.stringify(baseDecimals)}, value=33 STT)`);
  const arena = await hre.viem.deployContract(
    "Arena",
    [registryAddr, external.usdso, external.poolWeth, external.poolWbtc, external.poolSomi, external.platform, turnIntervalBlocks, baseDecimals],
    { value: reactivityFund }
  );
  const subId = (await arena.read.subscriptionId()) as bigint;
  console.log(`  Arena:           ${arena.address}  (subscriptionId=${subId})`);

  // ── 2. DuelHistory + wire ────────────────────────────────────────────────
  console.log("Deploying DuelHistory...");
  const history = await hre.viem.deployContract("DuelHistory", [arena.address]);
  console.log(`  DuelHistory:     ${history.address}`);
  const setTx = await arena.write.setDuelHistory([history.address]);
  await publicClient.waitForTransactionReceipt({ hash: setTx });
  const wired = (await arena.read.duelHistory()) as `0x${string}`;
  if (wired.toLowerCase() !== history.address.toLowerCase()) {
    throw new Error(`setDuelHistory failed: arena.duelHistory=${wired}, expected ${history.address}`);
  }
  console.log(`  setDuelHistory wired OK (${wired})`);

  // ── 3. Bookmaker ─────────────────────────────────────────────────────────
  console.log("Deploying Bookmaker... (value=33 STT)");
  const bookmaker = await hre.viem.deployContract(
    "Bookmaker",
    [arena.address, external.usdso, registryAddr, external.platform, turnIntervalBlocks],
    { value: reactivityFund }
  );
  console.log(`  Bookmaker:       ${bookmaker.address}`);

  // ── 4. Matchmaker (3-arg constructor: arena, usdso, registry) ─────────────
  console.log("Deploying Matchmaker...");
  const matchmaker = await hre.viem.deployContract(
    "Matchmaker",
    [arena.address, external.usdso, registryAddr]
  );
  console.log(`  Matchmaker:      ${matchmaker.address}`);

  // ── 5. Optional fundPools (skipped unless USDSO_PER_POOL set) ─────────────
  if (!IS_LOCAL && process.env.USDSO_PER_POOL) {
    const perPool = parseEther(process.env.USDSO_PER_POOL);
    const total = perPool * 3n;
    console.log(`Funding pools ${formatEther(perPool)} USDso each (${formatEther(total)} total)...`);
    const usdsoC = await hre.viem.getContractAt("MockERC20", external.usdso);
    await publicClient.waitForTransactionReceipt({ hash: await usdsoC.write.approve([arena.address, total]) });
    await publicClient.waitForTransactionReceipt({ hash: await arena.write.fundPools([perPool]) });
    console.log("  Pools funded.");
  } else if (!IS_LOCAL) {
    console.log("Skipping fundPools (set USDSO_PER_POOL to fund). New Arena supports withdrawFromPool.");
  }

  // ── 6. Write manifest (preserve prior non-contract fields) ───────────────
  const block = await publicClient.getBlockNumber();
  const manifest = {
    ...prior,
    network,
    block: block.toString(),
    deployer,
    contracts: {
      ...(prior.contracts ?? {}),  // preserve prior entries (e.g. SwapFallback)
      FighterRegistry: { address: registryAddr },
      Arena: { address: arena.address, subscriptionId: subId.toString(), turnIntervalBlocks: turnIntervalBlocks.toString() },
      DuelHistory: { address: history.address },
      Bookmaker: { address: bookmaker.address },
      Matchmaker: { address: matchmaker.address },
    },
    external,
  };
  if (!IS_LOCAL) {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`\nManifest written to deployments/${network}.json`);
  }

  console.log("\n┌─────────────────┬──────────────────────────────────────────────┐");
  console.log(`│ Arena           │ ${arena.address} │`);
  console.log(`│ DuelHistory     │ ${history.address} │`);
  console.log(`│ Bookmaker       │ ${bookmaker.address} │`);
  console.log(`│ Matchmaker      │ ${matchmaker.address} │`);
  console.log(`│ FighterRegistry │ ${registryAddr} (reused) │`);
  console.log("└─────────────────┴──────────────────────────────────────────────┘");
  console.log(`\nDeploy block: ${block}`);
  console.log("\nNEXT: update frontend lib/contracts.ts (Arena, Bookmaker, Matchmaker, DuelHistory addresses;");
  console.log("      BOOKMAKER_DEPLOY_BLOCK = deploy block), rebuild, redeploy frontend.");
}

main().catch((err) => { console.error("deploy failed:", err); process.exitCode = 1; });
