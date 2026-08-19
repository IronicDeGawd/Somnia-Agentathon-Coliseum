// ============================================================================
// diag-perp-start-gas — why a perps start at the top tiers costs what it does.
//
// The matrix measured a nine- and fifteen-round perps start at 29,200,558 gas,
// four and a half times any other market's, and nothing in the market scan
// accounts for it. This estimates a start at every perps tier and at the same
// tiers on the other markets, so the jump can be attributed to a tier, to the
// market, or to neither.
//
// Reads only — every call is eth_estimateGas, nothing is sent.
//
//   pnpm exec hardhat run scripts/diag-perp-start-gas.ts --network somnia
// ============================================================================
import hre from "hardhat";
import { formatUnits } from "viem";
import fs from "fs";
import path from "path";

const man = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"),
);
const ARENA = man.contracts.Arena.address as `0x${string}`;
const REG = man.contracts.PerpDesks.registry as `0x${string}`;
const USDSO = man.external.usdso as `0x${string}`;

const TIERS = [3, 6, 9, 15];
// 0 spot, 1 practice(?), 2 events, 3 perps — only the ones a start can be
// estimated for without a live event window are probed.
const KINDS: Record<string, number> = { Perps: 3, Spot: 0 };

async function main() {
  const pub = await hre.viem.getPublicClient();
  const [wallet] = await hre.viem.getWalletClients();
  const me = wallet.account.address;

  const arena = await hre.viem.getContractAt("Arena", ARENA);
  const registry = await hre.viem.getContractAt("PerpAccountRegistry", REG);
  const usdso = await hre.viem.getContractAt("IERC20Minimal", USDSO);

  console.log(`caller ${me}`);
  console.log(`USDso ${formatUnits(await usdso.read.balanceOf([me]), 18)}`);
  console.log(`allowance ${formatUnits(await usdso.read.allowance([me, ARENA]), 18)}`);
  console.log(`free accounts ${await registry.read.freeCount()}`);
  console.log(`float ${formatUnits(await registry.read.floatBalance(), 18)}\n`);

  // What each tier's budget buys, and which markets qualify for it.
  const view = await hre.viem.getContractAt("ArenaViewPart", ARENA);
  for (const turns of TIERS) {
    try {
      const pools = (await view.read.perpMarketsFor([turns])) as string[];
      console.log(`perps ${turns}r markets: ${pools.join(" ")}`);
    } catch (e: any) {
      console.log(`perps ${turns}r markets: <${e.shortMessage ?? e.message}>`);
    }
  }
  console.log();

  for (const [name, kind] of Object.entries(KINDS)) {
    for (const turns of TIERS) {
      let out: string;
      try {
        const gas = await pub.estimateContractGas({
          address: ARENA,
          abi: arena.abi,
          functionName: "startDuelOn",
          args: [0, 1, turns, kind],
          account: me,
        });
        out = `${gas.toLocaleString()}`;
      } catch (e: any) {
        out = `<${(e.shortMessage ?? e.message ?? "").split("\n")[0]}>`;
      }
      console.log(`${name.padEnd(6)} ${String(turns).padStart(2)}r start  ${out}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
