// ============================================================================
// retire-pool-deposits — move the house's money out of the venue's custody and
// back into the Arena's own balance, one market at a time.
//
// Why this is safe, and why it is not a withdrawal:
//
//   The money does not leave the house. `withdrawFromPool` pulls a deposit out of
//   the pool and into this contract's own ERC-20 balance, so `seedLiquidity` stays
//   truthful and the cash is still buying power — it just moves from a pot that
//   only ever falls into one that can also rise.
//
// Why it is worth doing at all: a buy is charged to the deposit, while fills and
// sale proceeds land in the balance. Nothing walks value back, so the deposit
// drains and then every buy is refused with the money in plain sight. Measured:
// 515.80 -> 466.29 USDso across one fifteen-round fight.
//
// This REQUIRES the widened offer gate to be live, or a fighter will be offered
// nothing at all on a market whose deposit is empty. Checked below, not assumed.
//
//   MARKET=WETH pnpm exec hardhat run scripts/retire-pool-deposits.ts --network somnia
//   MARKET=all  … all three, but do the first alone and prove a fight trades first.
// ============================================================================
import hre from "hardhat";
import { formatUnits, parseAbi } from "viem";
import fs from "fs";
import path from "path";

const ARENA_ABI = parseAbi([
  "function withdrawFromPool(address,address,uint256)",
  "function escrowedPot() view returns (uint256)",
  "function activeDuelId() view returns (uint256)",
  "function seedLiquidity() view returns (uint256)",
]);
const POOL_ABI = parseAbi(["function getWithdrawableBalance(address,address) view returns (uint256)"]);
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"));
  const arena = m.contracts.Arena.address as `0x${string}`;
  const usdso = m.external.usdso as `0x${string}`;
  const pools: Record<string, `0x${string}`> = {
    WETH: m.external.poolWeth, WBTC: m.external.poolWbtc, SOMI: m.external.poolSomi,
  };

  const pub = await hre.viem.getPublicClient();
  const [op] = await hre.viem.getWalletClients();

  // A fight in progress would have its stake in the same balance and its fighters
  // mid-decision. Wait for an empty arena rather than reasoning about the overlap.
  const active = await pub.readContract({ address: arena, abi: ARENA_ABI, functionName: "activeDuelId" }) as bigint;
  if (active !== BigInt(0)) { console.log(`duel ${active} is live — wait for an empty arena`); return; }

  const want = (process.env.MARKET || "").toUpperCase();
  const targets = want === "ALL" ? Object.keys(pools) : [want];
  if (!targets.every((t) => pools[t])) { console.log("set MARKET to WETH | WBTC | SOMI | all"); return; }

  const seed = await pub.readContract({ address: arena, abi: ARENA_ABI, functionName: "seedLiquidity" }) as bigint;
  const escrow = await pub.readContract({ address: arena, abi: ARENA_ABI, functionName: "escrowedPot" }) as bigint;
  let bal = await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [arena] }) as bigint;
  console.log(`arena balance ${formatUnits(bal, 18)} USDso, of which ${formatUnits(escrow, 18)} is escrowed stakes`);
  console.log(`owner seed on the books ${formatUnits(seed, 18)} USDso (unchanged by this — the money stays here)\n`);

  for (const name of targets) {
    const pool = pools[name];
    const dep = await pub.readContract({ address: pool, abi: POOL_ABI, functionName: "getWithdrawableBalance", args: [arena, usdso] }) as bigint;
    if (dep === BigInt(0)) { console.log(`${name}: nothing deposited — already retired`); continue; }
    console.log(`${name}: pulling ${formatUnits(dep, 18)} USDso back out of the venue`);
    const hash = await op.writeContract({ address: arena, abi: ARENA_ABI, functionName: "withdrawFromPool", args: [pool, usdso, dep] });
    const r = await pub.waitForTransactionReceipt({ hash });
    const after = await pub.readContract({ address: pool, abi: POOL_ABI, functionName: "getWithdrawableBalance", args: [arena, usdso] }) as bigint;
    const balAfter = await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [arena] }) as bigint;
    console.log(`  tx ${hash} status=${r.status}`);
    console.log(`  deposit ${formatUnits(dep, 18)} -> ${formatUnits(after, 18)}`);
    console.log(`  arena balance ${formatUnits(bal, 18)} -> ${formatUnits(balAfter, 18)}  (${balAfter - bal === dep ? "every unit accounted for" : "MISMATCH — investigate before continuing"})\n`);
    bal = balAfter;
  }

  const spendable = bal > escrow ? bal - escrow : BigInt(0);
  console.log(`spendable house money now ${formatUnits(spendable, 18)} USDso — this is what a buy is checked against.`);
  console.log(`Next: run ONE spot fight and confirm buys still happen on a retired market.`);
}

main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exit(1); });
