import hre from "hardhat";
import { parseUnits, formatUnits, getAddress } from "viem";

const ARENA_ADDRESS = process.env.ARENA_ADDRESS;
const USDSO_PER_POOL_RAW = process.env.USDSO_PER_POOL ?? "1";

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

async function main() {
  if (!ARENA_ADDRESS) throw new Error("ARENA_ADDRESS env var required");
  if (isNaN(Number(USDSO_PER_POOL_RAW))) throw new Error(`USDSO_PER_POOL is not a valid number: "${USDSO_PER_POOL_RAW}"`);

  const arenaAddr = getAddress(ARENA_ADDRESS);
  const usdsoPerPool = parseUnits(USDSO_PER_POOL_RAW, 18);

  const publicClient = await hre.viem.getPublicClient();
  const walletClients = await hre.viem.getWalletClients();
  if (!walletClients.length) throw new Error("No wallet client — set PRIVATE_KEY in .env");
  const wallet = walletClients[0];

  const arenaAbi = (await hre.artifacts.readArtifact("Arena")).abi;
  const usdsoAddr = (await publicClient.readContract({
    address: arenaAddr,
    abi: arenaAbi,
    functionName: "USDSO",
    args: [],
  })) as unknown as `0x${string}`;

  const poolAddrs = (await Promise.all(
    (["POOL_WETH", "POOL_WBTC", "POOL_SOMI"] as const).map((fn) =>
      publicClient.readContract({ address: arenaAddr, abi: arenaAbi, functionName: fn, args: [] })
    )
  )) as unknown as `0x${string}`[];

  const balance = (await publicClient.readContract({
    address: usdsoAddr,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [wallet.account.address],
  })) as unknown as bigint;

  const required = usdsoPerPool * 3n;
  if (balance < required) {
    throw new Error(
      `Insufficient USDso: have ${formatUnits(balance, 18)}, need ${formatUnits(required, 18)}`
    );
  }

  const approveTx = await wallet.writeContract({
    address: usdsoAddr,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [arenaAddr, required],
  });
  const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveTx });
  if (approveReceipt.status === "reverted") throw new Error(`approve reverted: ${approveTx}`);
  console.log("Approved", formatUnits(required, 18), "USDso for Arena");

  const fundTx = await wallet.writeContract({
    address: arenaAddr,
    abi: arenaAbi,
    functionName: "fundPools",
    args: [usdsoPerPool],
  });
  const fundReceipt = await publicClient.waitForTransactionReceipt({ hash: fundTx });
  if (fundReceipt.status === "reverted") throw new Error(`fundPools reverted: ${fundTx}`);
  console.log("fundPools tx:", fundTx);
  console.log("Deposited", formatUnits(usdsoPerPool, 18), "USDso into each of the 3 pools");

  const spotPoolAbi = (await hre.artifacts.readArtifact("MockSpotPool")).abi;
  const poolNames = ["POOL_WETH", "POOL_WBTC", "POOL_SOMI"];
  for (let i = 0; i < poolAddrs.length; i++) {
    const bal = (await publicClient.readContract({
      address: poolAddrs[i],
      abi: spotPoolAbi,
      functionName: "getWithdrawableBalance",
      args: [arenaAddr, usdsoAddr],
    })) as unknown as bigint;
    if (bal === 0n) throw new Error(`pool ${poolAddrs[i]} not funded`);
    console.log(`${poolNames[i]} (${poolAddrs[i]}) withdrawable:`, formatUnits(bal, 18), "USDso");
  }
}

main().catch((err) => {
  console.error("fund-pools failed:", err);
  process.exitCode = 1;
});
