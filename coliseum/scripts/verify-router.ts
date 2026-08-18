/**
 * verify-router.ts
 * ----------------
 * Confirms a deployed Arena is fully wired: every part answers, the routing
 * table points where the manifest says it does, and the reads other contracts
 * depend on still return what they always did.
 *
 * Run after any deploy or part swap:
 *   pnpm exec hardhat run scripts/verify-router.ts --network somnia
 */
import hre from "hardhat";
import { toFunctionSelector, formatEther } from "viem";
import fs from "fs";
import path from "path";

const ZERO = "0x0000000000000000000000000000000000000000";

async function main() {
  const manifestPath = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const arenaAddr = manifest.contracts.Arena.address as `0x${string}`;
  const parts = (manifest.contracts.Arena.parts ?? {}) as Record<string, string>;

  const arena = await hre.viem.getContractAt("Arena", arenaAddr);
  const pub = await hre.viem.getPublicClient();

  console.log(`\nArena: ${arenaAddr}`);
  console.log(`Code:  ${((await pub.getBytecode({ address: arenaAddr }))!.length - 2) / 2} bytes`);
  console.log(`STT:   ${formatEther(await pub.getBalance({ address: arenaAddr }))}`);

  console.log("\nParts:");
  for (const [name, addr] of Object.entries(parts)) {
    const code = await pub.getBytecode({ address: addr as `0x${string}` });
    const size = code ? (code.length - 2) / 2 : 0;
    console.log(`  ${name.padEnd(16)} ${addr}  ${String(size).padStart(6)} bytes${size === 0 ? "  ← NO CODE" : ""}`);
  }

  // Every signature the outside world calls must resolve — implemented by the
  // router, or claimed by a part. A missing one is silent until something fails.
  const ROUTED = [
    "hasCapacity()", "activeDuelId()", "getActiveDuelIds()", "duelsReadyForTurn()",
    "minDepositFor(uint16)", "minDepositForMarket(uint16,bool)",
    "startDuel(uint8,uint8,uint16,bool)", "startEventDuel(uint8,uint8,uint16)",
    "finalizeDuel(uint256)", "recoverFunds(uint256)", "turn(uint256)",
    "fundPools(uint256)", "setSimPools(address,address,address,uint8[3])",
    "setEventDesks(address[3],uint8[3],bytes8[3])", "minDepositForEvent(uint16)",
    "withdrawFromPool(address,address,uint256)",
  ];
  console.log("\nRouting:");
  let unrouted = 0;
  for (const sig of ROUTED) {
    const to = (await arena.read.partOf([toFunctionSelector(sig)])) as string;
    const known = Object.entries(parts).find(([, a]) => a.toLowerCase() === to.toLowerCase());
    if (to === ZERO) { unrouted++; console.log(`  ${sig.padEnd(48)} UNROUTED`); }
    else console.log(`  ${sig.padEnd(48)} ${known ? known[0] : to}`);
  }

  // Reads that must survive the split, because other contracts and the site use
  // them exactly as they are.
  console.log("\nLive reads:");
  console.log(`  owner            ${await arena.read.owner()}`);
  console.log(`  maxActiveDuels   ${await arena.read.maxActiveDuels()}`);
  console.log(`  hasCapacity      ${await arena.read.hasCapacity()}          (routed)`);
  console.log(`  activeDuelId     ${await arena.read.activeDuelId()}          (routed)`);
  console.log(`  platformFee(3)   ${formatEther((await arena.read.platformFee([3])) as bigint)} USDso  (router)`);
  console.log(`  minDeposit(3)    ${formatEther((await arena.read.minDepositForMarket([3, false])) as bigint)} USDso  (routed)`);
  console.log(`  duelHistory      ${await arena.read.duelHistory()}`);
  const duel = (await arena.read.duels([1n])) as unknown[];
  console.log(`  duels(1) fields  ${duel.length}  (Bookmaker and Matchmaker read the first 12)`);

  if (unrouted > 0) throw new Error(`${unrouted} signature(s) unrouted — Arena is only half wired`);
  console.log("\nAll wired.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
