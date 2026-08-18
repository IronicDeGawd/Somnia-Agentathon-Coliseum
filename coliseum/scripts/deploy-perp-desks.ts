// ============================================================================
// deploy-perp-desks — stand up the perpetual-futures market for Coliseum.
//
// Deploys one PerpAccountRegistry and one PerpDesk per market against the LIVE
// Arena router, pre-warms a pool of fighter accounts, registers everything with
// Arena, lends the registry a float, and records the addresses in the manifest.
//
// SIX DESKS, ONE EACH, PERMANENT. Unlike the event desks there is no rebinding:
// a perp market does not expire, so a desk is bound to its market at
// construction and the registry refuses to be re-pointed. Nothing here runs
// again per fight.
//
// TWO ACCOUNTS PER FIGHT, not six. Every desk routes to the same account for a
// given fighter, because margin is cross and pooling a fighter's own positions
// is how a trader actually works. So the pool is sized 2 x maxActiveDuels.
//
// Run:
//   pnpm exec hardhat run scripts/deploy-perp-desks.ts --network somnia
//
// Env:
//   PRIVATE_KEY  — funded testnet key; becomes owner of the registry and desks.
//   ACCOUNTS     — fighter accounts to pre-deploy (default 8 = 2 x 4 fights).
//   FLOAT        — USDso lent to the registry, whole tokens (default 200).
//                  This is the HOUSE's stake, not the players'. Fighters trade
//                  it and a liquidation costs it; the players' pot stays
//                  escrowed in Arena and comes back whole. Size it for the top
//                  tier: 18 per fighter x 2 fighters x concurrent fights, plus
//                  headroom for the spread each round trip crosses.
//   MARKETS      — comma-separated market names to include (default all six).
//   FORCE        — set to 1 to redeploy even if the manifest already has them.
//   RECOVER      — set to 1 to pull the registry's unlent float back to Arena
//                  and exit without deploying. Run this BEFORE replacing the
//                  registry, or the float is stranded in a contract nothing
//                  points at any more.
//
// AFTER THIS SCRIPT, before real fights: Matchmaker must be redeployed, because
// its market gate is a hardcoded constant and the shipped one stops at 2.
// ============================================================================

import hre from "hardhat";
import { formatUnits } from "viem";
import fs from "fs";
import path from "path";

/**
 * The six real perp markets on chain 50312, from
 * `somnia-chain/somnia-dex-protocol` → `deployments/testnet/perps-protocol.json`.
 *
 * The four SBTC* markets in that manifest are simulator markets sharing one
 * oracle. Deliberately absent: they are not real markets and a fight on one
 * would be a fight against a toy.
 */
const MARKET_ADDRESSES: Record<string, `0x${string}`> = {
  BTC: "0x3892A5179F8eA0C810c45d1630546c0317b0e5B6",
  ETH: "0x6A7224a4Ad765D6134c4F29200E67B1f6b62c29e",
  SOL: "0x4d3892D19e684677615b83ec2c912085A08472aF",
  ADA: "0x440F5a79857cd632ae45439410969C3f4049cc41",
  XRP: "0x996d36787CfC6569037039730D8cf82Ad29c8F56",
  BNB: "0x11c8d997e291A83a59D86dD2cDE7ffcb0ae66798",
};

const MARGIN_BANK = "0xdd4A14A2763FDa39b9759D2D4150DB0e0f085C4E" as `0x${string}`;

/** A label as Arena stores it: the market's name, zero-padded to eight bytes.
 *  It becomes part of the action the model answers with ("LongETH"), so it is
 *  the difference between a fighter recognising its options and seeing none. */
const label = (s: string): `0x${string}` =>
  ("0x" + Buffer.from(s, "ascii").toString("hex").padEnd(16, "0")) as `0x${string}`;

async function main() {
  const accountCount = BigInt(process.env.ACCOUNTS ?? "8");
  const floatWhole = BigInt(process.env.FLOAT ?? "200");
  const wanted = (process.env.MARKETS ?? Object.keys(MARKET_ADDRESSES).join(","))
    .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

  for (const name of wanted) {
    if (!MARKET_ADDRESSES[name]) throw new Error(`unknown market "${name}"`);
  }
  if (wanted.length < 3) {
    // Selection needs three qualifying markets to fill a fight's three slots.
    // Fewer registered means every perps fight reverts, which is worth catching
    // here rather than after the desks are deployed.
    throw new Error(`need at least 3 markets, got ${wanted.length}`);
  }

  const manifestPath = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const arena = manifest.contracts.Arena.address as `0x${string}`;
  const usdso = manifest.external.usdso as `0x${string}`;

  const pub = await hre.viem.getPublicClient();
  const [wallet] = await hre.viem.getWalletClients();
  console.log(`Deployer:   ${wallet.account.address}`);
  console.log(`Arena:      ${arena}`);
  console.log(`Collateral: ${usdso}`);

  // The perps market and Coliseum already hold the same money — the collateral
  // token in the perps manifest is byte-identical to `external.usdso` here. That
  // is what removes any need for a second token, a faucet or a treasury.
  console.log(`MarginBank: ${MARGIN_BANK}`);

  const arenaContract = await hre.viem.getContractAt("Arena", arena);
  const existing = manifest.contracts.PerpDesks;

  if (process.env.RECOVER === "1") {
    if (!existing?.registry) throw new Error("nothing to recover — no contracts.PerpDesks in the manifest");
    const reg = await hre.viem.getContractAt("PerpAccountRegistry", existing.registry as `0x${string}`);
    const free = await reg.read.floatBalance() as bigint;
    console.log(`Unlent float: ${formatUnits(free, 18)} USDso`);
    if (free === 0n) {
      console.log("Nothing to pull back.");
      return;
    }
    // Through Arena, so the seed accounting that keeps house money separate from
    // depositor money stays correct.
    const tx = await arenaContract.write.withdrawPerpFloat([free]);
    await pub.waitForTransactionReceipt({ hash: tx });
    console.log(`Pulled ${formatUnits(free, 18)} USDso back into Arena.`);
    console.log("Now use ownerWithdrawSeed to take it out of Arena.");
    return;
  }

  if (existing && process.env.FORCE !== "1") {
    throw new Error(
      "contracts.PerpDesks already exists. Set FORCE=1 to redeploy — but run " +
      "RECOVER=1 first, or the current float is stranded.",
    );
  }

  // ── The registry ─────────────────────────────────────────────────────────
  // Deployed before the desks, because each desk is bound to it at construction.
  const registry = await hre.viem.deployContract("PerpAccountRegistry", [usdso, MARGIN_BANK, arena]);
  console.log(`\nPerpAccountRegistry: ${registry.address}`);

  // ── One desk per market ──────────────────────────────────────────────────
  const desks: { name: string; desk: `0x${string}`; market: `0x${string}`; baseDecimals: number }[] = [];
  for (const name of wanted) {
    const market = MARKET_ADDRESSES[name]!;
    const desk = await hre.viem.deployContract("PerpDesk", [arena, market, registry.address, usdso]);

    // Base decimals come from the market's own `getOneBase`, never a table. A
    // hardcoded scale is the mistake EventDesk shipped with and had to be
    // redeployed to fix, and here the markets genuinely differ: Bitcoin has
    // eight base decimals where Ethereum has eighteen.
    const oneBase = await desk.read.oneBase() as bigint;
    if (oneBase === 0n) throw new Error(`${name}: desk could not read its market's base unit`);
    let baseDecimals = 0;
    for (let v = oneBase; v > 1n; v /= 10n) baseDecimals++;
    if (10n ** BigInt(baseDecimals) !== oneBase) {
      throw new Error(`${name}: base unit ${oneBase} is not a power of ten`);
    }

    console.log(`  ${name.padEnd(4)} desk ${desk.address}  market ${market}  ${baseDecimals}dp`);
    desks.push({ name, desk: desk.address as `0x${string}`, market, baseDecimals });
  }

  // ── Wire the registry, then Arena ────────────────────────────────────────
  let tx = await registry.write.registerDesks([desks.map((d) => d.desk)]);
  await pub.waitForTransactionReceipt({ hash: tx });
  console.log(`\nRegistered ${desks.length} desks with the registry (one-shot — no re-pointing).`);

  tx = await registry.write.addAccounts([accountCount]);
  await pub.waitForTransactionReceipt({ hash: tx });
  console.log(`Pre-deployed ${accountCount} fighter accounts (2 per fight).`);

  tx = await arenaContract.write.setPerpDesks([
    registry.address,
    desks.map((d) => d.desk),
    desks.map((d) => d.baseDecimals),
    desks.map((d) => label(d.name)),
  ]);
  await pub.waitForTransactionReceipt({ hash: tx });
  console.log("Registered the desks with Arena and cached their trading rules.");

  // ── Lend the float ───────────────────────────────────────────────────────
  const float = floatWhole * 10n ** 18n;
  // Any ERC-20 ABI will do for approve/balanceOf; MockERC20's is the one this
  // repo already has an artifact for.
  const token = await hre.viem.getContractAt("MockERC20", usdso);
  const held = await token.read.balanceOf([wallet.account.address]) as bigint;
  if (held < float) {
    throw new Error(`need ${formatUnits(float, 18)} USDso to lend, hold ${formatUnits(held, 18)}`);
  }
  tx = await token.write.approve([arena, float]);
  await pub.waitForTransactionReceipt({ hash: tx });
  tx = await arenaContract.write.fundPerpFloat([float]);
  await pub.waitForTransactionReceipt({ hash: tx });
  console.log(`Lent ${formatUnits(float, 18)} USDso to the registry (tracked as owner seed).`);

  // ── What the market can actually offer right now ─────────────────────────
  // Printed because the margin factor scales with open interest and moves on its
  // own, so the tier ladder is only meaningful against live numbers.
  console.log("\nMargin for one smallest position, measured now:");
  for (const d of desks) {
    const [tradable, im] = await registry.read.marketCost([d.market]) as [boolean, bigint];
    console.log(`  ${d.name.padEnd(4)} ${tradable ? formatUnits(im, 18).padStart(10) : "  untradable"}`);
  }
  console.log("\nWhat each tier would be offered right now:");
  for (const turns of [3, 6, 9, 15]) {
    const budget = await arenaContract.read.perpBudgetFor([turns]) as bigint;
    try {
      const picked = await arenaContract.read.perpMarketsFor([turns]) as string[];
      const names = picked.map((a) => desks.find((d) => d.desk.toLowerCase() === a.toLowerCase())?.name ?? "?");
      console.log(`  ${String(turns).padStart(2)} rounds, ${formatUnits(budget, 18).padStart(5)} USDso: ${names.join(" ")}`);
    } catch {
      console.log(`  ${String(turns).padStart(2)} rounds, ${formatUnits(budget, 18).padStart(5)} USDso: fewer than three markets qualify`);
    }
  }

  manifest.contracts.PerpDesks = {
    registry: registry.address,
    marginBank: MARGIN_BANK,
    accountsPreDeployed: Number(accountCount),
    floatUsdso: formatUnits(float, 18),
    desks: desks.map((d) => ({
      market: d.name, desk: d.desk, perpPool: d.market, baseDecimals: d.baseDecimals,
    })),
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\nRecorded under contracts.PerpDesks in ${path.basename(manifestPath)}`);
  console.log("\nNEXT: redeploy Matchmaker (scripts/deploy-matchmaker.ts) — its market");
  console.log("gate is a hardcoded constant and the shipped one stops at 2, so no player");
  console.log("can reach the perps queue until it is replaced.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
