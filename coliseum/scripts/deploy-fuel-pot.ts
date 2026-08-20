// ============================================================================
// deploy-fuel-pot — stand up the pot, point the Arena at it, and seed it.
//
// Order matters and is enforced below: deploy, verify it can quote the market,
// THEN point the Arena at it. Pointing first would route fees into a contract
// nobody has checked can actually buy anything.
//
//   pnpm exec hardhat run scripts/deploy-fuel-pot.ts --network somnia
//   SEED=72 to also move that much surplus out of the Arena into the pot.
// ============================================================================
import hre from "hardhat";
import { formatUnits, parseUnits, parseAbi } from "viem";
import fs from "fs";
import path from "path";

const ARENA = parseAbi([
  "function setFuelPot(address)",
  "function migrateSurplus(address,uint256)",
  "function fuelStatus() view returns (address,uint256)",
  "function accruedFees() view returns (uint256)",
  "function escrowedPot() view returns (uint256)",
  "function activeDuelId() view returns (uint256)",
]);
const POT = parseAbi([
  "function quote() view returns (uint256,uint256,uint256)",
  "function status() view returns (uint256,uint256,uint256,bool)",
  "function owner() view returns (address)",
]);
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

async function main() {
  const file = path.join(__dirname, "..", "deployments", "somnia.json");
  const m = JSON.parse(fs.readFileSync(file, "utf-8"));
  const arena = m.contracts.Arena.address as `0x${string}`;
  const usdso = m.external.usdso as `0x${string}`;
  const market = m.external.poolSomi as `0x${string}`;   // the native-base market

  const pub = await hre.viem.getPublicClient();
  const [op] = await hre.viem.getWalletClients();

  const active = await pub.readContract({ address: arena, abi: ARENA, functionName: "activeDuelId" }) as bigint;
  if (active !== BigInt(0)) { console.log(`duel ${active} is live — wait for an empty arena`); return; }

  const REDEPLOY = process.env.REDEPLOY === "1";
  const previous = (m.contracts.FuelPot?.address ?? "") as `0x${string}`;
  let pot = REDEPLOY ? ("" as `0x${string}`) : previous;
  if (!pot) {
    const art = await hre.artifacts.readArtifact("FuelPot");
    const hash = await op.deployContract({ abi: art.abi, bytecode: art.bytecode as `0x${string}`, args: [usdso, market, arena] });
    const r = await pub.waitForTransactionReceipt({ hash });
    pot = r.contractAddress!;
    console.log(`FuelPot deployed at ${pot}  (${(art.deployedBytecode.length - 2) / 2} bytes)`);
    m.contracts.FuelPot = { address: pot, stablecoin: usdso, market, arena };
    if (previous) m.contracts.FuelPotPrevious = previous;
    fs.writeFileSync(file, JSON.stringify(m, null, 2) + "\n");

    // Move the predecessor's balance across in ONE call rather than leaving it to a
    // manual sequence. Two amounts are already stranded in superseded contracts in
    // this project, both because moving money out was a checklist someone did not
    // finish. This is also the first real exercise of that path.
    if (previous) {
      const MIG = parseAbi(["function migrate(address) returns (uint256,uint256)"]);
      try {
        const mh = await op.writeContract({ address: previous, abi: MIG, functionName: "migrate", args: [pot] });
        await pub.waitForTransactionReceipt({ hash: mh });
        const left = await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [previous] }) as bigint;
        console.log(`  migrated from ${previous}; predecessor now holds ${formatUnits(left, 18)} — ${left === BigInt(0) ? "empty, as it must be" : "NOT EMPTY, investigate"}`);
      } catch (e: any) { console.log(`  migrate from predecessor failed: ${(e.shortMessage ?? e.message).split("\n")[0]}`); }
    }
  } else {
    console.log(`FuelPot already at ${pot}`);
  }

  // Can it actually see a price? A pot that cannot quote cannot refuel, and
  // pointing the Arena at one that cannot would route fees into a dead end.
  const [price, avail, step] = await pub.readContract({ address: pot, abi: POT, functionName: "quote" }) as readonly [bigint, bigint, bigint];
  console.log(`  quote: ${formatUnits(price, 18)} per coin, ${formatUnits(avail, 18)} available, step ${formatUnits(step, 18)}`);
  if (price === BigInt(0)) { console.log("  the pot cannot price the market — NOT pointing the Arena at it"); return; }

  const seed = process.env.SEED;
  if (seed) {
    const want = parseUnits(seed, 18);
    const fees = await pub.readContract({ address: arena, abi: ARENA, functionName: "accruedFees" }) as bigint;
    const esc  = await pub.readContract({ address: arena, abi: ARENA, functionName: "escrowedPot" }) as bigint;
    const bal  = await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [arena] }) as bigint;
    console.log(`\n  arena holds ${formatUnits(bal, 18)}, of which ${formatUnits(esc, 18)} is players' stakes; accrued fees ${formatUnits(fees, 18)}`);
    const h = await op.writeContract({ address: arena, abi: ARENA, functionName: "migrateSurplus", args: [pot, want] });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(`  seeded: pot now holds ${formatUnits(await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [pot] }) as bigint, 18)} stablecoin`);
  }

  // Read through the explicit view, not a generated getter: the router's compiled
  // getters are frozen, so a `public` variable added to the layout after it shipped
  // has no selector to call. Tolerated rather than assumed either way.
  let already = "0x0000000000000000000000000000000000000000" as `0x${string}`;
  try {
    const [p0] = await pub.readContract({ address: arena, abi: ARENA, functionName: "fuelStatus" }) as readonly [`0x${string}`, bigint];
    already = p0;
  } catch { console.log("  (cannot read the current pot — setting it regardless, the call is idempotent)"); }
  if (already.toLowerCase() !== pot.toLowerCase()) {
    const h = await op.writeContract({ address: arena, abi: ARENA, functionName: "setFuelPot", args: [pot] });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(`\n  Arena now routes its fee to ${pot}`);
  }

  const [arenaCoin, potStable, potCoin, wouldAct] = await pub.readContract({ address: pot, abi: POT, functionName: "status" }) as readonly [bigint, bigint, bigint, boolean];
  console.log(`\n  arena coin ${formatUnits(arenaCoin, 18)}  pot ${formatUnits(potStable, 18)} stable / ${formatUnits(potCoin, 18)} coin  would refuel: ${wouldAct}`);
}

main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exit(1); });
