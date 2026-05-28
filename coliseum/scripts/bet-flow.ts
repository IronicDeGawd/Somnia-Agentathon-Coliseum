import hre from "hardhat";
import { formatUnits, parseEther, maxUint256 } from "viem";
import fs from "fs"; import path from "path";

async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"));
  const arena = await hre.viem.getContractAt("Arena", m.contracts.Arena.address);
  const bookmaker = await hre.viem.getContractAt("Bookmaker", m.contracts.Bookmaker.address);
  const pub = await hre.viem.getPublicClient();
  const [w] = await hre.viem.getWalletClients();
  const me = w.account.address;
  const usdso = m.external.usdso;

  const duelId = await arena.read.activeDuelId() as bigint;
  console.log(`Active duel: ${duelId}`);
  if (duelId === 0n) { console.log("No active duel"); return; }

  // 1. Initialize odds (owner) — 60/40 favoring fighterA
  const oddsBefore = await bookmaker.read.currentOdds([duelId, 0]) as number;
  if (oddsBefore === 0) {
    console.log("Initializing odds: 6000 / 4000 (A 60%, B 40%)...");
    const tx = await bookmaker.write.initializeOdds([duelId, 6000, 4000]);
    await pub.waitForTransactionReceipt({ hash: tx });
  } else {
    console.log(`Odds already set: A=${oddsBefore}, B=${10000 - oddsBefore}`);
  }

  // 2. Approve Bookmaker for USDso
  const usdsoAbi = [
    { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
    { name: "approve",   type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
    { name: "allowance", type: "function", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  ] as const;

  const bal = await pub.readContract({ address: usdso, abi: usdsoAbi, functionName: "balanceOf", args: [me] }) as bigint;
  console.log(`Wallet USDso: ${formatUnits(bal, 18)}`);

  const stake = parseEther("0.5"); // bet 0.5 USDso on fighterA
  if (bal < stake) { console.log(`Need ${formatUnits(stake, 18)} USDso to bet`); return; }

  const allow = await pub.readContract({ address: usdso, abi: usdsoAbi, functionName: "allowance", args: [me, bookmaker.address] }) as bigint;
  if (allow < stake) {
    console.log("Approving Bookmaker for max USDso...");
    const tx = await w.writeContract({ address: usdso, abi: usdsoAbi, functionName: "approve", args: [bookmaker.address, maxUint256] });
    await pub.waitForTransactionReceipt({ hash: tx });
  }

  // 3. Place bet
  console.log(`Placing bet: ${formatUnits(stake, 18)} USDso on fighter A (slot 0)...`);
  const tx = await bookmaker.write.placeBet([duelId, 0, stake]);
  const r = await pub.waitForTransactionReceipt({ hash: tx });
  console.log(`  tx: ${tx}, status: ${r.status}, logs: ${r.logs.length}`);

  // 4. Read the bet back
  const bet = await bookmaker.read.bets([duelId, 0n]) as readonly unknown[];
  console.log(`\nBet recorded:`);
  console.log(`  bettor:             ${bet[0]}`);
  console.log(`  fighterId (slot):   ${bet[1]}`);
  console.log(`  stake:              ${formatUnits(bet[2] as bigint, 18)} USDso`);
  console.log(`  oddsAtPlacementBps: ${bet[3]} (= ${Number(bet[3])/100}%)`);
  console.log(`  settled:            ${bet[4]}`);
  console.log(`  Implied payout if wins: ${formatUnits((bet[2] as bigint) * 10000n / BigInt(bet[3] as number), 18)} USDso`);
}
main().catch(e => console.error(e?.shortMessage ?? e));
