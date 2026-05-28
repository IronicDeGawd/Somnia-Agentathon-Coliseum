import hre from "hardhat";
import { formatEther } from "viem";
import fs from "fs";
import path from "path";

async function main() {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"
  ));
  const arenaAddr = manifest.contracts.Arena.address as `0x${string}`;
  const pub = await hre.viem.getPublicClient();
  const arena = await hre.viem.getContractAt("Arena", arenaAddr);

  const sttBal = await pub.getBalance({ address: arenaAddr });
  const activeDuelId = await arena.read.activeDuelId() as bigint;
  const subId = await arena.read.subscriptionId() as bigint;
  const blockNum = await pub.getBlockNumber();

  console.log(`Arena:           ${arenaAddr}`);
  console.log(`STT balance:     ${formatEther(sttBal)} STT`);
  console.log(`subscriptionId:  ${subId}`);
  console.log(`activeDuelId:    ${activeDuelId}`);
  console.log(`Current block:   ${blockNum}`);

  if (activeDuelId > 0n) {
    const duel = await arena.read.duels([activeDuelId]) as readonly unknown[];
    console.log(`\nDuel ${activeDuelId}:`);
    console.log(`  fighterA:           ${duel[0]}`);
    console.log(`  fighterB:           ${duel[1]}`);
    console.log(`  creator:            ${duel[2]}`);
    console.log(`  startBlock:         ${duel[3]}`);
    console.log(`  lastTurnBlock:      ${duel[4]}`);
    console.log(`  completedCallbacks: ${duel[5]}`);
    console.log(`  turns:              ${duel[6]}`);
    console.log(`  poolMask:           ${duel[7]} (0x${(duel[7] as number).toString(16)})`);
    console.log(`  status:             ${duel[8]} (1=Active 2=Finalizing 3=Resolved)`);
    console.log(`  initial USDso:      ${formatEther(duel[9] as bigint)}`);
    console.log(`  blocks since turn:  ${blockNum - (duel[4] as bigint)}`);
  }

  const TURN_INTERVAL = await arena.read.TURN_INTERVAL_BLOCKS() as bigint;
  console.log(`\nTURN_INTERVAL_BLOCKS: ${TURN_INTERVAL}`);
}

main().catch(console.error);
