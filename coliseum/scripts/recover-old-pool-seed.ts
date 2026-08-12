/**
 * recover-old-pool-seed.ts
 * ------------------------
 * Pulls the seeded USDso liquidity back out of the superseded Arena.
 *
 * The seed is not held by the Arena directly — it sits in each pool's vault,
 * credited to the Arena address, so a plain ERC20 sweep cannot see it. Two hops
 * are needed:
 *
 *   1. withdrawFromPool(pool, USDso, amount)  — pool vault  -> Arena balance
 *   2. ownerWithdrawSeed(to, amount)          — Arena balance -> owner
 *
 * `sweepToken` deliberately reverts on USDso (it would let the owner take user
 * deposits), so ownerWithdrawSeed is the only exit, and it is capped at the
 * contract's own `seedLiquidity` accounting.
 *
 * SAFETY: the Arena's USDso balance also backs `escrowedPot` — players' duel
 * deposits, still claimable through recoverFunds. Every withdrawal here is
 * clamped so the remaining balance can never fall below that figure.
 *
 * Run:
 *   pnpm exec hardhat run scripts/recover-old-pool-seed.ts --network somnia
 *   DRY_RUN=1 ... to report without moving anything
 *   ARENA=0x.. to target a different Arena (defaults to the superseded one)
 */
import hre from "hardhat";
import { formatEther, parseAbi, getAddress } from "viem";

const DEFAULT_OLD_ARENA = "0x8813fef83ae3faa8d700c6fbcb8cf92de08ea726";
const USDSO = getAddress("0x9c32F3827A1a99f0cf9B213de8b53eC3d57bb171");

const ARENA_ABI = parseAbi([
  "function owner() view returns (address)",
  "function activeDuelId() view returns (uint256)",
  "function seedLiquidity() view returns (uint256)",
  "function escrowedPot() view returns (uint256)",
  "function simPoolsSet() view returns (bool)",
  "function POOL_WETH() view returns (address)",
  "function POOL_WBTC() view returns (address)",
  "function POOL_SOMI() view returns (address)",
  "function SIM_POOL_WETH() view returns (address)",
  "function SIM_POOL_WBTC() view returns (address)",
  "function SIM_POOL_SOMI() view returns (address)",
  "function withdrawFromPool(address pool, address token, uint256 amount) external",
  "function ownerWithdrawSeed(address to, uint256 amount) external",
]);
const POOL_ABI  = parseAbi(["function getWithdrawableBalance(address,address) view returns (uint256)"]);
const ERC20     = parseAbi(["function balanceOf(address) view returns (uint256)"]);

async function main() {
  const dry = !!process.env.DRY_RUN;
  const arena = getAddress(process.env.ARENA ?? DEFAULT_OLD_ARENA);
  const pub = await hre.viem.getPublicClient();
  const [wallet] = await hre.viem.getWalletClients();
  const me = getAddress(wallet.account.address);

  console.log(`\nRecovering pool seed from ${arena}${dry ? "  (DRY RUN)" : ""}`);

  const read = <T,>(functionName: string, args: unknown[] = []) =>
    pub.readContract({ address: arena, abi: ARENA_ABI, functionName, args } as never) as Promise<T>;

  const owner = getAddress(await read<`0x${string}`>("owner"));
  if (owner !== me) throw new Error(`not owner (owner=${owner}, signer=${me})`);
  const active = await read<bigint>("activeDuelId");
  if (active !== 0n) throw new Error(`duel ${active} still in flight — refusing to withdraw pool funds`);

  const simSet = await read<boolean>("simPoolsSet");
  const pools: { name: string; addr: `0x${string}` }[] = [
    { name: "WETH", addr: await read<`0x${string}`>("POOL_WETH") },
    { name: "WBTC", addr: await read<`0x${string}`>("POOL_WBTC") },
    { name: "SOMI", addr: await read<`0x${string}`>("POOL_SOMI") },
  ];
  if (simSet) {
    pools.push(
      { name: "simWETH", addr: await read<`0x${string}`>("SIM_POOL_WETH") },
      { name: "simWBTC", addr: await read<`0x${string}`>("SIM_POOL_WBTC") },
      { name: "simSOMI", addr: await read<`0x${string}`>("SIM_POOL_SOMI") },
    );
  }

  // ── 1. Pool vaults -> Arena balance ──────────────────────────────────────
  let pulled = 0n;
  for (const p of pools) {
    const bal = (await pub.readContract({
      address: p.addr, abi: POOL_ABI, functionName: "getWithdrawableBalance", args: [arena, USDSO],
    })) as bigint;
    if (bal === 0n) { console.log(`  ${p.name.padEnd(8)} empty`); continue; }
    console.log(`  ${p.name.padEnd(8)} withdrawFromPool ${formatEther(bal)} USDso`);
    if (dry) { pulled += bal; continue; }
    try {
      const hash = await wallet.writeContract({
        address: arena, abi: ARENA_ABI, functionName: "withdrawFromPool", args: [p.addr, USDSO, bal],
      });
      const r = await pub.waitForTransactionReceipt({ hash });
      console.log(`           ${r.status}  tx=${hash}`);
      if (r.status === "success") pulled += bal;
    } catch (e: unknown) {
      const m = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
      console.log(`           FAILED: ${m}`);
    }
  }
  console.log(`pulled from pools: ${formatEther(pulled)} USDso`);

  // ── 2. Arena balance -> owner, never dipping into escrow ─────────────────
  const held   = (await pub.readContract({ address: USDSO, abi: ERC20, functionName: "balanceOf", args: [arena] })) as bigint;
  const escrow = await read<bigint>("escrowedPot");
  const seed   = await read<bigint>("seedLiquidity");
  const spare  = held > escrow ? held - escrow : 0n;
  const amount = seed < spare ? seed : spare;   // capped by BOTH the seed accounting and escrow safety

  console.log(
    `\nArena holds ${formatEther(held)} USDso; escrow ${formatEther(escrow)} must stay; ` +
    `seedLiquidity ${formatEther(seed)}`,
  );
  if (amount === 0n) { console.log("nothing withdrawable"); return; }
  console.log(`ownerWithdrawSeed -> ${formatEther(amount)} USDso`);

  if (!dry) {
    const hash = await wallet.writeContract({
      address: arena, abi: ARENA_ABI, functionName: "ownerWithdrawSeed", args: [me, amount],
    });
    const r = await pub.waitForTransactionReceipt({ hash });
    console.log(`  ${r.status}  tx=${hash}`);
  }

  const after = (await pub.readContract({ address: USDSO, abi: ERC20, functionName: "balanceOf", args: [arena] })) as bigint;
  console.log(`\nArena USDso left: ${formatEther(after)} (escrow ${formatEther(escrow)} preserved)`);
  console.log(`Deployer USDso  : ${formatEther((await pub.readContract({ address: USDSO, abi: ERC20, functionName: "balanceOf", args: [me] })) as bigint)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
