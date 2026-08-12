/**
 * seed-new-arena.ts
 * -----------------
 * Configures the simulated pools on a freshly deployed Arena and seeds both pool
 * sets with USDso.
 *
 * Why this matters: a fighter's buy is only sized if the Arena's own vault
 * balance in that pool covers one lot at the mark. An unseeded Arena therefore
 * offers no Buy at all, every fighter can only Hold, and — since both fighters
 * start with identical deposits — every duel ends exactly level and resolves as
 * a draw. An unseeded Arena does not fail loudly; it quietly plays no game.
 *
 * Sim pools must be set before they can be funded: they are not constructor
 * arguments, and `_requireValidPool` rejects them until `setSimPools` caches
 * their metadata.
 *
 * Run:
 *   REAL_PER_POOL=15 SIM_PER_POOL=10 \
 *     pnpm exec hardhat run scripts/seed-new-arena.ts --network somnia
 *   DRY_RUN=1 ... to report without moving anything
 */
import hre from "hardhat";
import { parseEther, formatEther, parseAbi, getAddress } from "viem";
import fs from "fs";
import path from "path";

const ARENA_ABI = parseAbi([
  "function owner() view returns (address)",
  "function simPoolsSet() view returns (bool)",
  "function seedLiquidity() view returns (uint256)",
  "function setSimPools(address weth, address wbtc, address somi, uint8[3] baseDecimals) external",
  "function fundPools(uint256 usdsoPerPool) external",
  "function fundSimPools(uint256 usdsoPerPool) external",
]);
const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
]);
const POOL_ABI = parseAbi(["function getWithdrawableBalance(address,address) view returns (uint256)"]);

async function main() {
  const dry = !!process.env.DRY_RUN;
  const realPer = parseEther(process.env.REAL_PER_POOL ?? "15");
  const simPer  = parseEther(process.env.SIM_PER_POOL ?? "10");

  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf8"),
  );
  const arena = getAddress(manifest.contracts.Arena.address);
  const usdso = getAddress(manifest.external.usdso);
  const ext = manifest.external;

  const pub = await hre.viem.getPublicClient();
  const [wallet] = await hre.viem.getWalletClients();
  const me = getAddress(wallet.account.address);

  console.log(`\nSeeding Arena ${arena}${dry ? "  (DRY RUN)" : ""}`);
  const owner = getAddress((await pub.readContract({ address: arena, abi: ARENA_ABI, functionName: "owner" })) as `0x${string}`);
  if (owner !== me) throw new Error(`not Arena owner (owner=${owner})`);

  const need = realPer * 3n + simPer * 3n;
  const bal = (await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [me] })) as bigint;
  console.log(`real ${formatEther(realPer)} x3 + sim ${formatEther(simPer)} x3 = ${formatEther(need)} USDso; wallet holds ${formatEther(bal)}`);
  if (bal < need) throw new Error(`insufficient USDso: need ${formatEther(need)}, have ${formatEther(bal)}`);

  const send = async (label: string, hash: `0x${string}`) => {
    const r = await pub.waitForTransactionReceipt({ hash });
    console.log(`  ${label}: ${r.status}  tx=${hash}`);
    if (r.status !== "success") throw new Error(`${label} reverted`);
  };

  // ── 1. Register the simulated pools ──────────────────────────────────────
  const simSet = (await pub.readContract({ address: arena, abi: ARENA_ABI, functionName: "simPoolsSet" })) as boolean;
  if (simSet) {
    console.log("setSimPools: already configured");
  } else {
    console.log(`setSimPools(${ext.simPoolWeth}, ${ext.simPoolWbtc}, ${ext.simPoolSomi})`);
    // The simulated pools are all 18-decimal, unlike real WBTC at 8.
    if (!dry) await send("setSimPools", await wallet.writeContract({
      address: arena, abi: ARENA_ABI, functionName: "setSimPools",
      args: [getAddress(ext.simPoolWeth), getAddress(ext.simPoolWbtc), getAddress(ext.simPoolSomi), [18, 18, 18]],
    }));
  }

  // ── 2. Approve once for the whole seeding ────────────────────────────────
  if (!dry) {
    const allowance = (await pub.readContract({ address: usdso, abi: ERC20, functionName: "allowance", args: [me, arena] })) as bigint;
    if (allowance < need) {
      await send("approve", await wallet.writeContract({ address: usdso, abi: ERC20, functionName: "approve", args: [arena, need] }));
    } else {
      console.log("approve: allowance already sufficient");
    }
  }

  // ── 3. Fund both pool sets ───────────────────────────────────────────────
  console.log(`fundPools(${formatEther(realPer)}) -> ${formatEther(realPer * 3n)} USDso`);
  if (!dry) await send("fundPools", await wallet.writeContract({ address: arena, abi: ARENA_ABI, functionName: "fundPools", args: [realPer] }));

  console.log(`fundSimPools(${formatEther(simPer)}) -> ${formatEther(simPer * 3n)} USDso`);
  if (!dry) await send("fundSimPools", await wallet.writeContract({ address: arena, abi: ARENA_ABI, functionName: "fundSimPools", args: [simPer] }));

  if (dry) return;

  // ── 4. Verify the vaults actually hold it ────────────────────────────────
  console.log("\nvault balances credited to the Arena:");
  const pools: [string, string][] = [
    ["WETH", ext.poolWeth], ["WBTC", ext.poolWbtc], ["SOMI", ext.poolSomi],
    ["simWETH", ext.simPoolWeth], ["simWBTC", ext.simPoolWbtc], ["simSOMI", ext.simPoolSomi],
  ];
  let total = 0n;
  for (const [name, addr] of pools) {
    const v = (await pub.readContract({
      address: getAddress(addr), abi: POOL_ABI, functionName: "getWithdrawableBalance", args: [arena, usdso],
    }).catch(() => 0n)) as bigint;
    total += v;
    console.log(`  ${name.padEnd(8)} ${formatEther(v)} USDso`);
  }
  console.log(`  total    ${formatEther(total)}`);
  console.log(`\nseedLiquidity: ${formatEther((await pub.readContract({ address: arena, abi: ARENA_ABI, functionName: "seedLiquidity" })) as bigint)} USDso`);
  console.log(`deployer USDso left: ${formatEther((await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [me] })) as bigint)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
