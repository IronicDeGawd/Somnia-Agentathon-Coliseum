/**
 * queue-opponent.ts
 * -----------------
 * Joins the matchmaking queue from the operator wallet so a waiting player gets
 * an opponent. Used to drive a live end-to-end run when nobody else is queued.
 *
 *   TURNS=9 FIGHTER=1 MARKET=2 pnpm exec hardhat run scripts/queue-opponent.ts --network somnia
 *
 * MARKET is 0 spot coins, 1 practice, 2 mixed (SOMI plus two prediction
 * questions). Queues are separate per market, so this must match the waiting
 * player's choice or the two will never pair.
 *
 * FIGHTER is a registry index (0 DEGEN, 1 WHALE, 2 QUANT, 3 DIAMOND HAND,
 * 4 SCALPER, 5 CONTRARIAN) and must differ from the waiting player's pick.
 */
import hre from "hardhat";
import { formatEther, maxUint256 } from "viem";
import fs from "fs";
import path from "path";

const ERC20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

async function main() {
  const turns = Number(process.env.TURNS ?? "3");
  const fighter = Number(process.env.FIGHTER ?? "1");
  // SIMULATED=1 still works and means practice.
  const market = Number(process.env.MARKET ?? (process.env.SIMULATED === "1" ? "1" : "2"));

  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "deployments", `${hre.network.name}.json`), "utf-8"));
  const mmAddr = manifest.contracts.Matchmaker.address as `0x${string}`;
  const arenaAddr = manifest.contracts.Arena.address as `0x${string}`;

  const pub = await hre.viem.getPublicClient();
  const [wallet] = await hre.viem.getWalletClients();
  const me = wallet.account.address;

  const mm = await hre.viem.getContractAt("Matchmaker", mmAddr);
  const arena = await hre.viem.getContractAt("Arena", arenaAddr);
  const usdso = (await arena.read.USDSO()) as `0x${string}`;

  const required = (await mm.read.halfDeposit([turns, market])) as bigint;
  const bal = (await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [me] })) as bigint;
  console.log(`Operator:  ${me}`);
  console.log(`Deposit:   ${formatEther(required)} USDso   (balance ${formatEther(bal)})`);
  if (bal < required) throw new Error("operator wallet is short of USDso");

  const allowance = (await pub.readContract({ address: usdso, abi: ERC20, functionName: "allowance", args: [me, mmAddr] })) as bigint;
  if (allowance < required) {
    const tx = await wallet.writeContract({ address: usdso, abi: ERC20, functionName: "approve", args: [mmAddr, maxUint256] });
    await pub.waitForTransactionReceipt({ hash: tx });
    console.log(`Approved Matchmaker to spend USDso`);
  }

  const slotBefore = (await mm.read.getSlot([turns, market])) as unknown[];
  console.log(`Waiting player: ${slotBefore[0]} (fighter ${slotBefore[1]})`);

  // queue takes the fighter FIRST, then the tier, then the market.
  const tx = await mm.write.queue([fighter, turns, market]);
  const receipt = await pub.waitForTransactionReceipt({ hash: tx });
  console.log(`queue tx: ${tx}  (block ${receipt.blockNumber})`);

  const duelId = (await arena.read.activeDuelId()) as bigint;
  console.log(`\nArena activeDuelId: ${duelId}`);
  if (duelId === 0n) {
    console.log("No duel started — the pair may be waiting behind a full Arena.");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
