/**
 * resume-arena-deploy.ts
 * ----------------------
 * Finishes an Arena migration that died partway.
 *
 * deploy-arena-history.ts deployed Arena and DuelHistory, then failed on
 * Bookmaker: its constructor gained a `_matchmaker` parameter and the script
 * still passed five args in the old order. Re-running the whole script would
 * spend another 33 STT redeploying a perfectly good Arena — and would fail its
 * own >=70 STT balance gate anyway, since the first run spent that much.
 *
 * So this picks up from the existing Arena/DuelHistory and deploys only what is
 * missing, in the order the constructors actually require:
 *   Matchmaker (needs Arena) -> Bookmaker (needs Matchmaker, and reverts
 *   BadMatchmaker if it has no code).
 *
 * Verifies the supplied Arena is real and already wired to its DuelHistory
 * before spending anything.
 *
 * Run:
 *   ARENA=0x.. DUEL_HISTORY=0x.. ARENA_UTILS=0x.. \
 *     pnpm exec hardhat run scripts/resume-arena-deploy.ts --network somnia
 */
import hre from "hardhat";
import { parseEther, formatEther, getAddress } from "viem";
import fs from "fs";
import path from "path";

async function main() {
  const network = hre.network.name;
  if (network !== "somnia") throw new Error(`expected --network somnia, got ${network}`);

  const arenaAddr   = getAddress(process.env.ARENA!);
  const historyAddr = getAddress(process.env.DUEL_HISTORY!);
  const utilsAddr   = getAddress(process.env.ARENA_UTILS!);

  const publicClient = await hre.viem.getPublicClient();
  const [wallet] = await hre.viem.getWalletClients();
  const deployer = wallet.account.address;
  const balance = await publicClient.getBalance({ address: deployer });
  console.log(`\nResume Arena migration — deployer ${deployer}`);
  console.log(`Balance: ${formatEther(balance)} STT`);

  const reactivityFund = parseEther("33");
  if (balance < reactivityFund + parseEther("2")) {
    throw new Error(`need >=35 STT for the Bookmaker reactivity fund + gas, have ${formatEther(balance)}`);
  }

  // ── Verify what the first run left behind ────────────────────────────────
  for (const [name, addr] of [["Arena", arenaAddr], ["DuelHistory", historyAddr], ["ArenaUtils", utilsAddr]] as const) {
    const code = await publicClient.getCode({ address: addr });
    if (!code || code === "0x") throw new Error(`${name} at ${addr} has no code`);
  }
  const arena = await hre.viem.getContractAt("Arena", arenaAddr);
  const wiredHistory = (await arena.read.duelHistory()) as `0x${string}`;
  if (wiredHistory.toLowerCase() !== historyAddr.toLowerCase()) {
    throw new Error(`Arena.duelHistory=${wiredHistory}, expected ${historyAddr}`);
  }
  console.log(`  Arena:           ${arenaAddr}  (duelHistory wired OK)`);

  const manifestPath = path.join(__dirname, "..", "deployments", `${network}.json`);
  const prior = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const registryAddr = prior.contracts.FighterRegistry.address as `0x${string}`;
  const external = prior.external;
  const turnIntervalBlocks = 600n;

  // ── Matchmaker, then Bookmaker ───────────────────────────────────────────
  console.log("Deploying Matchmaker...");
  const matchmaker = await hre.viem.deployContract(
    "Matchmaker",
    [arenaAddr, external.usdso, registryAddr],
  );
  console.log(`  Matchmaker:      ${matchmaker.address}`);

  console.log("Deploying Bookmaker... (value=33 STT)");
  const bookmaker = await hre.viem.deployContract(
    "Bookmaker",
    [arenaAddr, external.usdso, registryAddr, matchmaker.address, external.platform, turnIntervalBlocks],
    { value: reactivityFund },
  );
  console.log(`  Bookmaker:       ${bookmaker.address}`);

  const subId = (await arena.read.subscriptionId()) as bigint;
  const block = await publicClient.getBlockNumber();

  const merged = {
    ...prior,
    network,
    block: block.toString(),
    deployer,
    contracts: {
      ...prior.contracts,
      FighterRegistry: { address: registryAddr },
      Arena: {
        address: arenaAddr,
        subscriptionId: subId.toString(),
        turnIntervalBlocks: turnIntervalBlocks.toString(),
        arenaUtils: utilsAddr,
      },
      DuelHistory: { address: historyAddr },
      Bookmaker:   { address: bookmaker.address },
      Matchmaker:  { address: matchmaker.address },
    },
    external,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(merged, null, 2));
  console.log(`\nManifest written: ${manifestPath}`);

  console.log("\n┌─────────────────┬────────────────────────────────────────────┐");
  for (const [k, v] of [
    ["ArenaUtils", utilsAddr],
    ["Arena", arenaAddr],
    ["DuelHistory", historyAddr],
    ["Matchmaker", matchmaker.address],
    ["Bookmaker", bookmaker.address],
    ["FighterRegistry", registryAddr],
  ] as const) {
    console.log(`│ ${k.padEnd(15)} │ ${v} │`);
  }
  console.log("└─────────────────┴────────────────────────────────────────────┘");
  console.log(`\nRemaining balance: ${formatEther(await publicClient.getBalance({ address: deployer }))} STT`);
}

main().catch((e) => { console.error(e); process.exit(1); });
