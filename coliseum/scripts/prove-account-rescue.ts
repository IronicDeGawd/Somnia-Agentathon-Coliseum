// prove-account-rescue — exercise `PerpAccountRegistry.rescueAccount` against the
// REAL venue, on an account that is not flat.
//
// This path has always been written and never run. It exists for the case nobody
// can arrange on demand — an account that will not flatten — so the only honest way
// to prove it is to use it on an account that simply HAS an open position, which is
// the same code with the same two hazards:
//
//   1. It must size the request by real free margin. The venue's own
//      `getWithdrawableCollateral` ignores the margin an open position still needs,
//      so asking for what it reports is refused outright and recovers NOTHING.
//   2. It must leave the position funded. Taking only the free part is what makes
//      this safe to run on a live account rather than a wrecking ball.
//
// Both are printed before and after, so the run either demonstrates them or fails
// visibly. Read-only unless SEND=1.
//
//   ACCOUNT=0x… pnpm exec hardhat run scripts/prove-account-rescue.ts --network somnia
//   ACCOUNT=0x… SEND=1 pnpm exec hardhat run scripts/prove-account-rescue.ts --network somnia
import hre from "hardhat";
import { formatUnits } from "viem";
import fs from "fs";
import path from "path";

const BANK = [
  { name: "getWithdrawableCollateral", type: "function", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "getAccountHealth", type: "function", stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }] },
  { name: "getAccountMarkets", type: "function", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "address[]" }] },
] as const;
const REG = [
  { name: "freeMarginOf", type: "function", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "floatBalance", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint256" }] },
  { name: "rescueAccount", type: "function", stateMutability: "nonpayable",
    inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const u = (v: bigint) => formatUnits(v, 18);

async function main() {
  const m = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "deployments", `${hre.network.name}.json`), "utf-8"));
  const registry = m.contracts.PerpDesks.registry as `0x${string}`;
  const bank     = m.contracts.PerpDesks.marginBank as `0x${string}`;
  const account  = (process.env.ACCOUNT ?? "") as `0x${string}`;
  if (!account) throw new Error("set ACCOUNT=0x… (see check-perps.ts for one holding a position)");

  const pub = await hre.viem.getPublicClient();
  const [wallet] = await hre.viem.getWalletClients();
  const readB = (fn: string) => pub.readContract({ address: bank, abi: BANK as any, functionName: fn, args: [account] });
  const readR = (fn: string, args: any[]) => pub.readContract({ address: registry, abi: REG as any, functionName: fn, args });

  const [equity, imReq] = await readB("getAccountHealth") as [bigint, bigint, bigint, bigint];
  // A POSITION IS OPEN WHEN INITIAL MARGIN IS RESERVED. Do not judge this off a
  // market-list getter: this venue answers that call with an empty list even while
  // it is reserving margin, so trusting it reported a live account as flat and
  // would have called a real proof "not a proof".
  const lying  = await readB("getWithdrawableCollateral") as bigint;
  const honest = await readR("freeMarginOf", [account]) as bigint;
  const floatBefore = await readR("floatBalance", []) as bigint;

  console.log(`account ${account}`);
  console.log(`  equity                    ${u(equity)}`);
  console.log(`  initial margin needed     ${u(imReq)}`);
  console.log(`  position open             ${imReq > 0n ? "yes — margin is reserved" : "no"}`);
  console.log(`  venue says withdrawable   ${u(lying)}      <- IGNORES the open position`);
  console.log(`  real free margin          ${u(honest)}      <- what the rescue may take`);
  console.log(`  float before              ${u(floatBefore)}`);

  if (imReq === 0n) {
    console.log("\n  NOT A PROOF: nothing is reserved here, so a rescue demonstrates nothing.");
    console.log("  Pick an account with a position — check-perps.ts prints which.");
  }
  if (lying > honest) {
    console.log(`\n  the gap the cap exists for: asking for ${u(lying)} would be refused, ${u(honest)} is not`);
  }

  if (process.env.SEND !== "1") {
    console.log("\n  read-only. re-run with SEND=1 to actually rescue.");
    return;
  }

  const hash = await wallet.writeContract({
    address: registry, abi: REG as any, functionName: "rescueAccount", args: [account],
    gas: BigInt(process.env.GAS ?? 3_000_000),
  });
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  console.log(`\n  tx ${hash} status=${rcpt.status} gas=${rcpt.gasUsed}`);

  const [equityAfter, imAfter] = await readB("getAccountHealth") as [bigint, bigint, bigint, bigint];
  const floatAfter = await readR("floatBalance", []) as bigint;

  console.log(`  float                     ${u(floatBefore)} -> ${u(floatAfter)}  (+${u(floatAfter - floatBefore)})`);
  console.log(`  equity                    ${u(equity)} -> ${u(equityAfter)}`);
  console.log(`  initial margin needed     ${u(imReq)} -> ${u(imAfter)}`);
  console.log(`  position open             ${imReq > 0n ? "yes" : "no"} -> ${imAfter > 0n ? "yes" : "no"}`);

  if (floatAfter > floatBefore && imAfter > 0n) {
    console.log("\n  PROVEN: collateral came back to the float and the position is still open and funded.");
  } else if (floatAfter === floatBefore) {
    console.log("\n  NOTHING RECOVERED — the cap or the venue refused. Read the reason before calling this done.");
  } else {
    console.log("\n  recovered, but the position count changed. Say so rather than reporting a clean pass.");
  }
}
main().catch(e => { console.error(e.shortMessage ?? e.message ?? e); process.exit(1); });
