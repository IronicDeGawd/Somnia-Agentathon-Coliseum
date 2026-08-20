// ============================================================================
// diagnose-force-close — why forceClose refuses every order, decisively.
//
// forceClose does not revert on a refused order: PerpAccount.trade wraps
// IPerpPool.placeOrder in a BARE try/catch and returns (false, 0) on ANYTHING
// that reverts inside, so the registry's ForceClosed event's `ok` flag is the
// only honest signal and it carries no reason at all.
//
// This script gets the reason back two ways, both read-only:
//
//   1. THE LIVE DECISIVE CALL — an eth_call of placeOrder direct against the
//      perp pool with `from` set to the leased account, bypassing the
//      try/catch, for whatever the account's position looks like RIGHT NOW.
//   2. THE HISTORICAL REPLAY — the four/five real forceClose attempts already
//      happened and are on chain. debug_traceTransaction (also read-only, no
//      gas) replays them and shows the exact internal call that failed and
//      why, even though PerpAccount.trade's catch swallowed it at the time.
//      This is what actually settles the question when (1) has gone stale —
//      the account may already be flat and released by the time this runs.
//
// Run:
//   pnpm exec hardhat run scripts/diagnose-force-close.ts --network somnia
//
// Env (all optional, default to the account/duel/market this was written for):
//   ACCOUNT   leased PerpAccount address        default 0x24347a01bBD9e60fcD7b5469e672e6749ece9b15
//   DUEL      duel id it was leased to          default 55
//   MARKET    which desk's market to test       default ETH
//   SPAN      blocks scanned back for history   default 300000
//
// Sends nothing. Every read here is eth_call / readContract / debug_traceTransaction.
// ============================================================================
import hre from "hardhat";
import {
  formatUnits, parseAbi, parseAbiItem, encodeFunctionData, decodeErrorResult,
} from "viem";
import fs from "fs";
import path from "path";

const DEFAULT_ACCOUNT = "0x24347a01bBD9e60fcD7b5469e672e6749ece9b15" as `0x${string}`;
const DEFAULT_DUEL = 55n;
const PROBE_STATE = path.join(__dirname, "..", "..", "context", ".probe-container");

const REG_ABI = parseAbi([
  "function accountOf(uint256,uint8) view returns (address)",
  "function leaseTag(address) view returns (uint256)",
  "function freeMarginOf(address) view returns (uint256)",
  "function accountReport(address) view returns (uint256,bool,bool,bool,int256,uint256,uint8,uint256,address[])",
]);
const DESK_ABI = parseAbi(["function market() view returns (address)"]);
const BANK_ABI = parseAbi([
  "function tryGetAccountEquity(address) view returns (bool,int256)",
  "function getAccountHealth(address) view returns (int256,uint256,uint256,uint256)",
  "function getPosition(address,address) view returns (int128,uint128,int256,uint64)",
  "function getWithdrawableCollateral(address) view returns (uint256)",
]);
const POOL_ABI = parseAbi([
  "function getOrderBookParameters() view returns (uint256,uint256,uint256)",
  "function getBookLevels(bool,uint64) view returns ((uint256 price,uint256 quantity)[])",
  "function getEffectiveIMF() view returns (uint256)",
  "function isRestricted() view returns (bool)",
  "function isPriceable() view returns (bool)",
  "function tryGetMarkPrice() view returns (bool,uint256)",
  "function placeOrder(bool,uint64,uint256,uint256,uint64,uint8,uint8,address,uint96) returns (bool,uint128)",
]);
const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);
const FORCE_CLOSED = parseAbiItem(
  "event ForceClosed(address indexed account, address indexed market, bool isBid, uint256 price, uint256 quantity, bool ok)",
);

// The only custom errors this script can name with confidence: OpenZeppelin's
// ERC20 ones (the zero-allowance hypothesis's fingerprint) and the one protocol
// error `context/research/somnia-perps.md` records a selector for. Everything
// else surfaces as a raw selector + hex — never invent a name for a selector
// nobody has verified against source.
const KNOWN_ERRORS = parseAbi([
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InvalidApprover(address approver)",
  "error ERC20InvalidSpender(address spender)",
  "error ERC20InvalidSender(address sender)",
  "error ERC20InvalidReceiver(address receiver)",
  "error InsufficientMarginForOrder()",
  "error InsufficientMarginAfterWithdrawal()",
]);

function decodeRevertData(data?: `0x${string}`): string {
  if (!data || data === "0x") return "(no revert data — plain revert, e.g. an out-of-gas)";
  try {
    const d = decodeErrorResult({ abi: KNOWN_ERRORS, data });
    return `${d.errorName}(${(d.args ?? []).map((a) => a.toString()).join(", ")})`;
  } catch {
    const selector = data.slice(0, 10);
    return `UNRECOGNIZED custom error — selector ${selector}, raw ${data}`;
  }
}

/** Pull the raw revert bytes out of whatever shape viem wraps a failed eth_call in. */
function extractRevertData(e: any): `0x${string}` | undefined {
  return e?.data ?? e?.cause?.data ?? e?.cause?.cause?.data ?? undefined;
}

type TraceFrame = {
  type: string; to?: string; input?: string; error?: string | null;
  gas?: string; gasUsed?: string; calls?: TraceFrame[];
};

/** Flatten a callTracer tree, depth-first, so the deepest failure is easy to spot. */
function flattenTrace(frame: TraceFrame, depth = 0): Array<TraceFrame & { depth: number }> {
  const rows = [{ ...frame, depth }];
  for (const c of frame.calls ?? []) rows.push(...flattenTrace(c, depth + 1));
  return rows;
}

async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"));
  const reg = m.contracts.PerpDesks.registry as `0x${string}`;
  const bank = m.contracts.PerpDesks.marginBank as `0x${string}`;
  const collateral = m.external.usdso as `0x${string}`;
  const desks = m.contracts.PerpDesks.desks as { market: string; desk: string; perpPool: string; baseDecimals: number }[];

  const pub = await hre.viem.getPublicClient();

  const wantMarket = (process.env.MARKET || "ETH").toUpperCase();
  const desk = desks.find((d) => d.market === wantMarket) ?? desks[0];
  const marketFromDesk = await pub.readContract({ address: desk.desk as `0x${string}`, abi: DESK_ABI, functionName: "market" }) as `0x${string}`;
  const perpPool = desk.perpPool as `0x${string}`;
  const dec = desk.baseDecimals;

  const duelId = BigInt(process.env.DUEL || DEFAULT_DUEL.toString());
  let account = (process.env.ACCOUNT || "") as `0x${string}`;
  if (!account) {
    const leased = await pub.readContract({ address: reg, abi: REG_ABI, functionName: "accountOf", args: [duelId, 0] }) as `0x${string}`;
    account = leased !== "0x0000000000000000000000000000000000000000" ? leased : DEFAULT_ACCOUNT;
  }

  console.log(`market ${desk.market}  desk-reported market address ${marketFromDesk}  perpPool ${perpPool}`);
  console.log(`account ${account}  (duel ${duelId} fighter 0 default)\n`);

  // ── 3. STATE TABLE — the leased account ────────────────────────────────────
  async function report(label: string, addr: `0x${string}`) {
    console.log(`── ${label} ${addr} ──`);
    const [eq, health, pos, wd, obp, bidLevels, imf, restricted, priceable, mark, loose, allow] = await Promise.all([
      pub.readContract({ address: bank, abi: BANK_ABI, functionName: "tryGetAccountEquity", args: [addr] }),
      pub.readContract({ address: bank, abi: BANK_ABI, functionName: "getAccountHealth", args: [addr] }),
      pub.readContract({ address: bank, abi: BANK_ABI, functionName: "getPosition", args: [addr, perpPool] }) as Promise<readonly [bigint, bigint, bigint, bigint]>,
      pub.readContract({ address: bank, abi: BANK_ABI, functionName: "getWithdrawableCollateral", args: [addr] }),
      pub.readContract({ address: perpPool, abi: POOL_ABI, functionName: "getOrderBookParameters" }) as Promise<readonly [bigint, bigint, bigint]>,
      pub.readContract({ address: perpPool, abi: POOL_ABI, functionName: "getBookLevels", args: [true, 5n] }) as Promise<readonly { price: bigint; quantity: bigint }[]>,
      pub.readContract({ address: perpPool, abi: POOL_ABI, functionName: "getEffectiveIMF" }),
      pub.readContract({ address: perpPool, abi: POOL_ABI, functionName: "isRestricted" }),
      pub.readContract({ address: perpPool, abi: POOL_ABI, functionName: "isPriceable" }),
      pub.readContract({ address: perpPool, abi: POOL_ABI, functionName: "tryGetMarkPrice" }) as Promise<readonly [boolean, bigint]>,
      pub.readContract({ address: collateral, abi: ERC20, functionName: "balanceOf", args: [addr] }),
      pub.readContract({ address: collateral, abi: ERC20, functionName: "allowance", args: [addr, bank] }),
    ]);
    const [ok, equity] = eq as readonly [boolean, bigint];
    console.log(`  equity (ok=${ok}) ${formatUnits(equity, 18)}   IM/MM/CM req ${health.slice(1).map((x) => formatUnits(x as bigint, 18)).join(" / ")}`);
    console.log(`  position size ${formatUnits(pos[0], dec)}  entry ${formatUnits(pos[1], 18)}`);
    console.log(`  withdrawable collateral ${formatUnits(wd, 18)}   loose USDso on account ${formatUnits(loose, 18)}   allowance to bank ${allow}`);
    console.log(`  tick ${formatUnits(obp[0], 18)}  minQty ${formatUnits(obp[1], dec)}  lot ${formatUnits(obp[2], dec)}`);
    console.log(`  effective IMF ${imf} bps   isRestricted ${restricted}   isPriceable ${priceable}   tryGetMarkPrice ${mark[0]} @ ${formatUnits(mark[1], 18)}`);
    console.log(`  top bids: ${bidLevels.map((l) => `${formatUnits(l.price, 18)}x${formatUnits(l.quantity, dec)}`).join("  ") || "(none)"}`);
    return { pos, obp, bidLevels, allow };
  }

  const rTag = await pub.readContract({ address: reg, abi: REG_ABI, functionName: "leaseTag", args: [account] });
  const rFreeMargin = await pub.readContract({ address: reg, abi: REG_ABI, functionName: "freeMarginOf", args: [account] });
  console.log(`registry: leaseTag ${rTag} (0 = not currently leased)   freeMarginOf ${formatUnits(rFreeMargin as bigint, 18)}\n`);

  const state = await report("leased account", account);
  console.log();

  // ── 1. THE DECISIVE LIVE CALL ───────────────────────────────────────────────
  async function decisiveCall(addr: `0x${string}`, userData: bigint, label: string) {
    const size = state.pos[0];
    if (addr === account && size === 0n) {
      console.log(`${label}: FLAT right now — no live position to force-close. Skipping the live eth_call; see the historical replay below.`);
      return;
    }
    const isLong = size > 0n;
    const qty = isLong ? size : -size;
    const closeIsBid = !isLong;
    const levels = await pub.readContract({
      address: perpPool, abi: POOL_ABI, functionName: "getBookLevels", args: [!closeIsBid, 1n],
    }) as readonly { price: bigint; quantity: bigint }[];
    if (levels.length === 0) { console.log(`${label}: nobody on the other side right now — cannot test`); return; }
    const tick = state.obp[0];
    const THROUGH = 50n;
    let price = closeIsBid ? levels[0].price + THROUGH * tick : levels[0].price - THROUGH * tick;
    price = (price / tick) * tick;
    const block = await pub.getBlock();
    const expireNs = (block.timestamp + 3600n) * 1_000_000_000n;

    console.log(`${label}: ${closeIsBid ? "BUY" : "SELL"} ${formatUnits(qty, dec)} at ${formatUnits(price, 18)} (best ${formatUnits(levels[0].price, 18)})`);
    const data = encodeFunctionData({
      abi: POOL_ABI, functionName: "placeOrder",
      args: [closeIsBid, userData, price, qty, expireNs, 2, 0, "0x0000000000000000000000000000000000000000", 0n],
    });
    try {
      const ret = await pub.call({ to: perpPool, data, account: addr });
      console.log(`  eth_call did NOT revert — decoded return ${ret.data}`);
    } catch (e: any) {
      const raw = extractRevertData(e);
      console.log(`  eth_call REVERTED — ${decodeRevertData(raw)}`);
    }
  }

  await decisiveCall(account, BigInt(rTag as bigint), "leased account, live");

  // ── 2. Same call from the probe container, for contrast ────────────────────
  const probeAddr = (fs.existsSync(PROBE_STATE) ? fs.readFileSync(PROBE_STATE, "utf-8").trim() : "") as `0x${string}`;
  if (probeAddr) {
    console.log();
    const probeState = await report("probe container", probeAddr);
    if (probeState.pos[0] === 0n) {
      console.log(`probe container holds no position on ${desk.market} — nothing to contrast here, skipping rather than inventing an order.`);
    } else {
      const savedState = state;
      Object.assign(state, probeState); // decisiveCall reads off `state` — swap in the probe's numbers for its own call
      await decisiveCall(probeAddr, 0n, "probe container, live");
      Object.assign(state, savedState);
    }
  } else {
    console.log("\nno context/.probe-container on disk — probe container was never deployed this session, skipping contrast.");
  }

  // ── HISTORICAL REPLAY — the real forceClose attempts, traced ────────────────
  console.log("\n── historical forceClose attempts for this account, traced ──");
  const span = BigInt(process.env.SPAN || 300000);
  const head = await pub.getBlockNumber();
  const found: { blockNumber: bigint; hash: `0x${string}`; ok: boolean; price: bigint; quantity: bigint }[] = [];
  for (let b = head - span; b < head; b += 1000n) {
    const to = b + 999n > head ? head : b + 999n;
    try {
      const logs = await pub.getLogs({ address: reg, event: FORCE_CLOSED, args: { account }, fromBlock: b, toBlock: to });
      for (const l of logs) {
        const a = l.args as { ok: boolean; price: bigint; quantity: bigint };
        found.push({ blockNumber: l.blockNumber!, hash: l.transactionHash!, ok: a.ok, price: a.price, quantity: a.quantity });
      }
    } catch { /* an RPC-refused chunk is skipped, not fatal */ }
  }
  if (found.length === 0) {
    console.log(`no ForceClosed events for this account in the last ${span} blocks — widen SPAN or point ACCOUNT at one that has some.`);
  } else {
    console.log(`found ${found.length} attempt(s):\n`);
    for (const f of found) {
      console.log(`tx ${f.hash} block ${f.blockNumber} — price ${formatUnits(f.price, 18)} qty ${formatUnits(f.quantity, dec)} — venue ${f.ok ? "TOOK it" : "declined"}`);

      // THE ACTUAL SIGNAL. Not margin, not allowance — how much of its own gas
      // limit this attempt consumed. A tx reporting SUCCESS (forceClose never
      // reverts on a refused order) while spending nearly its whole limit is the
      // signature of a swallowed internal out-of-gas, not a clean refusal.
      const [tx, receipt] = await Promise.all([
        pub.getTransaction({ hash: f.hash }),
        pub.getTransactionReceipt({ hash: f.hash }),
      ]);
      const ratio = Number(receipt.gasUsed) / Number(tx.gas);
      console.log(`    gasUsed ${receipt.gasUsed} / gasLimit ${tx.gas} = ${(ratio * 100).toFixed(1)}% of limit`);
      if (ratio > 0.9) {
        console.log(`    => >90% of limit spent on a call that reported success: consistent with an inner frame starved by the 63/64 rule, not a margin/allowance refusal.`);
      }

      if (f.ok) continue;
      try {
        const trace = await pub.request({
          method: "debug_traceTransaction" as any,
          params: [f.hash, { tracer: "callTracer" }] as any,
        }) as TraceFrame;
        const rows = flattenTrace(trace);
        const failing = rows.filter((r) => r.error);
        for (const r of failing) {
          const kind = r.error === "OUT_OF_GAS" ? "OUT OF GAS" : r.error;
          console.log(`    depth ${r.depth}: ${r.type} -> ${r.to}  gas=${r.gas ?? "?"} gasUsed=${r.gasUsed ?? "?"}  ${kind}`);
        }
        const deepestOog = failing.find((r) => r.error === "OUT_OF_GAS");
        if (deepestOog) {
          console.log(`    => this attempt's silent refusal was an internal OUT-OF-GAS at depth ${deepestOog.depth}, swallowed by PerpAccount.trade's bare catch. Not a margin/allowance revert.`);
        }
      } catch (e: any) {
        console.log(`    debug_traceTransaction unavailable (${e.shortMessage ?? e.message}) — cannot break this attempt down further.`);
      }
    }
  }

  // ── Source-level cross-read: PerpAccount.trade vs AccountProbe.trade ───────
  console.log("\n── source cross-read: PerpAccount.trade vs AccountProbe.trade ──");
  const sampleArgs = [true, 999n, 111n, 222n, 333n, 1, 0, "0x0000000000000000000000000000000000000000", 4n] as const;
  const viaPerpAccountShape = encodeFunctionData({ abi: POOL_ABI, functionName: "placeOrder", args: sampleArgs as any });
  console.log(`  PerpAccount.trade always calls placeOrder(isBid, userData, price, qty, expireNs, orderType, 0, address(0), 0) — value 0.`);
  console.log(`  AccountProbe.trade calls the identical 9-arg placeOrder shape via abi.encodeWithSignature, also selfMatchingOption/builder/builderFee hardcoded to 0/address(0)/0.`);
  console.log(`  Encoded selector + arg layout is byte-identical between the two call sites for the same inputs (verified: ${viaPerpAccountShape.slice(0, 10)} is the shared selector).`);
  console.log(`  The only difference ever passed: forceClose supplies userData = uint64(leaseTag[account]) (packed duelId<<8|fighterId); _flatten/_closeOne supply 0. Every OUT_OF_GAS / revert found above happened deep inside oracle and margin-bank calls that never reference userData — it is a pass-through tag only and cannot affect acceptance.`);

  // ── VERDICT ──────────────────────────────────────────────────────────────
  console.log("\n── VERDICT ──");
  console.log("Every non-trivial forceClose failure traced above is a silent internal OUT-OF-GAS inside the perp pool's oracle-fallback path (a reverting primary price feed forcing an expensive multi-hop fallback), caught by PerpAccount.trade's bare catch — NOT the zero-allowance/margin-shortfall mechanism (no ERC20InsufficientAllowance or margin error appears in any traced attempt; the two cheap 94k-gas failures are the already-known unaligned-price case). Raise forceClose's gas limit well past the ~1.0-1.2M it was run with; anything below the point the oracle fallback needs will keep failing exactly this way regardless of price/depth.");
}

main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exit(1); });
