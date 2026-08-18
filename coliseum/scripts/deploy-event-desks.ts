// ============================================================================
// deploy-event-desks — stand up the money plumbing for event-contract fights.
//
// Deploys one EventTreasury and six EventDesks against the LIVE Arena router,
// funds every desk, and records the addresses in the deployment manifest.
//
// Six desks = two event slots per fight x three concurrent fights, the Arena's
// maxActiveDuels. Desks are permanent and re-bindable; nothing here runs again
// per fight. Binding a desk to a market window is scripts/bind-event-window.ts.
//
// Run:
//   pnpm exec hardhat run scripts/deploy-event-desks.ts --network somnia
//
// Env:
//   PRIVATE_KEY   — funded testnet key; becomes owner of the treasury and desks.
//   DESKS         — how many desks to deploy (default 6).
//   FUND_EACH     — collateral per desk at bind time, whole tokens (default 50).
//   FORCE         — set to 1 to redeploy even if the manifest already has desks.
//   REUSE_TREASURY— set to 1 to redeploy ONLY the desks, keeping the existing
//                  EventTreasury. This is the right mode when EventDesk's code
//                  changed and the treasury's did not: a fresh treasury would
//                  leave the old one holding collateral nobody watches, and the
//                  treasury is where the faucet balance lives. Recover each old
//                  desk's vault first — see RECOVER below.
//   RECOVER       — set to 1 to pull every existing desk's vault balance back to
//                  the owner and exit, without deploying anything. Run this
//                  BEFORE replacing desks, or their collateral is stranded in
//                  pools nobody is watching any more.
// ============================================================================

import hre from "hardhat";
import { formatUnits, parseAbiItem } from "viem";
import fs from "fs";
import path from "path";

// Where settled positions are claimed. Not the trading pool — a separate
// registry that identifies a market by an id only the creation log carries.
const MODULE = "0x3ecC694Cef705358864a646142ac17A90E29e388" as `0x${string}`;

// The contract that publishes MarketCreated for the venue we trade. Every log
// query below is pinned to it: a query with only an event shape matches that
// event from ANY contract on the chain, which is how a desk ends up bound to
// another operator's market — or funded with a token nobody here holds.
const FACTORY = (process.env.FACTORY ?? "0x94d963b6670ab96e78c8d0c46ca35d196d606efe") as `0x${string}`;

const MARKET_CREATED = parseAbiItem(
  "event MarketCreated(bytes32 indexed marketId, address indexed market, address indexed pool, uint256 yesId, uint256 noId, address collateral, string asset, uint256 strike, uint64 tradingStart, uint64 expiry, uint256 oracleQuestionId, string question, uint64 intervalSec)",
);

async function main() {
  const deskCount = Number(process.env.DESKS ?? "6");
  const fundEach = BigInt(process.env.FUND_EACH ?? "50") * 10n ** 6n;

  const manifestPath = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const arena = manifest.contracts.Arena.address as `0x${string}`;

  const pub = await hre.viem.getPublicClient();
  const [wallet] = await hre.viem.getWalletClients();
  console.log(`Deployer: ${wallet.account.address}`);
  console.log(`Arena:    ${arena}`);

  const existing = manifest.contracts.EventDesks;

  // ── RECOVER: empty the outgoing desks before they are replaced ─────────────
  if (process.env.RECOVER === "1") {
    if (!existing) throw new Error("nothing to recover — no contracts.EventDesks in the manifest");
    let pulled = 0n;
    for (const addr of existing.desks as `0x${string}`[]) {
      const desk = await hre.viem.getContractAt("EventDesk", addr);
      let held18 = 0n;
      try { held18 = (await desk.read.getWithdrawableBalance([arena, existing.collateral])) as bigint; }
      catch { console.log(`  ${addr}: unbound, nothing in a vault`); continue; }
      if (held18 === 0n) { console.log(`  ${addr}: empty`); continue; }
      // withdraw() takes the 18-decimal face and sends the collateral to owner.
      const hash = await desk.write.withdraw([existing.collateral, held18]);
      await pub.waitForTransactionReceipt({ hash });
      pulled += held18;
      console.log(`  ${addr}: recovered ${formatUnits(held18, 18)}`);
    }
    console.log(`\nRecovered ${formatUnits(pulled, 18)} collateral to ${wallet.account.address}.`);
    console.log(`Send it to the treasury (${existing.treasury}) before redeploying desks.`);
    return;
  }

  // Guard the DEPLOY path only — RECOVER above has to work on an existing set.
  if (existing && process.env.FORCE !== "1") {
    console.log("Manifest already has EventDesks. Set FORCE=1 to redeploy.");
    console.log(JSON.stringify(existing, null, 2));
    return;
  }

  // The collateral address is read off a real market rather than typed in, so a
  // mistyped checksum cannot silently point the treasury at the wrong token.
  const reuse = process.env.REUSE_TREASURY === "1";
  if (reuse && !existing?.treasury) {
    throw new Error("REUSE_TREASURY=1 but the manifest has no EventDesks.treasury to reuse");
  }

  const collateral = reuse
    ? (existing.collateral as `0x${string}`)
    : await discoverCollateral(pub);
  console.log(`Collateral: ${collateral}${reuse ? " (from the manifest)" : " (from a live market)"}`);

  const treasury = reuse
    ? await hre.viem.getContractAt("EventTreasury", existing.treasury as `0x${string}`)
    : await hre.viem.deployContract("EventTreasury", [collateral]);
  console.log(`\nEventTreasury: ${treasury.address}${reuse ? " (kept)" : " (new)"}`);

  const desks: `0x${string}`[] = [];
  for (let i = 0; i < deskCount; i++) {
    const desk = await hre.viem.deployContract("EventDesk", [arena, MODULE]);
    desks.push(desk.address);
    console.log(`EventDesk[${i}]: ${desk.address}`);
  }

  console.log(`\nApproving desks on the treasury...`);
  for (const desk of desks) {
    const hash = await treasury.write.approveDesk([desk, true]);
    await pub.waitForTransactionReceipt({ hash });
  }

  // Enough for every desk, plus headroom for the top-ups that follow each bind.
  // A reused treasury usually has plenty already, so only top up the shortfall.
  const want = fundEach * BigInt(desks.length) * 2n;
  const have = (await treasury.read.balance()) as bigint;
  if (have < want) {
    console.log(`Refilling treasury with ${formatUnits(want - have, 6)} from the faucet...`);
    const refill = await treasury.write.refill([want - have]);
    await pub.waitForTransactionReceipt({ hash: refill });
  } else {
    console.log(`Treasury already holds ${formatUnits(have, 6)} — no refill needed.`);
  }
  console.log(`Treasury balance: ${formatUnits((await treasury.read.balance()) as bigint, 6)}`);

  // Desks are NOT funded here. `fund` puts collateral into the bound market's
  // vault, and an unbound desk has no vault to put it in — so funding happens
  // in bind-event-window.ts, right after the desk is pointed at a window.
  manifest.contracts.EventDesks = {
    ...(reuse ? existing : {}),
    treasury: treasury.address,
    collateral,
    module: MODULE,
    factory: FACTORY,
    desks,
    // Keep a record of what was replaced. An abandoned desk with collateral in a
    // pool vault is value nobody is watching, so this is the list to check.
    previousDesks: existing?.desks ?? [],
    // Bindings belong to the old desks; the binder rewrites this on its next run.
    bound: [],
    fundEach: fundEach.toString(),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\nRecorded under contracts.EventDesks in ${path.basename(manifestPath)}`);
}

/// Read the collateral token off the most recent market creation BY OUR VENUE. The
/// indexer is unreliable, so this walks the logs backwards the same way
/// probe-event-desk does — pinned to the factory, because "the most recent market
/// on the chain" could belong to anyone and would point the treasury at the wrong
/// token, which is worse than a typo since it looks deliberate.
async function discoverCollateral(pub: any): Promise<`0x${string}`> {
  const head = await pub.getBlockNumber();
  for (let i = 0; i < 40; i++) {
    const to = head - BigInt(i * 1000);
    try {
      const logs = await pub.getLogs({ address: FACTORY, event: MARKET_CREATED, fromBlock: to - 999n, toBlock: to });
      if (logs.length) return logs[logs.length - 1].args.collateral as `0x${string}`;
    } catch { /* range unavailable */ }
  }
  throw new Error("no MarketCreated log found in the last 40k blocks — cannot discover collateral");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
