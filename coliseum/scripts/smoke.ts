import hre from "hardhat";
import { parseEther, parseAbiItem } from "viem";
import fs from "fs";
import path from "path";

const SMOKE_TIMEOUT_MS = parseInt(process.env.SMOKE_TIMEOUT_MS ?? "1200000"); // 20 min default

const IS_LOCAL =
  hre.network.name === "localhost" || hre.network.name === "hardhat";

async function main() {
  const network = hre.network.name;
  const manifestPath = path.join(__dirname, "..", "deployments", `${network}.json`);

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No deployment manifest at ${manifestPath}. Run deploy first.`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const arenaAddress = manifest.contracts.Arena.address as `0x${string}`;
  const poolWeth = manifest.external.poolWeth as `0x${string}`;

  console.log(`\nColiseum smoke test — ${network}`);
  console.log(`Arena:   ${arenaAddress}`);
  console.log(`Pool:    ${poolWeth}`);

  const arena = await hre.viem.getContractAt("Arena", arenaAddress);
  const publicClient = await hre.viem.getPublicClient();

  // Start a duel
  console.log("\nStarting duel (fighter 0 vs fighter 1)...");
  const startTx = await arena.write.startDuel([0, 1, poolWeth, parseEther("100")]);
  const startReceipt = await publicClient.waitForTransactionReceipt({ hash: startTx });
  if (startReceipt.status === "reverted") throw new Error(`startDuel reverted: ${startTx}`);
  const activeDuelId = await arena.read.activeDuelId() as bigint;
  console.log(`  Duel started — id: ${activeDuelId}, tx: ${startTx}`);

  if (IS_LOCAL) {
    // On local, there are no fighter callbacks and no BlockTick.
    // Smoke test just verifies the deploy + startDuel path completes cleanly.
    console.log("\nLocal mode: deploy + startDuel succeeded — smoke pass.");
    return;
  }

  // Testnet: subscribe to events and wait for DuelResolved
  console.log(`\nWatching events (timeout: ${SMOKE_TIMEOUT_MS / 1000}s)...`);

  const events = [
    "FighterMoveRequested(uint256 indexed duelId, uint8 indexed fighterId, uint256 indexed requestId)",
    "FighterMove(uint256 indexed duelId, uint8 indexed fighterId, uint8 action, uint128 orderId)",
    "FighterMoveFailed(uint256 indexed duelId, uint8 indexed fighterId, string reason)",
    "TurnAdvanced(uint256 indexed duelId, uint16 completedCallbacks, uint256 blockNumber)",
    "DuelResolved(uint256 indexed duelId, uint8 indexed winnerId, uint256 fighterAValueUsdso, uint256 fighterBValueUsdso)",
  ];

  let resolved = false;

  const unwatchers = events.map((sig) => {
    return publicClient.watchEvent({
      address: arenaAddress,
      event: parseAbiItem(`event ${sig}`) as any,
      onLogs: (logs: any[]) => {
        for (const log of logs) {
          const ts = new Date().toISOString();
          const name = sig.split("(")[0];
          console.log(`[${ts}] ${name}`, JSON.stringify(log.args, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
          if (name === "DuelResolved") resolved = true;
        }
      },
    });
  });

  const deadline = Date.now() + SMOKE_TIMEOUT_MS;

  while (!resolved && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
  }

  for (const unwatch of unwatchers) unwatch();

  if (!resolved) {
    throw new Error(`Smoke timed out after ${SMOKE_TIMEOUT_MS / 1000}s — DuelResolved not seen`);
  }

  console.log("\nSmoke passed — DuelResolved received.");
}

main().catch((err) => {
  console.error("smoke failed:", err);
  process.exitCode = 1;
});
