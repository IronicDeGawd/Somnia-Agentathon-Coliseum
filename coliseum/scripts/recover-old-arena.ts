import hre from "hardhat";
import { formatEther, formatUnits, parseEther } from "viem";

// Old arena (deployed with pre-H-1 code — sweepToken(USDso) still works there)
const OLD_ARENA = "0x12750008c9c0b37421999edcb6bf35ff040c5104" as `0x${string}`;
const USDSO     = "0x9c32F3827A1a99f0cf9B213de8b53eC3d57bb171" as `0x${string}`;
const POOLS: `0x${string}`[] = [
  "0xD180195da5459C7a0DEA188ed61216ec43682b50", // WETH
  "0x3605f28aA7C50e7441211e77Cb0762d49539326C", // WBTC
  "0x259fD6559214dd5aD3752322426eA9F9fABEFff4", // SOMI
];

async function main() {
  const [wallet] = await hre.viem.getWalletClients();
  const me = wallet.account.address;
  const pub = await hre.viem.getPublicClient();

  const arena = await hre.viem.getContractAt("Arena", OLD_ARENA);

  const usdsoAbi = [{
    name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }],
  }] as const;
  const usdsoBefore = await pub.readContract({
    address: USDSO, abi: usdsoAbi, functionName: "balanceOf", args: [me],
  }) as bigint;
  const sttBefore = await pub.getBalance({ address: me });
  console.log(`\nBefore: ${formatEther(sttBefore)} STT, ${formatUnits(usdsoBefore, 18)} USDso\n`);

  // 1. Pull USDso from each pool back into the OLD arena contract
  const poolAbi = [{
    name: "getWithdrawableBalance", type: "function", stateMutability: "view",
    inputs: [{ name: "u", type: "address" }, { name: "t", type: "address" }],
    outputs: [{ type: "uint256" }],
  }] as const;

  for (let i = 0; i < POOLS.length; i++) {
    const pool = POOLS[i];
    const bal = await pub.readContract({
      address: pool, abi: poolAbi, functionName: "getWithdrawableBalance",
      args: [OLD_ARENA, USDSO],
    }) as bigint;
    if (bal === 0n) { console.log(`  pool ${i}: empty`); continue; }
    console.log(`  withdrawFromPool(${pool.slice(0, 10)}…, ${formatUnits(bal, 18)} USDso)`);
    const tx = await arena.write.withdrawFromPool([pool, USDSO, bal]);
    await pub.waitForTransactionReceipt({ hash: tx });
  }

  // 2. Old arena was deployed BEFORE the sweepToken(USDso) block — this still works
  const arenaBal = await pub.readContract({
    address: USDSO, abi: usdsoAbi, functionName: "balanceOf", args: [OLD_ARENA],
  }) as bigint;
  if (arenaBal > 0n) {
    console.log(`  sweepToken(USDSO, owner, ${formatUnits(arenaBal, 18)})`);
    const tx = await arena.write.sweepToken([USDSO, me, arenaBal]);
    await pub.waitForTransactionReceipt({ hash: tx });
  }

  // 3. Drain native STT from old arena (leave 1 STT buffer)
  const arenaStt = await pub.getBalance({ address: OLD_ARENA });
  const buffer = parseEther("1");
  if (arenaStt > buffer) {
    const amount = arenaStt - buffer;
    console.log(`  withdrawNative(owner, ${formatEther(amount)} STT)`);
    const tx = await arena.write.withdrawNative([me, amount]);
    await pub.waitForTransactionReceipt({ hash: tx });
  }

  const usdsoAfter = await pub.readContract({
    address: USDSO, abi: usdsoAbi, functionName: "balanceOf", args: [me],
  }) as bigint;
  const sttAfter = await pub.getBalance({ address: me });
  console.log(`\nAfter: ${formatEther(sttAfter)} STT, ${formatUnits(usdsoAfter, 18)} USDso`);
  console.log(`Delta: +${formatEther(sttAfter - sttBefore)} STT, +${formatUnits(usdsoAfter - usdsoBefore, 18)} USDso`);
}

main().catch((e) => { console.error("recover failed:", e?.shortMessage || e); process.exitCode = 1; });
