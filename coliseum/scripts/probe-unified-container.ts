// ============================================================================
// probe-unified-container — can ONE dumb container serve every market type?
//
// The one-engine design says: give each fighter a container that holds money,
// places its own orders, and receives its own fills, and the whole class of
// two-pot accounting faults disappears. Three things have to be true for that,
// and none of them can be settled by reading code:
//
//   1. a CONTRACT can buy on a spot venue and keep the fill
//   2. the same contract can sell it back out of its own balance
//   3. the same contract can sell the market whose asset is the chain's own
//      coin — the trade the game cannot make today — by sending value
//
// Run in stages so a failure is attributable:
//   STAGE=deploy   … deploy the container and report its address
//   STAGE=buy      CONTAINER=0x… buy the smallest WETH lot
//   STAGE=sell     CONTAINER=0x… sell it straight back
//   STAGE=native   CONTAINER=0x… sell the native-base market
//   STAGE=events   report whether the events desk speaks the same shape
//   STAGE=recover  CONTAINER=0x… take everything back out
//
// Spends a few USDso. Every stage is reversible by `recover`.
// ============================================================================
import hre from "hardhat";
import { formatUnits, parseUnits, parseAbi } from "viem";
import fs from "fs";
import path from "path";

const PROBE_ABI = parseAbi([
  "function trade(address,bool,uint64,uint256,uint256,uint64,uint8,uint256) returns (bool,uint128)",
  "function approveToken(address,address,uint256)",
  "function sweep(address,address)",
  "function sweepNative(address)",
  "function owner() view returns (address)",
  "function exec(address,bytes,uint256) returns (bytes)",
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
]);

const STATE = path.join(__dirname, "..", "..", "context", ".probe-container");

async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"));
  const usdso = m.external.usdso as `0x${string}`;
  const pub = await hre.viem.getPublicClient();
  const [op] = await hre.viem.getWalletClients();
  const stage = (process.env.STAGE || "").toLowerCase();
  const container = (process.env.CONTAINER || (fs.existsSync(STATE) ? fs.readFileSync(STATE, "utf-8").trim() : "")) as `0x${string}`;

  // Everything the probe needs to know about a venue, asked of the venue itself.
  async function venueOf(pool: `0x${string}`) {
    const p = await pub.readContract({ address: pool, abi: POOL_ABI, functionName: "getPoolParams" }) as readonly unknown[];
    const base = p[0] as `0x${string}`;
    const code = await pub.getCode({ address: base });
    const isNative = !code || code === "0x";
    return {
      pool, base, isNative,
      quote: p[1] as `0x${string}`,
      tick: p[4] as bigint, minQty: p[5] as bigint, lot: p[6] as bigint,
      dec: isNative ? 18 : Number(await pub.readContract({ address: base, abi: ERC20, functionName: "decimals" })),
    };
  }

  async function place(v: Awaited<ReturnType<typeof venueOf>>, isBid: boolean, qty: bigint, value: bigint) {
    // Cross the side we have to take. `true` returns bids (descending), `false` asks.
    const levels = await pub.readContract({ address: v.pool, abi: POOL_ABI, functionName: "getBookLevels", args: [!isBid, BigInt(1)] }) as readonly { price: bigint; quantity: bigint }[];
    if (levels.length === 0) { console.log("    nobody on the other side right now"); return null; }
    const THROUGH = BigInt(50);
    let price = isBid ? levels[0].price + THROUGH * v.tick : levels[0].price - THROUGH * v.tick;
    price = (price / v.tick) * v.tick;                      // land on a tick, always
    const block = await pub.getBlock();
    const expireNs = (block.timestamp + BigInt(3600)) * BigInt(1_000_000_000);
    console.log(`    best ${isBid ? "offer" : "bid"} ${formatUnits(levels[0].price, 18)} for ${formatUnits(levels[0].quantity, v.dec)}, ordering at ${formatUnits(price, 18)}`);
    const sim = await pub.simulateContract({
      address: container, abi: PROBE_ABI, functionName: "trade",
      args: [v.pool, isBid, BigInt(0), price, qty, expireNs, 1, value], account: op.account, value: BigInt(0),
    }).catch((e: any) => { console.log(`    would revert: ${(e.shortMessage ?? e.message).split("\n")[0]}`); return null; });
    if (!sim) return null;
    console.log(`    the venue would ${(sim.result as readonly unknown[])[0] ? "TAKE" : "REFUSE"} it`);
    const hash = await op.writeContract({ address: container, abi: PROBE_ABI, functionName: "trade", args: [v.pool, isBid, BigInt(0), price, qty, expireNs, 1, value] });
    const r = await pub.waitForTransactionReceipt({ hash });
    console.log(`    tx ${hash} status=${r.status} gas=${r.gasUsed}`);
    return r;
  }

  if (stage === "deploy") {
    const art = await hre.artifacts.readArtifact("AccountProbe");
    const hash = await op.deployContract({ abi: art.abi, bytecode: art.bytecode as `0x${string}`, args: [] });
    const r = await pub.waitForTransactionReceipt({ hash });
    fs.writeFileSync(STATE, r.contractAddress!);
    console.log(`container deployed at ${r.contractAddress}  (${(art.deployedBytecode.length - 2) / 2} bytes)`);
    return;
  }
  if (!container) throw new Error("CONTAINER is required (or run STAGE=deploy first)");

  if (stage === "buy") {
    const v = await venueOf(m.external.poolWeth as `0x${string}`);
    let qty = v.minQty > v.lot ? v.minQty : v.lot;
    if (v.lot > BigInt(0) && qty % v.lot !== BigInt(0)) qty = ((qty / v.lot) + BigInt(1)) * v.lot;

    // Fund the container with its own money — the whole point is that this is ITS
    // balance, not a deposit lodged with the venue. Minting is permissionless here.
    const fund = parseUnits("20", 18);
    let h = await op.writeContract({ address: usdso, abi: ERC20, functionName: "mint", args: [container, fund] });
    await pub.waitForTransactionReceipt({ hash: h });
    h = await op.writeContract({ address: container, abi: PROBE_ABI, functionName: "approveToken", args: [usdso, v.pool, fund] });
    await pub.waitForTransactionReceipt({ hash: h });

    const u0 = await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [container] }) as bigint;
    const b0 = await pub.readContract({ address: v.base, abi: ERC20, functionName: "balanceOf", args: [container] }) as bigint;
    const d0 = await pub.readContract({ address: v.pool, abi: POOL_ABI, functionName: "getWithdrawableBalance", args: [container, usdso] }) as bigint;
    console.log(`container holds ${formatUnits(u0, 18)} USDso, ${formatUnits(b0, v.dec)} base, and has ${formatUnits(d0, 18)} deposited\n  BUY ${formatUnits(qty, v.dec)}`);
    await place(v, true, qty, BigInt(0));
    const u1 = await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [container] }) as bigint;
    const b1 = await pub.readContract({ address: v.base, abi: ERC20, functionName: "balanceOf", args: [container] }) as bigint;
    console.log(`\n  USDso ${formatUnits(u0, 18)} -> ${formatUnits(u1, 18)}`);
    console.log(`  base  ${formatUnits(b0, v.dec)} -> ${formatUnits(b1, v.dec)}`);
    console.log(`  ${u1 < u0 && b1 > b0 ? "QUESTION 1 ANSWERED: a container pays from itself and is paid into itself." : "did not fill — see above"}`);
    return;
  }

  if (stage === "sell") {
    const v = await venueOf(m.external.poolWeth as `0x${string}`);
    const b0 = await pub.readContract({ address: v.base, abi: ERC20, functionName: "balanceOf", args: [container] }) as bigint;
    if (b0 === BigInt(0)) { console.log("container holds no base asset — run STAGE=buy first"); return; }
    let qty = (b0 / v.lot) * v.lot;
    if (qty === BigInt(0)) { console.log("holding is below one lot"); return; }
    const u0 = await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [container] }) as bigint;
    let h = await op.writeContract({ address: container, abi: PROBE_ABI, functionName: "approveToken", args: [v.base, v.pool, qty] });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(`container holds ${formatUnits(b0, v.dec)} base\n  SELL ${formatUnits(qty, v.dec)}`);
    await place(v, false, qty, BigInt(0));
    const u1 = await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [container] }) as bigint;
    const b1 = await pub.readContract({ address: v.base, abi: ERC20, functionName: "balanceOf", args: [container] }) as bigint;
    console.log(`\n  USDso ${formatUnits(u0, 18)} -> ${formatUnits(u1, 18)}`);
    console.log(`  base  ${formatUnits(b0, v.dec)} -> ${formatUnits(b1, v.dec)}`);
    console.log(`  ${b1 < b0 && u1 > u0 ? "QUESTION 2 ANSWERED: the same container sells out of its own balance." : "did not fill — see above"}`);
    return;
  }

  if (stage === "native") {
    const v = await venueOf(m.external.poolSomi as `0x${string}`);
    console.log(`native-base market: base ${v.base}, code length 0 => ${v.isNative}`);
    if (!v.isNative) { console.log("this market's base is a token after all — nothing to prove here"); return; }
    let qty = v.minQty > v.lot ? v.minQty : v.lot;
    if (v.lot > BigInt(0) && qty % v.lot !== BigInt(0)) qty = ((qty / v.lot) + BigInt(1)) * v.lot;

    // Give the container the coin to sell, then send that coin WITH the order —
    // the thing the arena cannot do, because its coin is also its thinking fuel.
    const bal0 = await pub.getBalance({ address: container });
    if (bal0 < qty) {
      const h = await op.sendTransaction({ to: container, value: qty - bal0 + parseUnits("0.01", 18) });
      await pub.waitForTransactionReceipt({ hash: h });
    }
    const c0 = await pub.getBalance({ address: container });
    const u0 = await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [container] }) as bigint;
    console.log(`container holds ${formatUnits(c0, 18)} of the coin, ${formatUnits(u0, 18)} USDso\n  SELL ${formatUnits(qty, v.dec)} sending the coin with the order`);
    await place(v, false, qty, qty);
    const c1 = await pub.getBalance({ address: container });
    const u1 = await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [container] }) as bigint;
    console.log(`\n  coin  ${formatUnits(c0, 18)} -> ${formatUnits(c1, 18)}`);
    console.log(`  USDso ${formatUnits(u0, 18)} -> ${formatUnits(u1, 18)}`);
    console.log(`  ${u1 > u0 ? "QUESTION 3 ANSWERED: the native market CAN be sold from a container." : "not sold — this market stays buy-only and the plan must say so"}`);
    return;
  }

  if (stage === "events") {
    // The claim is that the events adapter already presents the same shape, so one
    // container could trade it unchanged. Ask the desks directly rather than trusting
    // the adapter's docstring.
    const desks = m.contracts.EventDesks?.desks ?? m.contracts.EventDesks ?? [];
    const list: string[] = Array.isArray(desks) ? desks.map((d: any) => d.desk ?? d) : [];
    if (list.length === 0) { console.log("no event desks in the manifest"); return; }
    for (const d of list) {
      const addr = d as `0x${string}`;
      let shape = "no";
      try {
        const p = await pub.readContract({ address: addr, abi: POOL_ABI, functionName: "getPoolParams" }) as readonly unknown[];
        const lv = await pub.readContract({ address: addr, abi: POOL_ABI, functionName: "getBookLevels", args: [true, BigInt(1)] }) as readonly unknown[];
        shape = `yes — base ${(p[0] as string).slice(0, 10)}…, tick ${formatUnits(p[4] as bigint, 18)}, ${lv.length} bid level(s)`;
      } catch (e: any) { shape = `no (${(e.shortMessage ?? e.message).split("\n")[0]})`; }
      console.log(`  ${addr}  speaks the spot shape: ${shape}`);
    }
    return;
  }

  if (stage === "perp") {
    // The last open question: can ONE container type serve perpetuals too, or do
    // they need their own? A perpetual is not paid for at the counter — margin is
    // lodged with a separate desk first, and the order is then backed by it. If the
    // same container can do that, the engine is one container and three
    // translators. If not, it is two container types, and the plan must say so.
    const bank = m.contracts.PerpDesks.marginBank as `0x${string}`;
    const want = process.env.MARKET || "XRP";
    const desk = m.contracts.PerpDesks.desks.find((d: any) => d.market === want) ?? m.contracts.PerpDesks.desks[0];
    const perpPool = desk.perpPool as `0x${string}`;

    const OBP = parseAbi(["function getOrderBookParameters() view returns (uint256,uint256,uint256)"]);
    const obp = await pub.readContract({ address: perpPool, abi: OBP, functionName: "getOrderBookParameters" }) as readonly [bigint, bigint, bigint];
    const [tick, minQty, lot] = obp;

    const fund = parseUnits("20", 18);
    let h = await op.writeContract({ address: usdso, abi: ERC20, functionName: "mint", args: [container, fund] });
    await pub.waitForTransactionReceipt({ hash: h });

    // Lodge the margin: let the desk take the money, then tell it to take it.
    h = await op.writeContract({ address: container, abi: PROBE_ABI, functionName: "approveToken", args: [usdso, bank, fund] });
    await pub.waitForTransactionReceipt({ hash: h });
    const depositData = ("0xb6b55f25" + fund.toString(16).padStart(64, "0")) as `0x${string}`; // deposit(uint256)
    try {
      h = await op.writeContract({ address: container, abi: PROBE_ABI, functionName: "exec", args: [bank, depositData, BigInt(0)] });
      const r0 = await pub.waitForTransactionReceipt({ hash: h });
      console.log(`margin lodged with the desk: tx ${h} status=${r0.status}`);
    } catch (e: any) { console.log(`could not lodge margin: ${(e.shortMessage ?? e.message).split("\n")[0]}`); return; }

    const POS = parseAbi(["function getPosition(address,address) view returns (int256,uint256,uint256,uint256)"]);
    const MKT = parseAbi(["function market() view returns (address)"]);
    const market = await pub.readContract({ address: desk.desk as `0x${string}`, abi: MKT, functionName: "market" }) as `0x${string}`;
    const p0 = await pub.readContract({ address: bank, abi: POS, functionName: "getPosition", args: [container, market] }) as readonly [bigint, bigint, bigint, bigint];

    let qty = minQty > lot ? minQty : lot;
    if (lot > BigInt(0) && qty % lot !== BigInt(0)) qty = ((qty / lot) + BigInt(1)) * lot;
    const levels = await pub.readContract({ address: perpPool, abi: POOL_ABI, functionName: "getBookLevels", args: [false, BigInt(1)] }) as readonly { price: bigint }[];
    if (levels.length === 0) { console.log("no offers on this perp book right now"); return; }
    let price = levels[0].price + BigInt(50) * tick;
    price = (price / tick) * tick;
    const block = await pub.getBlock();
    const expireNs = (block.timestamp + BigInt(3600)) * BigInt(1_000_000_000);
    console.log(`\n  ${desk.market}-PERP: buying ${formatUnits(qty, desk.baseDecimals)} at ${formatUnits(price, 18)} (best offer ${formatUnits(levels[0].price, 18)})`);
    h = await op.writeContract({ address: container, abi: PROBE_ABI, functionName: "trade", args: [perpPool, true, BigInt(0), price, qty, expireNs, 1, BigInt(0)] });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    const p1 = await pub.readContract({ address: bank, abi: POS, functionName: "getPosition", args: [container, market] }) as readonly [bigint, bigint, bigint, bigint];
    console.log(`  tx ${h} status=${r.status} gas=${r.gasUsed}`);
    console.log(`  position ${formatUnits(p0[0], desk.baseDecimals)} -> ${formatUnits(p1[0], desk.baseDecimals)}`);
    console.log(`  ${p1[0] !== p0[0] ? "QUESTION 4 ANSWERED: one container type serves perpetuals too." : "no position opened — perps need their own container, and the plan must say so"}`);
    return;
  }

  if (stage === "perpclose") {
    // Close the probe position and take the margin back. This also re-tests, from a
    // container we fully control, the exact mechanism the owner rescue path failed
    // at earlier today: a fill-or-kill sell on a perpetual book. If it succeeds here
    // and fails there, the difference is not the venue.
    const bank = m.contracts.PerpDesks.marginBank as `0x${string}`;
    const want = process.env.MARKET || "XRP";
    const desk = m.contracts.PerpDesks.desks.find((d: any) => d.market === want) ?? m.contracts.PerpDesks.desks[0];
    const perpPool = desk.perpPool as `0x${string}`;
    const OBP = parseAbi(["function getOrderBookParameters() view returns (uint256,uint256,uint256)"]);
    const POS = parseAbi(["function getPosition(address,address) view returns (int256,uint256,uint256,uint256)"]);
    const MKT = parseAbi(["function market() view returns (address)"]);
    const market = await pub.readContract({ address: desk.desk as `0x${string}`, abi: MKT, functionName: "market" }) as `0x${string}`;
    const [tick] = await pub.readContract({ address: perpPool, abi: OBP, functionName: "getOrderBookParameters" }) as readonly [bigint, bigint, bigint];
    const p0 = await pub.readContract({ address: bank, abi: POS, functionName: "getPosition", args: [container, market] }) as readonly [bigint, bigint, bigint, bigint];
    console.log(`position ${formatUnits(p0[0], desk.baseDecimals)}`);
    if (p0[0] !== BigInt(0)) {
      const isLong = p0[0] > BigInt(0);
      const qty = isLong ? p0[0] : -p0[0];
      const levels = await pub.readContract({ address: perpPool, abi: POOL_ABI, functionName: "getBookLevels", args: [isLong, BigInt(1)] }) as readonly { price: bigint; quantity: bigint }[];
      if (levels.length === 0) { console.log("no counterparty right now"); return; }
      let price = isLong ? levels[0].price - BigInt(50) * tick : levels[0].price + BigInt(50) * tick;
      price = (price / tick) * tick;
      const block = await pub.getBlock();
      const expireNs = (block.timestamp + BigInt(3600)) * BigInt(1_000_000_000);
      console.log(`  closing: ${isLong ? "SELL" : "BUY"} ${formatUnits(qty, desk.baseDecimals)} at ${formatUnits(price, 18)} (best ${formatUnits(levels[0].price, 18)} for ${formatUnits(levels[0].quantity, desk.baseDecimals)})`);
      const h = await op.writeContract({ address: container, abi: PROBE_ABI, functionName: "trade", args: [perpPool, !isLong, BigInt(0), price, qty, expireNs, 1, BigInt(0)] });
      const r = await pub.waitForTransactionReceipt({ hash: h });
      const p1 = await pub.readContract({ address: bank, abi: POS, functionName: "getPosition", args: [container, market] }) as readonly [bigint, bigint, bigint, bigint];
      console.log(`  tx ${h} status=${r.status} gas=${r.gasUsed}`);
      console.log(`  position ${formatUnits(p0[0], desk.baseDecimals)} -> ${formatUnits(p1[0], desk.baseDecimals)}  ${p1[0] === BigInt(0) ? "FLAT — a fill-or-kill close DOES work on this venue" : "still open"}`);
    }
    // Take the margin back out.
    const WD = parseAbi(["function getWithdrawableCollateral(address) view returns (uint256)"]);
    const w = await pub.readContract({ address: bank, abi: WD, functionName: "getWithdrawableCollateral", args: [container] }) as bigint;
    console.log(`  withdrawable margin ${formatUnits(w, 18)}`);
    if (w > BigInt(0)) {
      const data = ("0x2e1a7d4d" + w.toString(16).padStart(64, "0")) as `0x${string}`; // withdraw(uint256)
      try {
        const h = await op.writeContract({ address: container, abi: PROBE_ABI, functionName: "exec", args: [bank, data, BigInt(0)] });
        const r = await pub.waitForTransactionReceipt({ hash: h });
        console.log(`  margin withdrawn: status=${r.status}`);
      } catch (e: any) { console.log(`  withdraw refused: ${(e.shortMessage ?? e.message).split("\n")[0]}`); }
    }
    return;
  }

  if (stage === "recover") {
    const v = await venueOf(m.external.poolWeth as `0x${string}`);
    for (const t of [usdso, v.base]) {
      const h = await op.writeContract({ address: container, abi: PROBE_ABI, functionName: "sweep", args: [t, op.account.address] });
      await pub.waitForTransactionReceipt({ hash: h });
    }
    if (await pub.getBalance({ address: container }) > BigInt(0)) {
      const h = await op.writeContract({ address: container, abi: PROBE_ABI, functionName: "sweepNative", args: [op.account.address] });
      await pub.waitForTransactionReceipt({ hash: h });
    }
    console.log("everything recovered from the container");
    return;
  }

  console.log("set STAGE to deploy | buy | sell | native | events | recover");
}

main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exit(1); });
