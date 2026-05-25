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

  function writeManifest(partial: object) {
    const json = JSON.stringify(partial, null, 2);
    try {
      fs.writeFileSync(outFile, json);
    } catch (err) {
      console.error("writeFileSync failed — manifest contents follow:");
      console.log(json);
    }
  }

  // 1. FighterRegistry
  console.log("\nDeploying FighterRegistry...");
  const registry = await hre.viem.deployContract("FighterRegistry");
  console.log(`  FighterRegistry: ${registry.address}`);
  writeManifest({ network, deployer, contracts: { FighterRegistry: { address: registry.address } }, external: addresses });

  // 2. Arena
  console.log("Deploying Arena...");
  const arena = await hre.viem.deployContract(
    "Arena",
    [
      registry.address,
      addresses.usdso,
      addresses.poolWeth,
      addresses.poolWbtc,
      addresses.poolSomi,
      addresses.platform,
      turnIntervalBlocks,
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
      FighterRegistry: { address: registry.address },
      Arena: { address: arena.address, subscriptionId: subId.toString(), turnIntervalBlocks: turnIntervalBlocks.toString() },
    },
    external: addresses,
  });

  // 3. Bookmaker
  console.log("Deploying Bookmaker...");
  const bookmaker = await hre.viem.deployContract(
    "Bookmaker",
    [arena.address, addresses.usdso, turnIntervalBlocks],
    { value: reactivityFund }
  );
  console.log(`  Bookmaker:       ${bookmaker.address}`);

  // 4. Fund pools (testnet only, deployer must hold USDso and approve arena first)
  if (!IS_LOCAL) {
    console.log("\nFunding pools with 50 USDso each...");
    const usdsoContract = await hre.viem.getContractAt("MockERC20", addresses.usdso);
    const approveTx = await usdsoContract.write.approve([arena.address, parseEther("150")]);
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    const fundTx = await arena.write.fundPools([parseEther("50")]);
    await publicClient.waitForTransactionReceipt({ hash: fundTx });
    console.log("  Pools funded.");
  }

  // 5. Write final deployment manifest
  const block = await publicClient.getBlockNumber();
  const manifest = {
    network,
    block: block.toString(),
    deployer,
    contracts: {
      FighterRegistry: { address: registry.address },
      Arena: {
        address: arena.address,
        subscriptionId: subId.toString(),
        turnIntervalBlocks: turnIntervalBlocks.toString(),
      },
      Bookmaker: { address: bookmaker.address },
    },
    external: addresses,
  };

  writeManifest(manifest);
  console.log(`\nDeployment manifest written to deployments/${network}.json`);

  // 6. Summary table
  console.log("\n┌────────────────────┬────────────────────────────────────────────┐");
  console.log("│ Contract           │ Address                                    │");
  console.log("├────────────────────┼────────────────────────────────────────────┤");
  console.log(`│ FighterRegistry    │ ${registry.address} │`);
  console.log(`│ Arena              │ ${arena.address} │`);
  console.log(`│ Bookmaker          │ ${bookmaker.address} │`);
  console.log("└────────────────────┴────────────────────────────────────────────┘");
  console.log("\nDeploy complete.");
}

main().catch((err) => {
  console.error("deploy failed:", err);
  process.exitCode = 1;
});
