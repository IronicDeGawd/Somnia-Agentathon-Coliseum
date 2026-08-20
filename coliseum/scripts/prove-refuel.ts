// ============================================================================
// prove-refuel — make the pot actually buy, once, and check the coin arrives.
//
// The pot refuses to act while the Arena is above its floor, which is correct and
// also means the happy path is never exercised in normal operation until the day
// it matters. So: raise the floor above where the Arena already is, call refuel,
// watch the balances, put the floor back.
//
//   pnpm exec hardhat run scripts/prove-refuel.ts --network somnia
// ============================================================================
import hre from "hardhat";
import { formatUnits, parseEther, parseAbi } from "viem";
import fs from "fs";
import path from "path";

const POT = parseAbi([
  "function refuel() returns (uint256)",
  "function setBand(uint256,uint256)",
  "function status() view returns (uint256,uint256,uint256,bool)",
  "function quote() view returns (uint256,uint256,uint256)",
  "function floorCoin() view returns (uint256)",
  "function targetCoin() view returns (uint256)",
]);
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"));
  const pot = m.contracts.FuelPot.address as `0x${string}`;
  const arena = m.contracts.Arena.address as `0x${string}`;
  const usdso = m.external.usdso as `0x${string}`;
  const pub = await hre.viem.getPublicClient();
  const [op] = await hre.viem.getWalletClients();

  const floor0 = await pub.readContract({ address: pot, abi: POT, functionName: "floorCoin" }) as bigint;
  const target0 = await pub.readContract({ address: pot, abi: POT, functionName: "targetCoin" }) as bigint;
  const arenaCoin0 = await pub.getBalance({ address: arena });
  const potStable0 = await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [pot] }) as bigint;
  console.log(`arena coin ${formatUnits(arenaCoin0, 18)}, pot ${formatUnits(potStable0, 18)} stable`);
  console.log(`band is ${formatUnits(floor0, 18)} .. ${formatUnits(target0, 18)} — the arena is above it, so nothing would happen\n`);

  // A band just above where the Arena already sits, so one small purchase is due.
  const floor = arenaCoin0 + parseEther("5");
  const target = arenaCoin0 + parseEther("8");
  let h = await op.writeContract({ address: pot, abi: POT, functionName: "setBand", args: [floor, target] });
  await pub.waitForTransactionReceipt({ hash: h });
  console.log(`band moved to ${formatUnits(floor, 18)} .. ${formatUnits(target, 18)} — a purchase of about 8 coin is now due`);

  // A generous explicit limit. The pot now refuses below its floor rather than
  // half-trying, but the estimator still cannot see past a catch, so the caller
  // supplies the room rather than hoping an estimate does.
  h = await op.writeContract({ address: pot, abi: POT, functionName: "refuel", gas: BigInt(process.env.GAS ?? 12_000_000) });
  const r = await pub.waitForTransactionReceipt({ hash: h });
  console.log(`  tx ${h} status=${r.status} gas=${r.gasUsed} logs=${r.logs.length}`);

  const arenaCoin1 = await pub.getBalance({ address: arena });
  const potStable1 = await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [pot] }) as bigint;
  console.log(`\n  arena coin  ${formatUnits(arenaCoin0, 18)} -> ${formatUnits(arenaCoin1, 18)}`);
  console.log(`  pot stable  ${formatUnits(potStable0, 18)} -> ${formatUnits(potStable1, 18)}`);
  console.log(`  ${arenaCoin1 > arenaCoin0 && potStable1 < potStable0
    ? "IT WORKS: fee revenue became fuel and reached the arena, with no operator wallet involved."
    : "nothing moved — read the skip reason in the logs above"}`);

  // Put the band back, so the pot returns to only acting when the arena is genuinely low.
  h = await op.writeContract({ address: pot, abi: POT, functionName: "setBand", args: [floor0, target0] });
  await pub.waitForTransactionReceipt({ hash: h });
  console.log(`  band restored to ${formatUnits(floor0, 18)} .. ${formatUnits(target0, 18)}`);
}

main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exit(1); });
