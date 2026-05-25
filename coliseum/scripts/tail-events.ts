import hre from "hardhat";
import { parseAbiItem } from "viem";
import fs from "fs";
import path from "path";

const TAIL_TIMEOUT_MS = parseInt(process.env.TAIL_TIMEOUT_MS ?? "1800000"); // 30 min default

async function main() {
  const network = hre.network.name;
  const manifestPath = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No manifest at ${manifestPath}. Deploy first.`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const arenaAddress = manifest.contracts.Arena.address as `0x${string}`;

  const publicClient = await hre.viem.getPublicClient();
  const arena = await hre.viem.getContractAt("Arena", arenaAddress);

  const activeDuelId = (await arena.read.activeDuelId()) as bigint;
  console.log(`\nTailing Arena ${arenaAddress}`);
  console.log(`activeDuelId: ${activeDuelId}`);
  console.log(`Timeout: ${TAIL_TIMEOUT_MS / 1000}s — Ctrl+C to stop early\n`);

  const events = [
    "DuelStarted(uint256 indexed duelId, uint8 fighterA, uint8 fighterB, address pool, uint256 startBlock)",
    "FighterMoveRequested(uint256 indexed duelId, uint8 indexed fighterId, uint256 indexed requestId)",
    "FighterMove(uint256 indexed duelId, uint8 indexed fighterId, uint8 action, uint128 orderId)",
    "FighterMoveFailed(uint256 indexed duelId, uint8 indexed fighterId, string reason)",
    "OrderPlaced(address indexed pool, uint8 indexed fighterId, uint256 duelId, uint128 orderId, bool isBid, uint256 price, uint256 quantity, uint8 orderType)",
    "OrderRejected(address indexed pool, uint8 indexed fighterId, uint256 duelId, bool isBid, uint256 price, uint256 quantity, uint8 orderType, string reason)",
    "TurnAdvanced(uint256 indexed duelId, uint16 completedCallbacks, uint256 blockNumber)",
    "DuelResolved(uint256 indexed duelId, uint8 indexed winnerId, uint256 fighterAValueUsdso, uint256 fighterBValueUsdso)",
  ];

  let resolved = false;

  const unwatchers = events.map((sig) =>
    publicClient.watchEvent({
      address: arenaAddress,
      event: parseAbiItem(`event ${sig}`) as any,
      onLogs: (logs: any[]) => {
        for (const log of logs) {
          const ts = new Date().toISOString();
          const name = sig.split("(")[0];
          const args = JSON.stringify(log.args, (_, v) => (typeof v === "bigint" ? v.toString() : v));
          console.log(`[${ts}] ${name} ${args}`);
          if (name === "DuelResolved") resolved = true;
        }
      },
    })
  );

  const deadline = Date.now() + TAIL_TIMEOUT_MS;
  while (!resolved && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
  }

  for (const unwatch of unwatchers) unwatch();
  if (!resolved) console.log(`\n(timeout reached — DuelResolved not seen)`);
}

main().catch((err) => {
  console.error("tail-events failed:", err);
  process.exitCode = 1;
});
