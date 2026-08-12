/**
 * sweep-old-deployment.ts
 * -----------------------
 * Recovers what can be recovered from the superseded Arena/Bookmaker after the
 * migration, and reports what cannot.
 *
 * What it takes:
 *   - Arena accrued platform fees      (withdrawFees)
 *   - Arena native STT                 (withdrawNative)
 *   - Bookmaker native STT             (withdrawNative)
 *
 * What it deliberately leaves:
 *   - Arena escrowedPot — this is players' duel deposits, still claimable via
 *     recoverFunds. Sweeping it would take user money. `sweepToken` reverts on
 *     USDso for exactly this reason, so escrow is safe by construction.
 *   - Matchmaker USDso — unclaimed winnings belonging to players.
 *   - Arena pool-vault USDso — the old Arena predates `withdrawFromPool`, so
 *     seeded pool liquidity is permanently stranded. This is the loss the
 *     "REDEPLOY REQUIRED" note at the top of deploy.ts warned about.
 *
 * Refuses to run if the old Arena still has a duel in flight.
 *
 * Run:
 *   pnpm exec hardhat run scripts/sweep-old-deployment.ts --network somnia
 *   DRY_RUN=1 ... to report without moving anything
 */
import hre from "hardhat";
import { formatEther, parseAbi, getAddress } from "viem";

// Defaults are the first superseded generation. Override per migration:
//   OLD_ARENA=0x.. OLD_BOOK=0x.. OLD_MM=0x.. pnpm exec hardhat run ...
const OLD_ARENA = getAddress(process.env.OLD_ARENA ?? "0x8813fef83ae3faa8d700c6fbcb8cf92de08ea726");
const OLD_BOOK  = getAddress(process.env.OLD_BOOK  ?? "0x323cf312d93a5cbe575d30ef4d39a56ac362ece3");
const OLD_MM    = getAddress(process.env.OLD_MM    ?? "0xadfc07d9e36622476860f8d27ba0a08e33e592e0");
const USDSO     = getAddress("0x9c32F3827A1a99f0cf9B213de8b53eC3d57bb171");

const ARENA_ABI = parseAbi([
  "function owner() view returns (address)",
  "function activeDuelId() view returns (uint256)",
  "function escrowedPot() view returns (uint256)",
  "function accruedFees() view returns (uint256)",
  "function withdrawFees(address to) external",
  "function withdrawNative(address to, uint256 amount) external",
]);
const NATIVE_ABI = parseAbi([
  "function owner() view returns (address)",
  "function withdrawNative(address to, uint256 amount) external",
]);
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

async function main() {
  const dry = !!process.env.DRY_RUN;
  const pub = await hre.viem.getPublicClient();
  const [wallet] = await hre.viem.getWalletClients();
  const me = getAddress(wallet.account.address);
  console.log(`\nSweeping superseded deployment${dry ? "  (DRY RUN)" : ""}`);
  console.log(`Recipient: ${me}\n`);

  const send = async (label: string, hash: `0x${string}`) => {
    const r = await pub.waitForTransactionReceipt({ hash });
    console.log(`  ${label}: ${r.status}  tx=${hash}`);
  };

  // ── Guard: nothing in flight ─────────────────────────────────────────────
  const active = await pub.readContract({ address: OLD_ARENA, abi: ARENA_ABI, functionName: "activeDuelId" });
  if (active !== 0n) throw new Error(`old Arena still has duel ${active} in flight — refusing to sweep`);
  const owner = await pub.readContract({ address: OLD_ARENA, abi: ARENA_ABI, functionName: "owner" });
  if (getAddress(owner) !== me) throw new Error(`not old Arena owner (owner=${owner})`);

  // ── Arena: fees ──────────────────────────────────────────────────────────
  const fees   = await pub.readContract({ address: OLD_ARENA, abi: ARENA_ABI, functionName: "accruedFees" });
  const escrow = await pub.readContract({ address: OLD_ARENA, abi: ARENA_ABI, functionName: "escrowedPot" });
  const held   = await pub.readContract({ address: USDSO, abi: ERC20, functionName: "balanceOf", args: [OLD_ARENA] });
  console.log(`old Arena USDso held ${formatEther(held)} = fees ${formatEther(fees)} + escrow ${formatEther(escrow)} + ${formatEther(held - fees - escrow)} other`);

  if (fees > 0n) {
    console.log(`withdrawFees -> ${formatEther(fees)} USDso`);
    if (!dry) await send("withdrawFees", await wallet.writeContract({ address: OLD_ARENA, abi: ARENA_ABI, functionName: "withdrawFees", args: [me] }));
  } else {
    console.log("withdrawFees: nothing accrued");
  }

  // ── Native STT from Arena and Bookmaker ──────────────────────────────────
  for (const [label, addr, abi] of [["Arena", OLD_ARENA, ARENA_ABI], ["Bookmaker", OLD_BOOK, NATIVE_ABI]] as const) {
    const bal = await pub.getBalance({ address: addr });
    // Leave a wei-dust margin rather than fight rounding; take the whole balance.
    if (bal === 0n) { console.log(`${label} STT: empty`); continue; }
    console.log(`${label} withdrawNative -> ${formatEther(bal)} STT`);
    if (dry) continue;
    try {
      await send(`${label} withdrawNative`, await wallet.writeContract({ address: addr, abi: abi as never, functionName: "withdrawNative", args: [me, bal] }));
    } catch (e: unknown) {
      const m = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
      console.log(`  ${label} withdrawNative FAILED: ${m}`);
    }
  }

  // ── Report what stays behind ─────────────────────────────────────────────
  const mmUsdso = await pub.readContract({ address: USDSO, abi: ERC20, functionName: "balanceOf", args: [OLD_MM] });
  const stillEscrow = await pub.readContract({ address: OLD_ARENA, abi: ARENA_ABI, functionName: "escrowedPot" });
  console.log("\nLeft behind on purpose:");
  console.log(`  Arena escrowedPot   ${formatEther(stillEscrow)} USDso — players' deposits, claimable via recoverFunds`);
  console.log(`  Matchmaker balance  ${formatEther(mmUsdso)} USDso — unclaimed player winnings`);
  console.log("  Arena pool vaults   stranded — this Arena predates withdrawFromPool");

  console.log(`\nDeployer now: ${formatEther(await pub.getBalance({ address: me }))} STT, ` +
    `${formatEther(await pub.readContract({ address: USDSO, abi: ERC20, functionName: "balanceOf", args: [me] }))} USDso`);
}

main().catch((e) => { console.error(e); process.exit(1); });
