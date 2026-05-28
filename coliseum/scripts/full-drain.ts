import hre from "hardhat";
import { formatEther, formatUnits, parseEther } from "viem";
import fs from "fs"; import path from "path";

async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"));
  const arena = await hre.viem.getContractAt("Arena", m.contracts.Arena.address);
  const bookmaker = await hre.viem.getContractAt("Bookmaker", m.contracts.Bookmaker.address);
  const pub = await hre.viem.getPublicClient();
  const [w] = await hre.viem.getWalletClients();
  const me = w.account.address;

  const usdso = m.external.usdso;
  const pools = [m.external.poolWeth, m.external.poolWbtc, m.external.poolSomi];
  const labels = ["WETH", "WBTC", "SOMI"];

  const poolAbi = [{
    name: "getWithdrawableBalance", type: "function", stateMutability: "view",
    inputs: [{ name: "u", type: "address" }, { name: "t", type: "address" }],
    outputs: [{ type: "uint256" }],
  }] as const;

  // 1. Pull pool USDso back into Arena
  for (let i = 0; i < 3; i++) {
    const bal = await pub.readContract({
      address: pools[i] as `0x${string}`, abi: poolAbi,
      functionName: "getWithdrawableBalance", args: [arena.address, usdso],
    }) as bigint;
    if (bal === 0n) { console.log(`  ${labels[i]} pool: empty`); continue; }
    console.log(`  withdrawFromPool ${labels[i]}: ${formatUnits(bal, 18)} USDso`);
    const tx = await arena.write.withdrawFromPool([pools[i], usdso, bal]);
    await pub.waitForTransactionReceipt({ hash: tx });
  }

  // 2. Use new ownerWithdrawSeed (only works since arena was deployed with the new code)
  const seed = await arena.read.seedLiquidity() as bigint;
  console.log(`  seedLiquidity tracked: ${formatUnits(seed, 18)} USDso`);
  if (seed > 0n) {
    console.log(`  ownerWithdrawSeed(owner, ${formatUnits(seed, 18)})...`);
    const tx = await arena.write.ownerWithdrawSeed([me, seed]);
    await pub.waitForTransactionReceipt({ hash: tx });
  }

  // 3. withdrawFees
  const fees = await arena.read.accruedFees() as bigint;
  console.log(`  accruedFees: ${formatUnits(fees, 18)} USDso`);
  if (fees > 0n) {
    console.log(`  withdrawFees(owner)...`);
    const tx = await arena.write.withdrawFees([me]);
    await pub.waitForTransactionReceipt({ hash: tx });
  }

  // 4. Pull STT off Arena (leave 1 buffer)
  const arenaStt = await pub.getBalance({ address: arena.address });
  const buffer = parseEther("1");
  if (arenaStt > buffer) {
    const amt = arenaStt - buffer;
    console.log(`  Arena.withdrawNative(owner, ${formatEther(amt)} STT)`);
    const tx = await arena.write.withdrawNative([me, amt]);
    await pub.waitForTransactionReceipt({ hash: tx });
  }

  // 5. Pull STT off Bookmaker (leave 1 buffer)
  const bookStt = await pub.getBalance({ address: bookmaker.address });
  if (bookStt > buffer) {
    const amt = bookStt - buffer;
    console.log(`  Bookmaker.withdrawNative(owner, ${formatEther(amt)} STT)`);
    const tx = await bookmaker.write.withdrawNative([me, amt]);
    await pub.waitForTransactionReceipt({ hash: tx });
  }

  // Final balance
  const usdsoAbi = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const;
  const finalUsdso = await pub.readContract({ address: usdso, abi: usdsoAbi, functionName: "balanceOf", args: [me] }) as bigint;
  const finalStt = await pub.getBalance({ address: me });
  console.log(`\nWallet now: ${formatEther(finalStt)} STT, ${formatUnits(finalUsdso, 18)} USDso`);
}
main().catch(e => console.error(e?.shortMessage ?? e));
