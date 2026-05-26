import hre from "hardhat";
import { parseEther, formatEther, formatUnits } from "viem";
import fs from "fs";
import path from "path";

async function main() {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"
  ));
  const arenaAddr = manifest.contracts.Arena.address as `0x${string}`;
  const bookmakerAddr = manifest.contracts.Bookmaker.address as `0x${string}`;
  const usdso = manifest.external.usdso as `0x${string}`;
  const pools: `0x${string}`[] = [
    manifest.external.poolWeth,
    manifest.external.poolWbtc,
    manifest.external.poolSomi,
  ];

  const [wallet] = await hre.viem.getWalletClients();
  const me = wallet.account.address;
  const pub = await hre.viem.getPublicClient();

  const arena = await hre.viem.getContractAt("Arena", arenaAddr);
  const bookmaker = await hre.viem.getContractAt("Bookmaker", bookmakerAddr);

  console.log("\nRecovery — pulling everything out of stuck contracts");
  console.log("Owner:", me);
  console.log("Arena:", arenaAddr);
  console.log("Bookmaker:", bookmakerAddr);

  const sttBefore = await pub.getBalance({ address: me });
  const usdsoMin = [{
    name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }],
  }] as const;
  const usdsoBefore = await pub.readContract({
    address: usdso, abi: usdsoMin, functionName: "balanceOf", args: [me],
  }) as bigint;
  console.log(`\nBefore: ${formatEther(sttBefore)} STT, ${formatUnits(usdsoBefore, 18)} USDso\n`);

  // 1. Pull USDso out of each pool back into Arena
  for (let i = 0; i < pools.length; i++) {
    const pool = pools[i];
    const arenaPoolBal = await pub.readContract({
      address: pool,
      abi: [{
        name: "getWithdrawableBalance", type: "function", stateMutability: "view",
        inputs: [{ name: "u", type: "address" }, { name: "t", type: "address" }],
        outputs: [{ type: "uint256" }],
      }],
      functionName: "getWithdrawableBalance",
      args: [arenaAddr, usdso],
    }) as bigint;
    if (arenaPoolBal === 0n) { console.log(`  pool ${i}: empty, skip`); continue; }
    console.log(`  withdrawFromPool(${pool.slice(0, 10)}…, USDSO, ${formatUnits(arenaPoolBal, 18)})`);
    const tx = await arena.write.withdrawFromPool([pool, usdso, arenaPoolBal]);
    await pub.waitForTransactionReceipt({ hash: tx });
  }

  // 2. Sweep USDso from Arena to owner
  const arenaUsdsoBal = await pub.readContract({
    address: usdso, abi: usdsoMin, functionName: "balanceOf", args: [arenaAddr],
  }) as bigint;
  if (arenaUsdsoBal > 0n) {
    console.log(`  sweepToken(USDSO, owner, ${formatUnits(arenaUsdsoBal, 18)})`);
    const tx = await arena.write.sweepToken([usdso, me, arenaUsdsoBal]);
    await pub.waitForTransactionReceipt({ hash: tx });
  }

  // 3. Sweep native STT from Arena to owner (leave 1 STT buffer for in-flight onEvent gas)
  const arenaSttBal = await pub.getBalance({ address: arenaAddr });
  const buffer = parseEther("1");
  if (arenaSttBal > buffer) {
    const amount = arenaSttBal - buffer;
    console.log(`  Arena.withdrawNative(owner, ${formatEther(amount)}) [held=${formatEther(arenaSttBal)}, buffer=1]`);
    const tx = await arena.write.withdrawNative([me, amount]);
    await pub.waitForTransactionReceipt({ hash: tx });
  }

  // 4. Sweep native STT from Bookmaker to owner (same buffer pattern)
  const bookSttBal = await pub.getBalance({ address: bookmakerAddr });
  if (bookSttBal > buffer) {
    const amount = bookSttBal - buffer;
    console.log(`  Bookmaker.withdrawNative(owner, ${formatEther(amount)}) [held=${formatEther(bookSttBal)}, buffer=1]`);
    const tx = await bookmaker.write.withdrawNative([me, amount]);
    await pub.waitForTransactionReceipt({ hash: tx });
  }

  const sttAfter = await pub.getBalance({ address: me });
  const usdsoAfter = await pub.readContract({
    address: usdso, abi: usdsoMin, functionName: "balanceOf", args: [me],
  }) as bigint;
  console.log(`\nAfter: ${formatEther(sttAfter)} STT, ${formatUnits(usdsoAfter, 18)} USDso`);
  console.log(`Delta: +${formatEther(sttAfter - sttBefore)} STT, +${formatUnits(usdsoAfter - usdsoBefore, 18)} USDso`);
}

main().catch((e) => { console.error("recover failed:", e); process.exitCode = 1; });
