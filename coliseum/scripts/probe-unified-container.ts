// ============================================================================
// probe-unified-container — acceptance test for the real trading container
//
// The one-engine design says: give each fighter a container that holds money,
// places its own orders, and receives its own fills, and the whole class of
// two-pot accounting faults disappears. Three things had to be true for that,
// proved earlier against the throwaway `contracts/probe/AccountProbe.sol`:
//
//   1. a CONTRACT can buy on a spot venue and keep the fill
//   2. the same contract can sell it back out of its own balance
//   3. the same contract can sell the market whose asset is the chain's own
//      coin — the trade the game cannot make today — by sending value
//
// `contracts/trading/TradingContainer.sol` is that same idea made safe to
// actually deploy: same order-encoding trick, but the probe's `exec` escape
// hatch — an owner-callable arbitrary call — is gone entirely. Every stage
// that used to reach through `exec` now goes through a dedicated entry point
// instead (`trade`, `fundMargin`, `settle`, `recoverToken`/`recoverNative`).
//
// Target which container with IMPL:
//   IMPL=container (default)  drive contracts/trading/TradingContainer.sol
//   IMPL=probe                drive contracts/probe/AccountProbe.sol — the
//                              reference the five original answers were
//                              recorded against; kept alive on purpose
//
// Stages (STAGE=):
//   deploy     … deploy the container for the selected IMPL, report its address
//   buy        CONTAINER=0x… buy the smallest WETH lot
//   sell       CONTAINER=0x… sell it straight back
//   native     CONTAINER=0x… sell the native-base market
//   settle     CONTAINER=0x… settle (sell) the WHOLE held balance — ASSET=base|native
//   events     report whether the events desk speaks the same shape
//   perp       CONTAINER=0x… fund margin and open a perp position
//   perpclose  CONTAINER=0x… close the perp position (margin withdrawal is
//              not exercised for IMPL=container — see notes at that stage)
//   recover    CONTAINER=0x… take everything back out
//
// SAFETY: running this with no STAGE prints usage and sends nothing. Every
// stage that would send a transaction prints exactly what it would do —
// venue, asset, amounts, value — and refuses to send anything unless CONFIRM=1
// is also set. Read-only stages (events, and the read half of perpclose/recover
// when there is nothing to move) run freely.
// ============================================================================
import hre from "hardhat";
import { formatUnits, parseUnits, parseAbi, decodeEventLog } from "viem";
import fs from "fs";
import path from "path";

const KNOWN_STAGES = ["deploy", "buy", "sell", "native", "settle", "events", "perp", "perpclose", "recover"];

const PROBE_ABI = parseAbi([
  "function trade(address,bool,uint64,uint256,uint256,uint64,uint8,uint256) returns (bool,uint128)",
  "function approveToken(address,address,uint256)",
  "function sweep(address,address)",
  "function sweepNative(address)",
  "function owner() view returns (address)",
  "function exec(address,bytes,uint256) returns (bytes)",
]);
const CONTAINER_ABI = parseAbi([
  "function trade(address,address,uint256,bool,uint64,uint256,uint256,uint64,uint8,uint256) returns (bool,uint128)",
  "function fundMargin(address,address,uint256)",
  "function settle(address,address,uint256,uint64,uint8) returns (bool,uint128)",
  "function recoverToken(address) returns (uint256)",
  "function recoverNative() returns (uint256)",
  "function owner() view returns (address)",
  "event OrderPlaced(address indexed venue, address indexed token, uint256 quantity, uint256 value, bool filled, uint128 orderId)",
  "event MarginFunded(address indexed bank, address indexed collateral, uint256 amount)",
  "event Settled(address indexed venue, address indexed asset, uint256 quantity, bool filled, uint128 orderId)",
  "event NothingToSettle(address indexed venue, address indexed asset)",
  "event Recovered(address indexed asset, uint256 amount)",
]);
const POOL_ABI = parseAbi([
  "function getPoolParams() view returns (address,address,uint256,uint256,uint256,uint256,uint256)",
  "function getBookLevels(bool,uint64) view returns ((uint256 price,uint256 quantity)[])",
  "function getWithdrawableBalance(address,address) view returns (uint256)",
]);
const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function mint(address,uint256)",
  "function allowance(address,address) view returns (uint256)",
]);

function stateFile(impl: string) {
  return path.join(__dirname, "..", "..", "context", impl === "probe" ? ".probe-container" : ".trading-container");
}

function printUsage() {
  console.log(
    [
      "usage: STAGE=<stage> [IMPL=container|probe] [CONTAINER=0x…] [CONFIRM=1] pnpm exec hardhat run scripts/probe-unified-container.ts --network <net>",
      "",
      `  STAGE   one of: ${KNOWN_STAGES.join(" | ")}`,
      "  IMPL    container (default, contracts/trading/TradingContainer.sol) | probe (contracts/probe/AccountProbe.sol)",
      "  CONFIRM must be set to 1 for any stage that would send a transaction — otherwise the",
      "          stage prints exactly what it would do (venue, asset, amounts, value) and exits.",
      "",
      "nothing sent.",
    ].join("\n"),
  );
}

/** Print the transaction(s) a stage is about to send. Returns true only if CONFIRM=1 is set. */
function mustConfirm(lines: string[]): boolean {
  console.log("this stage would send the following transaction(s):");
  for (const l of lines) console.log("  " + l);
  if (process.env.CONFIRM !== "1") {
    console.log("\nCONFIRM=1 not set — nothing sent. Re-run with CONFIRM=1 to execute.");
    return false;
  }
  console.log("\nCONFIRM=1 set — sending.");
  return true;
}

/** Read the OrderPlaced / Settled / NothingToSettle event out of a receipt's logs,
 *  rather than trusting the receipt's success — a refused order can still return
 *  `ok == false` inside a transaction that itself mined successfully. */
function findContainerEvent(receipt: { logs: readonly { address: string; data: `0x${string}`; topics: readonly `0x${string}`[] }[] }, container: string) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== container.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: CONTAINER_ABI, data: log.data, topics: log.topics as any });
      if (["OrderPlaced", "Settled", "NothingToSettle", "MarginFunded", "Recovered"].includes(decoded.eventName)) {
        return decoded;
      }
    } catch {
      /* not a container event this ABI knows about */
    }
  }
  return null;
}

async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"));
  const usdso = m.external.usdso as `0x${string}`;
  const pub = await hre.viem.getPublicClient();
  const [op] = await hre.viem.getWalletClients();
  const stage = (process.env.STAGE || "").toLowerCase();
  const impl = (process.env.IMPL || "container").toLowerCase();

  if (impl !== "container" && impl !== "probe") {
    console.log(`unknown IMPL "${impl}" — use container or probe`);
    return;
  }
  if (!stage || !KNOWN_STAGES.includes(stage)) {
    printUsage();
    return;
  }

  const STATE = stateFile(impl);
  const container = (process.env.CONTAINER || (fs.existsSync(STATE) ? fs.readFileSync(STATE, "utf-8").trim() : "")) as `0x${string}`;

  // Everything the probe needs to know about a venue, asked of the venue itself.
  async function venueOf(pool: `0x${string}`) {
    const p = (await pub.readContract({ address: pool, abi: POOL_ABI, functionName: "getPoolParams" })) as readonly unknown[];
    const base = p[0] as `0x${string}`;
    const code = await pub.getCode({ address: base });
    const isNative = !code || code === "0x";
    return {
      pool,
      base,
      isNative,
      quote: p[1] as `0x${string}`,
      tick: p[4] as bigint,
      minQty: p[5] as bigint,
      lot: p[6] as bigint,
      dec: isNative ? 18 : Number(await pub.readContract({ address: base, abi: ERC20, functionName: "decimals" })),
    };
  }

  function alignedQty(v: Awaited<ReturnType<typeof venueOf>>) {
    let qty = v.minQty > v.lot ? v.minQty : v.lot;
    if (v.lot > BigInt(0) && qty % v.lot !== BigInt(0)) qty = (qty / v.lot + BigInt(1)) * v.lot;
    return qty;
  }

  /** Read-only: cross the side we have to take. Returns null if the book is empty. */
  async function crossPrice(pool: `0x${string}`, tick: bigint, isBid: boolean) {
    const levels = (await pub.readContract({ address: pool, abi: POOL_ABI, functionName: "getBookLevels", args: [!isBid, BigInt(1)] })) as readonly {
      price: bigint;
      quantity: bigint;
    }[];
    if (levels.length === 0) return null;
    const THROUGH = BigInt(50);
    let price = isBid ? levels[0].price + THROUGH * tick : levels[0].price - THROUGH * tick;
    price = (price / tick) * tick;
    return { price, best: levels[0] };
  }

  async function expireNs() {
    const block = await pub.getBlock();
    return (block.timestamp + BigInt(3600)) * BigInt(1_000_000_000);
  }

  // ------------------------------------------------------------------ deploy
  if (stage === "deploy") {
    const artifactName = impl === "probe" ? "AccountProbe" : "TradingContainer";
    if (!mustConfirm([`deploy ${artifactName} (impl=${impl}) from ${op.account.address}`])) return;
    const art = await hre.artifacts.readArtifact(artifactName);
    const hash = await op.deployContract({ abi: art.abi, bytecode: art.bytecode as `0x${string}`, args: [] });
    const r = await pub.waitForTransactionReceipt({ hash });
    fs.writeFileSync(STATE, r.contractAddress!);
    console.log(`${artifactName} deployed at ${r.contractAddress}  (${(art.deployedBytecode.length - 2) / 2} bytes)`);
    return;
  }

  // events is read-only and does not touch a container, so it needs no CONTAINER.
  if (stage === "events") {
    const desks = m.contracts.EventDesks?.desks ?? m.contracts.EventDesks ?? [];
    const list: string[] = Array.isArray(desks) ? desks.map((d: any) => d.desk ?? d) : [];
    if (list.length === 0) { console.log("no event desks in the manifest"); return; }
    for (const d of list) {
      const addr = d as `0x${string}`;
      let shape = "no";
      try {
        const p = (await pub.readContract({ address: addr, abi: POOL_ABI, functionName: "getPoolParams" })) as readonly unknown[];
        const lv = (await pub.readContract({ address: addr, abi: POOL_ABI, functionName: "getBookLevels", args: [true, BigInt(1)] })) as readonly unknown[];
        shape = `yes — base ${(p[0] as string).slice(0, 10)}…, tick ${formatUnits(p[4] as bigint, 18)}, ${lv.length} bid level(s)`;
      } catch (e: any) {
        shape = `no (${(e.shortMessage ?? e.message).split("\n")[0]})`;
      }
      console.log(`  ${addr}  speaks the spot shape: ${shape}`);
    }
    return;
  }

  if (!container) {
    console.log(`CONTAINER is required (or run STAGE=deploy IMPL=${impl} CONFIRM=1 first)`);
    return;
  }

  // -------------------------------------------------------------------- buy
  if (stage === "buy") {
    const v = await venueOf(m.external.poolWeth as `0x${string}`);
    const qty = alignedQty(v);
    const fund = parseUnits("20", 18);
    const cross = await crossPrice(v.pool, v.tick, true);
    if (!cross) { console.log("nobody offering right now — nothing to buy against"); return; }
    console.log(`  best offer ${formatUnits(cross.best.price, 18)} for ${formatUnits(cross.best.quantity, v.dec)}, ordering at ${formatUnits(cross.price, 18)}`);

    if (impl === "probe") {
      const lines = [
        `mint ${formatUnits(fund, 18)} USDso to container ${container}`,
        `container.approveToken(usdso, ${v.pool}, ${formatUnits(fund, 18)})`,
        `container.trade(venue=${v.pool}, isBid=true, price=${formatUnits(cross.price, 18)}, qty=${formatUnits(qty, v.dec)}, value=0)`,
      ];
      if (!mustConfirm(lines)) return;
      let h = await op.writeContract({ address: usdso, abi: ERC20, functionName: "mint", args: [container, fund] });
      await pub.waitForTransactionReceipt({ hash: h });
      h = await op.writeContract({ address: container, abi: PROBE_ABI, functionName: "approveToken", args: [usdso, v.pool, fund] });
      await pub.waitForTransactionReceipt({ hash: h });
      const b0 = (await pub.readContract({ address: v.base, abi: ERC20, functionName: "balanceOf", args: [container] })) as bigint;
      h = await op.writeContract({
        address: container, abi: PROBE_ABI, functionName: "trade",
        args: [v.pool, true, BigInt(0), cross.price, qty, await expireNs(), 1, BigInt(0)],
      });
      const r = await pub.waitForTransactionReceipt({ hash: h });
      const b1 = (await pub.readContract({ address: v.base, abi: ERC20, functionName: "balanceOf", args: [container] })) as bigint;
      console.log(`  tx ${h} status=${r.status} gas=${r.gasUsed}`);
      console.log(`  base  ${formatUnits(b0, v.dec)} -> ${formatUnits(b1, v.dec)}`);
      console.log(`  ${b1 > b0 ? "filled — container took delivery of the base asset." : "did not fill"}`);
      return;
    }

    const lines = [
      `mint ${formatUnits(fund, 18)} USDso to container ${container}`,
      `container.trade(venue=${v.pool}, token=${usdso} approve=${formatUnits(fund, 18)}, isBid=true, price=${formatUnits(cross.price, 18)}, qty=${formatUnits(qty, v.dec)}, value=0)`,
    ];
    if (!mustConfirm(lines)) return;
    let h = await op.writeContract({ address: usdso, abi: ERC20, functionName: "mint", args: [container, fund] });
    await pub.waitForTransactionReceipt({ hash: h });
    const u0 = (await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [container] })) as bigint;
    const b0 = (await pub.readContract({ address: v.base, abi: ERC20, functionName: "balanceOf", args: [container] })) as bigint;
    h = await op.writeContract({
      address: container, abi: CONTAINER_ABI, functionName: "trade",
      args: [v.pool, usdso, fund, true, BigInt(0), cross.price, qty, await expireNs(), 1, BigInt(0)],
    });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    const u1 = (await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [container] })) as bigint;
    const b1 = (await pub.readContract({ address: v.base, abi: ERC20, functionName: "balanceOf", args: [container] })) as bigint;
    const ev = findContainerEvent(r, container);
    console.log(`  tx ${h} status=${r.status} gas=${r.gasUsed}`);
    console.log(ev ? `  event ${ev.eventName} filled=${(ev as any).args.filled} orderId=${(ev as any).args.orderId}` : "  no OrderPlaced/Settled event found — cannot trust this fill");
    console.log(`  USDso ${formatUnits(u0, 18)} -> ${formatUnits(u1, 18)}`);
    console.log(`  base  ${formatUnits(b0, v.dec)} -> ${formatUnits(b1, v.dec)}`);
    console.log(`  allowance left standing: ${formatUnits((await pub.readContract({ address: usdso, abi: ERC20, functionName: "allowance", args: [container, v.pool] })) as bigint, 18)}`);
    return;
  }

  // ------------------------------------------------------------------- sell
  if (stage === "sell") {
    const v = await venueOf(m.external.poolWeth as `0x${string}`);
    const b0 = (await pub.readContract({ address: v.base, abi: ERC20, functionName: "balanceOf", args: [container] })) as bigint;
    if (b0 === BigInt(0)) { console.log("container holds no base asset — run STAGE=buy first"); return; }
    const qty = (b0 / v.lot) * v.lot;
    if (qty === BigInt(0)) { console.log("holding is below one lot"); return; }
    const cross = await crossPrice(v.pool, v.tick, false);
    if (!cross) { console.log("nobody bidding right now — nothing to sell against"); return; }
    console.log(`  best bid ${formatUnits(cross.best.price, 18)} for ${formatUnits(cross.best.quantity, v.dec)}, ordering at ${formatUnits(cross.price, 18)}`);

    if (impl === "probe") {
      const lines = [
        `container.approveToken(base=${v.base}, ${v.pool}, ${formatUnits(qty, v.dec)})`,
        `container.trade(venue=${v.pool}, isBid=false, price=${formatUnits(cross.price, 18)}, qty=${formatUnits(qty, v.dec)}, value=0)`,
      ];
      if (!mustConfirm(lines)) return;
      let h = await op.writeContract({ address: container, abi: PROBE_ABI, functionName: "approveToken", args: [v.base, v.pool, qty] });
      await pub.waitForTransactionReceipt({ hash: h });
      const u0 = (await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [container] })) as bigint;
      h = await op.writeContract({
        address: container, abi: PROBE_ABI, functionName: "trade",
        args: [v.pool, false, BigInt(0), cross.price, qty, await expireNs(), 1, BigInt(0)],
      });
      const r = await pub.waitForTransactionReceipt({ hash: h });
      const u1 = (await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [container] })) as bigint;
      console.log(`  tx ${h} status=${r.status} gas=${r.gasUsed}`);
      console.log(`  USDso ${formatUnits(u0, 18)} -> ${formatUnits(u1, 18)}`);
      console.log(`  ${u1 > u0 ? "filled — container sold out of its own balance." : "did not fill"}`);
      return;
    }

    const lines = [`container.trade(venue=${v.pool}, token=base=${v.base} approve=${formatUnits(qty, v.dec)}, isBid=false, price=${formatUnits(cross.price, 18)}, qty=${formatUnits(qty, v.dec)}, value=0)`];
    if (!mustConfirm(lines)) return;
    const u0 = (await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [container] })) as bigint;
    const h = await op.writeContract({
      address: container, abi: CONTAINER_ABI, functionName: "trade",
      args: [v.pool, v.base, qty, false, BigInt(0), cross.price, qty, await expireNs(), 1, BigInt(0)],
    });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    const u1 = (await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [container] })) as bigint;
    const b1 = (await pub.readContract({ address: v.base, abi: ERC20, functionName: "balanceOf", args: [container] })) as bigint;
    const ev = findContainerEvent(r, container);
    console.log(`  tx ${h} status=${r.status} gas=${r.gasUsed}`);
    console.log(ev ? `  event ${ev.eventName} filled=${(ev as any).args.filled} orderId=${(ev as any).args.orderId}` : "  no OrderPlaced event found — cannot trust this fill");
    console.log(`  USDso ${formatUnits(u0, 18)} -> ${formatUnits(u1, 18)}`);
    console.log(`  base  ${formatUnits(b0, v.dec)} -> ${formatUnits(b1, v.dec)}`);
    return;
  }

  // ----------------------------------------------------------------- native
  if (stage === "native") {
    const v = await venueOf(m.external.poolSomi as `0x${string}`);
    console.log(`native-base market: base ${v.base}, code length 0 => ${v.isNative}`);
    if (!v.isNative) { console.log("this market's base is a token after all — nothing to prove here"); return; }
    const qty = alignedQty(v);
    const cross = await crossPrice(v.pool, v.tick, false);
    if (!cross) { console.log("nobody bidding right now — nothing to sell against"); return; }
    const bal0 = await pub.getBalance({ address: container });
    const needed = bal0 < qty ? qty - bal0 + parseUnits("0.01", 18) : BigInt(0);

    const lines: string[] = [];
    if (needed > BigInt(0)) lines.push(`send ${formatUnits(needed, 18)} native coin to container ${container} (funding)`);
    lines.push(`container.trade(venue=${v.pool}, token=address(0), isBid=false, price=${formatUnits(cross.price, 18)}, qty=${formatUnits(qty, v.dec)}, value=${formatUnits(qty, v.dec)})`);
    if (impl === "probe") lines[lines.length - 1] = `container.trade(venue=${v.pool}, isBid=false, price=${formatUnits(cross.price, 18)}, qty=${formatUnits(qty, v.dec)}, value=${formatUnits(qty, v.dec)})`;
    if (!mustConfirm(lines)) return;

    if (needed > BigInt(0)) {
      const h = await op.sendTransaction({ to: container, value: needed });
      await pub.waitForTransactionReceipt({ hash: h });
    }
    const c0 = await pub.getBalance({ address: container });
    const u0 = (await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [container] })) as bigint;

    if (impl === "probe") {
      const h = await op.writeContract({
        address: container, abi: PROBE_ABI, functionName: "trade",
        args: [v.pool, false, BigInt(0), cross.price, qty, await expireNs(), 1, qty],
      });
      const r = await pub.waitForTransactionReceipt({ hash: h });
      const c1 = await pub.getBalance({ address: container });
      const u1 = (await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [container] })) as bigint;
      console.log(`  tx ${h} status=${r.status} gas=${r.gasUsed}`);
      console.log(`  coin  ${formatUnits(c0, 18)} -> ${formatUnits(c1, 18)}`);
      console.log(`  USDso ${formatUnits(u0, 18)} -> ${formatUnits(u1, 18)}`);
      console.log(`  ${u1 > u0 ? "sold — the native market CAN be sold from a container." : "not sold"}`);
      return;
    }

    const h = await op.writeContract({
      address: container, abi: CONTAINER_ABI, functionName: "trade",
      args: [v.pool, "0x0000000000000000000000000000000000000000", BigInt(0), false, BigInt(0), cross.price, qty, await expireNs(), 1, qty],
    });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    const c1 = await pub.getBalance({ address: container });
    const u1 = (await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [container] })) as bigint;
    const ev = findContainerEvent(r, container);
    console.log(`  tx ${h} status=${r.status} gas=${r.gasUsed}`);
    console.log(ev ? `  event ${ev.eventName} filled=${(ev as any).args.filled} orderId=${(ev as any).args.orderId}` : "  no OrderPlaced event found — cannot trust this fill");
    console.log(`  coin  ${formatUnits(c0, 18)} -> ${formatUnits(c1, 18)}`);
    console.log(`  USDso ${formatUnits(u0, 18)} -> ${formatUnits(u1, 18)}`);
    return;
  }

  // ----------------------------------------------------------------- settle
  if (stage === "settle") {
    if (impl === "probe") { console.log("settle is only implemented against IMPL=container — AccountProbe has no settle() entry point"); return; }
    const which = (process.env.ASSET || "base").toLowerCase(); // "base" | "native"

    if (which === "native") {
      const v = await venueOf(m.external.poolSomi as `0x${string}`);
      const bal = await pub.getBalance({ address: container });
      const cross = await crossPrice(v.pool, v.tick, false);
      if (!cross) { console.log("nobody bidding right now — nothing to settle against"); return; }
      const lines = [`container.settle(venue=${v.pool}, asset=address(0), price=${formatUnits(cross.price, 18)}) — sells the WHOLE native balance (currently ${formatUnits(bal, 18)})`];
      if (!mustConfirm(lines)) return;
      const u0 = (await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [container] })) as bigint;
      const h = await op.writeContract({
        address: container, abi: CONTAINER_ABI, functionName: "settle",
        args: [v.pool, "0x0000000000000000000000000000000000000000", cross.price, await expireNs(), 1],
      });
      const r = await pub.waitForTransactionReceipt({ hash: h });
      const c1 = await pub.getBalance({ address: container });
      const u1 = (await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [container] })) as bigint;
      const ev = findContainerEvent(r, container);
      console.log(`  tx ${h} status=${r.status} gas=${r.gasUsed}`);
      console.log(ev ? `  event ${ev.eventName} filled=${(ev as any).args.filled ?? "-"} orderId=${(ev as any).args.orderId ?? "-"}` : "  no Settled/NothingToSettle event found — cannot trust this fill");
      console.log(`  coin  -> ${formatUnits(c1, 18)}`);
      console.log(`  USDso ${formatUnits(u0, 18)} -> ${formatUnits(u1, 18)}`);
      return;
    }

    const v = await venueOf(m.external.poolWeth as `0x${string}`);
    const b0 = (await pub.readContract({ address: v.base, abi: ERC20, functionName: "balanceOf", args: [container] })) as bigint;
    if (b0 === BigInt(0)) { console.log("container holds no base asset — run STAGE=buy first, or STAGE=settle ASSET=native"); return; }
    const cross = await crossPrice(v.pool, v.tick, false);
    if (!cross) { console.log("nobody bidding right now — nothing to settle against"); return; }
    const lines = [`container.settle(venue=${v.pool}, asset=base=${v.base}, price=${formatUnits(cross.price, 18)}) — sells the WHOLE base balance (currently ${formatUnits(b0, v.dec)})`];
    if (!mustConfirm(lines)) return;
    const u0 = (await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [container] })) as bigint;
    const h = await op.writeContract({
      address: container, abi: CONTAINER_ABI, functionName: "settle",
      args: [v.pool, v.base, cross.price, await expireNs(), 1],
    });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    const b1 = (await pub.readContract({ address: v.base, abi: ERC20, functionName: "balanceOf", args: [container] })) as bigint;
    const u1 = (await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [container] })) as bigint;
    const ev = findContainerEvent(r, container);
    console.log(`  tx ${h} status=${r.status} gas=${r.gasUsed}`);
    console.log(ev ? `  event ${ev.eventName} filled=${(ev as any).args.filled ?? "-"} orderId=${(ev as any).args.orderId ?? "-"}` : "  no Settled/NothingToSettle event found — cannot trust this fill");
    console.log(`  base  ${formatUnits(b0, v.dec)} -> ${formatUnits(b1, v.dec)}`);
    console.log(`  USDso ${formatUnits(u0, 18)} -> ${formatUnits(u1, 18)}`);
    return;
  }

  // -------------------------------------------------------------------- perp
  if (stage === "perp") {
    const bank = m.contracts.PerpDesks.marginBank as `0x${string}`;
    const want = process.env.MARKET || "XRP";
    const desk = m.contracts.PerpDesks.desks.find((d: any) => d.market === want) ?? m.contracts.PerpDesks.desks[0];
    const perpPool = desk.perpPool as `0x${string}`;

    const OBP = parseAbi(["function getOrderBookParameters() view returns (uint256,uint256,uint256)"]);
    const [tick, minQty, lot] = (await pub.readContract({ address: perpPool, abi: OBP, functionName: "getOrderBookParameters" })) as readonly [bigint, bigint, bigint];
    let qty = minQty > lot ? minQty : lot;
    if (lot > BigInt(0) && qty % lot !== BigInt(0)) qty = (qty / lot + BigInt(1)) * lot;
    const cross = await crossPrice(perpPool, tick, true);
    if (!cross) { console.log("no offers on this perp book right now"); return; }
    const fund = parseUnits("20", 18);

    if (impl === "probe") {
      const lines = [
        `mint ${formatUnits(fund, 18)} USDso to container`,
        `container.approveToken(usdso, ${bank}, ${formatUnits(fund, 18)}); container.exec(bank, deposit(${formatUnits(fund, 18)}))`,
        `container.trade(venue=${perpPool}, isBid=true, price=${formatUnits(cross.price, 18)}, qty=${formatUnits(qty, desk.baseDecimals)}, value=0)`,
      ];
      if (!mustConfirm(lines)) return;
      let h = await op.writeContract({ address: usdso, abi: ERC20, functionName: "mint", args: [container, fund] });
      await pub.waitForTransactionReceipt({ hash: h });
      h = await op.writeContract({ address: container, abi: PROBE_ABI, functionName: "approveToken", args: [usdso, bank, fund] });
      await pub.waitForTransactionReceipt({ hash: h });
      const depositData = ("0xb6b55f25" + fund.toString(16).padStart(64, "0")) as `0x${string}`;
      h = await op.writeContract({ address: container, abi: PROBE_ABI, functionName: "exec", args: [bank, depositData, BigInt(0)] });
      await pub.waitForTransactionReceipt({ hash: h });
      const MKT = parseAbi(["function market() view returns (address)"]);
      const POS = parseAbi(["function getPosition(address,address) view returns (int256,uint256,uint256,uint256)"]);
      const market = (await pub.readContract({ address: desk.desk as `0x${string}`, abi: MKT, functionName: "market" })) as `0x${string}`;
      const p0 = (await pub.readContract({ address: bank, abi: POS, functionName: "getPosition", args: [container, market] })) as readonly [bigint, bigint, bigint, bigint];
      h = await op.writeContract({
        address: container, abi: PROBE_ABI, functionName: "trade",
        args: [perpPool, true, BigInt(0), cross.price, qty, await expireNs(), 1, BigInt(0)],
      });
      const r = await pub.waitForTransactionReceipt({ hash: h });
      const p1 = (await pub.readContract({ address: bank, abi: POS, functionName: "getPosition", args: [container, market] })) as readonly [bigint, bigint, bigint, bigint];
      console.log(`  tx ${h} status=${r.status} gas=${r.gasUsed}`);
      console.log(`  position ${formatUnits(p0[0], desk.baseDecimals)} -> ${formatUnits(p1[0], desk.baseDecimals)}`);
      return;
    }

    const lines = [
      `mint ${formatUnits(fund, 18)} USDso to container`,
      `container.fundMargin(collateral=${usdso}, bank=${bank}, amount=${formatUnits(fund, 18)})`,
      `container.trade(venue=${perpPool}, token=address(0), isBid=true, price=${formatUnits(cross.price, 18)}, qty=${formatUnits(qty, desk.baseDecimals)}, value=0)`,
    ];
    if (!mustConfirm(lines)) return;
    let h = await op.writeContract({ address: usdso, abi: ERC20, functionName: "mint", args: [container, fund] });
    await pub.waitForTransactionReceipt({ hash: h });
    h = await op.writeContract({ address: container, abi: CONTAINER_ABI, functionName: "fundMargin", args: [usdso, bank, fund] });
    const rFund = await pub.waitForTransactionReceipt({ hash: h });
    const fundEv = findContainerEvent(rFund, container);
    console.log(fundEv ? `  event ${fundEv.eventName}` : "  no MarginFunded event found");

    const MKT = parseAbi(["function market() view returns (address)"]);
    const POS = parseAbi(["function getPosition(address,address) view returns (int256,uint256,uint256,uint256)"]);
    const market = (await pub.readContract({ address: desk.desk as `0x${string}`, abi: MKT, functionName: "market" })) as `0x${string}`;
    const p0 = (await pub.readContract({ address: bank, abi: POS, functionName: "getPosition", args: [container, market] })) as readonly [bigint, bigint, bigint, bigint];
    h = await op.writeContract({
      address: container, abi: CONTAINER_ABI, functionName: "trade",
      args: [perpPool, "0x0000000000000000000000000000000000000000", BigInt(0), true, BigInt(0), cross.price, qty, await expireNs(), 1, BigInt(0)],
    });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    const p1 = (await pub.readContract({ address: bank, abi: POS, functionName: "getPosition", args: [container, market] })) as readonly [bigint, bigint, bigint, bigint];
    const ev = findContainerEvent(r, container);
    console.log(`  tx ${h} status=${r.status} gas=${r.gasUsed}`);
    console.log(ev ? `  event ${ev.eventName} filled=${(ev as any).args.filled} orderId=${(ev as any).args.orderId}` : "  no OrderPlaced event found — cannot trust this fill");
    console.log(`  position ${formatUnits(p0[0], desk.baseDecimals)} -> ${formatUnits(p1[0], desk.baseDecimals)}`);
    return;
  }

  // -------------------------------------------------------------- perpclose
  if (stage === "perpclose") {
    const bank = m.contracts.PerpDesks.marginBank as `0x${string}`;
    const want = process.env.MARKET || "XRP";
    const desk = m.contracts.PerpDesks.desks.find((d: any) => d.market === want) ?? m.contracts.PerpDesks.desks[0];
    const perpPool = desk.perpPool as `0x${string}`;
    const OBP = parseAbi(["function getOrderBookParameters() view returns (uint256,uint256,uint256)"]);
    const POS = parseAbi(["function getPosition(address,address) view returns (int256,uint256,uint256,uint256)"]);
    const MKT = parseAbi(["function market() view returns (address)"]);
    const market = (await pub.readContract({ address: desk.desk as `0x${string}`, abi: MKT, functionName: "market" })) as `0x${string}`;
    const [tick] = (await pub.readContract({ address: perpPool, abi: OBP, functionName: "getOrderBookParameters" })) as readonly [bigint, bigint, bigint];
    const p0 = (await pub.readContract({ address: bank, abi: POS, functionName: "getPosition", args: [container, market] })) as readonly [bigint, bigint, bigint, bigint];
    console.log(`position ${formatUnits(p0[0], desk.baseDecimals)}`);

    if (p0[0] !== BigInt(0)) {
      const isLong = p0[0] > BigInt(0);
      const qty = isLong ? p0[0] : -p0[0];
      const cross = await crossPrice(perpPool, tick, !isLong);
      if (!cross) { console.log("no counterparty right now"); return; }
      const lines = [
        `container.trade(venue=${perpPool}, isBid=${!isLong}, price=${formatUnits(cross.price, 18)}, qty=${formatUnits(qty, desk.baseDecimals)}, value=0) — closes the open position`,
      ];
      if (!mustConfirm(lines)) return;

      if (impl === "probe") {
        const h = await op.writeContract({
          address: container, abi: PROBE_ABI, functionName: "trade",
          args: [perpPool, !isLong, BigInt(0), cross.price, qty, await expireNs(), 1, BigInt(0)],
        });
        const r = await pub.waitForTransactionReceipt({ hash: h });
        const p1 = (await pub.readContract({ address: bank, abi: POS, functionName: "getPosition", args: [container, market] })) as readonly [bigint, bigint, bigint, bigint];
        console.log(`  tx ${h} status=${r.status} gas=${r.gasUsed}`);
        console.log(`  position ${formatUnits(p0[0], desk.baseDecimals)} -> ${formatUnits(p1[0], desk.baseDecimals)}  ${p1[0] === BigInt(0) ? "FLAT" : "still open"}`);
      } else {
        const h = await op.writeContract({
          address: container, abi: CONTAINER_ABI, functionName: "trade",
          args: [perpPool, "0x0000000000000000000000000000000000000000", BigInt(0), !isLong, BigInt(0), cross.price, qty, await expireNs(), 1, BigInt(0)],
        });
        const r = await pub.waitForTransactionReceipt({ hash: h });
        const p1 = (await pub.readContract({ address: bank, abi: POS, functionName: "getPosition", args: [container, market] })) as readonly [bigint, bigint, bigint, bigint];
        const ev = findContainerEvent(r, container);
        console.log(`  tx ${h} status=${r.status} gas=${r.gasUsed}`);
        console.log(ev ? `  event ${ev.eventName} filled=${(ev as any).args.filled} orderId=${(ev as any).args.orderId}` : "  no OrderPlaced event found — cannot trust this fill");
        console.log(`  position ${formatUnits(p0[0], desk.baseDecimals)} -> ${formatUnits(p1[0], desk.baseDecimals)}  ${p1[0] === BigInt(0) ? "FLAT" : "still open"}`);
      }
    }

    if (impl === "probe") {
      const WD = parseAbi(["function getWithdrawableCollateral(address) view returns (uint256)"]);
      const w = (await pub.readContract({ address: bank, abi: WD, functionName: "getWithdrawableCollateral", args: [container] })) as bigint;
      console.log(`  withdrawable margin ${formatUnits(w, 18)}`);
      if (w > BigInt(0)) {
        const lines = [`container.exec(bank, withdraw(${formatUnits(w, 18)}))`];
        if (!mustConfirm(lines)) return;
        const data = ("0x2e1a7d4d" + w.toString(16).padStart(64, "0")) as `0x${string}`;
        const h = await op.writeContract({ address: container, abi: PROBE_ABI, functionName: "exec", args: [bank, data, BigInt(0)] });
        const r = await pub.waitForTransactionReceipt({ hash: h });
        console.log(`  margin withdrawn: status=${r.status}`);
      }
    } else {
      // TradingContainer has no exec escape hatch, and — by design — no dedicated
      // margin-withdrawal entry point either: fundMargin only deposits. Withdrawing
      // margin back out of the bank is not something this container's surface can
      // do, so this step is intentionally not exercised here. Flagged, not sent.
      console.log("  IMPL=container has no margin-withdrawal entry point (fundMargin is deposit-only, and there is no exec hatch) — not exercised.");
    }
    return;
  }

  // ---------------------------------------------------------------- recover
  if (stage === "recover") {
    const v = await venueOf(m.external.poolWeth as `0x${string}`);
    const tokenBalances = await Promise.all(
      [usdso, v.base].map(async (t) => ({ t, bal: (await pub.readContract({ address: t, abi: ERC20, functionName: "balanceOf", args: [container] })) as bigint })),
    );
    const nativeBal = await pub.getBalance({ address: container });
    const lines: string[] = [];
    for (const { t, bal } of tokenBalances) {
      if (bal > BigInt(0)) lines.push(`container.${impl === "probe" ? "sweep" : "recoverToken"}(${t}) — moves ${formatUnits(bal, 18)}`);
    }
    if (nativeBal > BigInt(0)) lines.push(`container.${impl === "probe" ? "sweepNative" : "recoverNative"}() — moves ${formatUnits(nativeBal, 18)} native coin`);
    if (lines.length === 0) { console.log("nothing to recover — container is empty"); return; }
    if (!mustConfirm(lines)) return;

    for (const { t, bal } of tokenBalances) {
      if (bal === BigInt(0)) continue;
      const h =
        impl === "probe"
          ? await op.writeContract({ address: container, abi: PROBE_ABI, functionName: "sweep", args: [t, op.account.address] })
          : await op.writeContract({ address: container, abi: CONTAINER_ABI, functionName: "recoverToken", args: [t] });
      await pub.waitForTransactionReceipt({ hash: h });
    }
    if (nativeBal > BigInt(0)) {
      const h =
        impl === "probe"
          ? await op.writeContract({ address: container, abi: PROBE_ABI, functionName: "sweepNative", args: [op.account.address] })
          : await op.writeContract({ address: container, abi: CONTAINER_ABI, functionName: "recoverNative" });
      await pub.waitForTransactionReceipt({ hash: h });
    }
    console.log("everything recovered from the container");
    return;
  }
}

main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exit(1);
});
