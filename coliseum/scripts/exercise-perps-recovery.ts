// ============================================================================
// exercise-perps-recovery — run the four owner rescue paths against the real
// venue, because none of them had ever been run for real.
//
// These exist for a day nobody has had yet: an account that will not flatten,
// collateral stuck behind a position, a token sent somewhere it does not belong.
// Every one of them was written, unit-tested, and then never fired at the actual
// chain — which is the same as untested, for anything that only matters when
// something has already gone wrong.
//
// A real liquidation cannot be arranged to order. The surface can still be
// exercised: close a live position by hand, take back what the bank will
// release, and push a stray token through both sweeps.
//
//   STEP=forceclose  DUEL=55 pnpm exec hardhat run scripts/exercise-perps-recovery.ts --network somnia
//   STEP=sweeps      pnpm exec hardhat run scripts/exercise-perps-recovery.ts --network somnia
//   STEP=rescue      ACCOUNT=0x… pnpm exec hardhat run scripts/exercise-perps-recovery.ts --network somnia
//
// forceclose FLATTENS A FIGHTER MID-FIGHT and will distort that duel's result.
// Only point it at a throwaway fight.
// ============================================================================
import hre from "hardhat";
import { formatUnits, parseAbi } from "viem";
import fs from "fs";
import path from "path";

const REG_ABI = parseAbi([
  "function forceClose(address,address,bool,uint256,uint256) returns (bool,uint128)",
  "function rescueAccount(address) returns (uint256)",
  "function sweepAccountToken(address,address,address) returns (uint256)",
  "function sweepStray(address,address) returns (uint256)",
  "function accountOf(uint256,uint8) view returns (address)",
  "function accountCount() view returns (uint256)",
  "function accountAt(uint256) view returns (address)",
  "function freeMarginOf(address) view returns (uint256)",
  "function floatBalance() view returns (uint256)",
]);
const BANK_ABI = parseAbi([
  "function getPosition(address,address) view returns (int256,uint256,uint256,uint256)",
]);
const DESK_ABI = parseAbi(["function market() view returns (address)"]);
const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
]);
const POOL_ABI = parseAbi([
  "function getBookLevels(bool,uint64) view returns ((uint256 price,uint256 quantity)[])",
  // Perp books name their parameters differently from spot pools — a spot
  // getPoolParams call on one of these reverts.
  "function getOrderBookParameters() view returns (uint256 tickSize,uint256 minQuantity,uint256 lotSize)",
]);

async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"));
  const reg = m.contracts.PerpDesks.registry as `0x${string}`;
  const bank = m.contracts.PerpDesks.marginBank as `0x${string}`;
  const desks = m.contracts.PerpDesks.desks as { market: string; desk: string; perpPool: string; baseDecimals: number }[];
  const weth = "0xC0341325A034B0Cd6b1F3f1470a4c6e0B9E1a0f2"; // replaced below from the pool

  const pub = await hre.viem.getPublicClient();
  const [op] = await hre.viem.getWalletClients();
  const step = (process.env.STEP || "").toLowerCase();

  // Resolve each desk to the market address the bank actually keys positions by.
  // The desk is NOT the market — reading the bank with the desk address is what
  // made a live position read as FLAT on the scoreboard.
  const markets: { name: string; market: `0x${string}`; pool: `0x${string}`; dec: number }[] = [];
  for (const d of desks) {
    try {
      const mk = await pub.readContract({ address: d.desk as `0x${string}`, abi: DESK_ABI, functionName: "market" });
      markets.push({ name: d.market, market: mk as `0x${string}`, pool: d.perpPool as `0x${string}`, dec: d.baseDecimals });
    } catch { /* a desk that will not name its market is skipped, not fatal */ }
  }

  if (step === "forceclose") {
    const duelId = BigInt(process.env.DUEL || "0");
    if (duelId === BigInt(0)) throw new Error("DUEL is required");

    for (const fid of [0, 1]) {
      const acct = await pub.readContract({ address: reg, abi: REG_ABI, functionName: "accountOf", args: [duelId, fid] }) as `0x${string}`;
      if (acct === "0x0000000000000000000000000000000000000000") { console.log(`fighter ${fid}: no account`); continue; }
      for (const mk of markets) {
        const p = await pub.readContract({ address: bank, abi: BANK_ABI, functionName: "getPosition", args: [acct, mk.market] }) as readonly [bigint, bigint, bigint, bigint];
        const size = p[0];
        if (size === BigInt(0)) continue;
        const isLong = size > BigInt(0);
        const qty = isLong ? size : -size;
        console.log(`\nfighter ${fid} ${acct}`);
        console.log(`  holds ${isLong ? "LONG" : "SHORT"} ${formatUnits(qty, mk.dec)} of ${mk.name}`);

        // Cross the book hard in the closing direction. A rescue is allowed to pay
        // for certainty — the point is that it leaves, not that it leaves cheaply.
        const closeIsBid = !isLong;
        // Read the side we have to CROSS, not the side we are joining. `false` asks
        // for the offers a buyer takes, `true` for the bids a seller takes — getting
        // this backwards prices the order on the wrong side of the spread, and the
        // fill-or-cancel then finds nobody and quietly cancels. That reads exactly
        // like "the rescue does not work", and it cost a first attempt here.
        const levels = await pub.readContract({ address: mk.pool, abi: POOL_ABI, functionName: "getBookLevels", args: [!closeIsBid, BigInt(1)] }) as readonly { price: bigint }[];
        if (levels.length === 0) { console.log("  nobody on the other side — cannot close right now"); continue; }
        // A price has to land ON a tick. An unaligned one is refused outright, with
        // no hint that alignment was the problem — it looks like the whole rescue is
        // broken. Ten ticks through is what the perps probe uses and it crosses.
        const obp = await pub.readContract({ address: mk.pool, abi: POOL_ABI, functionName: "getOrderBookParameters" }) as readonly [bigint, bigint, bigint];
        const tick = obp[0];
        // Two hundred ticks through, not ten. This order is all-or-nothing on a book
        // that moves every block, so a price that merely touches the best quote is
        // stale by the time the transaction lands and the whole thing cancels. A
        // rescue is allowed to pay for certainty — the point is that the position
        // leaves, not that it leaves at a good price.
        const THROUGH = BigInt(200);
        const price = closeIsBid ? levels[0].price + THROUGH * tick : levels[0].price - THROUGH * tick;
        console.log(`  crossing the ${closeIsBid ? "offers" : "bids"}, best ${formatUnits(levels[0].price, 18)}, tick ${formatUnits(tick, 18)}`);
        console.log(`  forceClose ${closeIsBid ? "BUY" : "SELL"} ${formatUnits(qty, mk.dec)} at ${formatUnits(price, 18)}`);

        // Ask first whether the venue would take it. forceClose does NOT revert on a
        // refused order — it records ok=false — so without this a cancelled order and
        // a filled one look identical from the receipt.
        // forceClose does NOT revert when the venue declines — it records the refusal
        // and returns. So a receipt saying "success" proves only that the call ran.
        // The flag in the recorded event is the only honest answer, and it is the
        // LAST word of that event's data.
        let r: any = null; let hash: any = null; let filled = false;
        for (let attempt = 1; attempt <= 4 && !filled; attempt++) {
          hash = await op.writeContract({ address: reg, abi: REG_ABI, functionName: "forceClose", args: [acct, mk.market, closeIsBid, price, qty] });
          r = await pub.waitForTransactionReceipt({ hash });
          const ev = r.logs.find((l: any) => l.address.toLowerCase() === reg.toLowerCase());
          const okFlag = ev ? BigInt("0x" + ev.data.slice(2).slice(-64)) !== BigInt(0) : false;
          filled = okFlag;
          console.log(`  attempt ${attempt}: tx ${hash} gas=${r.gasUsed} — the venue ${okFlag ? "TOOK it" : "declined"}`);
        }

        // The fighter is still playing while this runs, so a position read the
        // instant after the rescue can already include a fresh buy of its own.
        // Report the fill from the receipt, and the position both now and after a
        // short pause, so a re-opened position is not mistaken for a failed close.
        console.log(`  logs in the rescue tx: ${r.logs.length}`);
        const after = await pub.readContract({ address: bank, abi: BANK_ABI, functionName: "getPosition", args: [acct, mk.market] }) as readonly [bigint, bigint, bigint, bigint];
        console.log(`  position ${formatUnits(size, mk.dec)} -> ${formatUnits(after[0], mk.dec)}  ${after[0] === BigInt(0) ? "FLAT — forceClose works against the real venue" : "still open; the book did not take the whole size"}`);
        return;
      }
      console.log(`fighter ${fid} ${acct}: flat in every market`);
    }
    return;
  }

  if (step === "sweeps") {
    // A stray token is the honest test: send a real non-collateral token where it
    // does not belong, then get it back out. WETH left over from the billing probe
    // is exactly such a token.
    const wethAddr = (await pub.readContract({
      address: m.external.poolWeth as `0x${string}`,
      abi: parseAbi(["function getPoolParams() view returns (address,address,uint256,uint256,uint256,uint256,uint256)"]),
      functionName: "getPoolParams",
    }) as readonly unknown[])[0] as `0x${string}`;
    const dec = Number(await pub.readContract({ address: wethAddr, abi: ERC20, functionName: "decimals" }));
    const held = await pub.readContract({ address: wethAddr, abi: ERC20, functionName: "balanceOf", args: [op.account.address] }) as bigint;
    console.log(`stray token ${wethAddr}, operator holds ${formatUnits(held, dec)}`);
    if (held === BigInt(0)) { console.log("nothing to send — run probe-direct-billing first to acquire some"); return; }
    const half = held / BigInt(2);
    if (half === BigInt(0)) { console.log("too little to split across both sweeps"); return; }

    // ── sweepStray: a token sitting on the registry itself ────────────────────
    let h = await op.writeContract({ address: wethAddr, abi: ERC20, functionName: "transfer", args: [reg, half] });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(`\nsent ${formatUnits(half, dec)} to the registry`);
    h = await op.writeContract({ address: reg, abi: REG_ABI, functionName: "sweepStray", args: [wethAddr, op.account.address] });
    let r = await pub.waitForTransactionReceipt({ hash: h });
    const regLeft = await pub.readContract({ address: wethAddr, abi: ERC20, functionName: "balanceOf", args: [reg] }) as bigint;
    console.log(`  sweepStray tx ${h} status=${r.status}  registry now holds ${formatUnits(regLeft, dec)}  ${regLeft === BigInt(0) ? "RECOVERED" : "STILL STUCK"}`);

    // ── sweepAccountToken: a token sitting on one of the child accounts ───────
    const n = Number(await pub.readContract({ address: reg, abi: REG_ABI, functionName: "accountCount" }));
    const child = await pub.readContract({ address: reg, abi: REG_ABI, functionName: "accountAt", args: [BigInt(n - 1)] }) as `0x${string}`;
    const rest = await pub.readContract({ address: wethAddr, abi: ERC20, functionName: "balanceOf", args: [op.account.address] }) as bigint;
    h = await op.writeContract({ address: wethAddr, abi: ERC20, functionName: "transfer", args: [child, rest] });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(`\nsent ${formatUnits(rest, dec)} to child account ${child}`);
    h = await op.writeContract({ address: reg, abi: REG_ABI, functionName: "sweepAccountToken", args: [child, wethAddr, op.account.address] });
    r = await pub.waitForTransactionReceipt({ hash: h });
    const childLeft = await pub.readContract({ address: wethAddr, abi: ERC20, functionName: "balanceOf", args: [child] }) as bigint;
    console.log(`  sweepAccountToken tx ${h} status=${r.status}  account now holds ${formatUnits(childLeft, dec)}  ${childLeft === BigInt(0) ? "RECOVERED" : "STILL STUCK"}`);
    console.log(`\noperator holds ${formatUnits(await pub.readContract({ address: wethAddr, abi: ERC20, functionName: "balanceOf", args: [op.account.address] }) as bigint, dec)} again`);
    return;
  }

  if (step === "rescue") {
    const acct = (process.env.ACCOUNT || "") as `0x${string}`;
    if (!acct) throw new Error("ACCOUNT is required");
    const floatBefore = await pub.readContract({ address: reg, abi: REG_ABI, functionName: "floatBalance" }) as bigint;
    const freeBefore = await pub.readContract({ address: reg, abi: REG_ABI, functionName: "freeMarginOf", args: [acct] }) as bigint;
    console.log(`account ${acct}\n  free margin ${formatUnits(freeBefore, 18)}\n  float       ${formatUnits(floatBefore, 18)}`);
    const h = await op.writeContract({ address: reg, abi: REG_ABI, functionName: "rescueAccount", args: [acct] });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    const floatAfter = await pub.readContract({ address: reg, abi: REG_ABI, functionName: "floatBalance" }) as bigint;
    console.log(`  tx ${h} status=${r.status} gas=${r.gasUsed}`);
    console.log(`  float ${formatUnits(floatBefore, 18)} -> ${formatUnits(floatAfter, 18)}  (recovered ${formatUnits(floatAfter - floatBefore, 18)})`);
    return;
  }

  console.log("set STEP to forceclose | sweeps | rescue");
}

main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exit(1); });
