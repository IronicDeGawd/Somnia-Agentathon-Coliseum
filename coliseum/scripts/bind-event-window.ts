// ============================================================================
// bind-event-window — point three idle EventDesks at live prediction windows and
// register all three of Arena's slots as questions.
//
// The SOMI coin book used to keep the third slot. It was dropped because on this
// market it had become the expensive one: a smallest SOMI order costs about nine
// cents against a third of a cent for a question, so a single coin slot was 99%
// of an events fight's whole deposit. Real coin trading lives in the spot game.
//
// Every fight records its own market set, so re-pointing the desks between fights
// cannot disturb a fight already running.
//
// Run:
//   pnpm exec hardhat run scripts/bind-event-window.ts --network somnia
//
// Env:
//   MIN_LIFE_SEC — window must outlive this, in seconds (default 1200).
//   INTERVALS    — preferred window lengths in minutes (default "60,240").
//                  Among these, the window priced NEAREST EVEN MONEY wins — see
//                  the note on pickWindow for why that beats picking by length.
//   INTERVALS    — see above; three DISTINCT questions are bound, so at least
//                  three (asset, window-length) pairs must be available.
//   FALLBACK_INTERVALS — lengths used only to fill slots the preferred lengths
//                  could not (default "1440"). Set empty to refuse the reserve.
//   FUND_EACH    — collateral per desk, whole tokens; default from the manifest.
//   RELEASE      — set to 1 to mark every desk free and exit, without binding.
//   FORCE        — set to 1 to rebind even while the current questions are
//                  healthy. Without it the script exits early in that case, so
//                  it is safe to run on a schedule.
//   FACTORY      — override the venue whose windows we consider. Normally read
//                  from contracts.EventDesks.factory in the manifest; there is no
//                  default, because scanning every venue on the chain is how a
//                  desk ends up bound to somebody else's market.
// ============================================================================

import hre from "hardhat";
import { formatUnits, parseAbi, parseAbiItem } from "viem";
import fs from "fs";
import path from "path";

const MARKET_CREATED = parseAbiItem(
  "event MarketCreated(bytes32 indexed marketId, address indexed market, address indexed pool, uint256 yesId, uint256 noId, address collateral, string asset, uint256 strike, uint64 tradingStart, uint64 expiry, uint256 oracleQuestionId, string question, uint64 intervalSec)",
);

// Windows are only ever published in this log — the pool cannot be asked which
// market it is, and without the id a settled position can never be claimed.
// The indexer is unreliable, so the logs are read directly.
const SCAN_CHUNKS = 200;
const CHUNK = 1000n;

/// A slot's question in a few characters. It becomes part of the action name the
/// model answers with, so it must contain no spaces and no digits.
const label = (s: string) =>
  ("0x" + Buffer.from(s, "ascii").toString("hex").padEnd(16, "0")) as `0x${string}`;

type Window = {
  asset: string; pool: `0x${string}`; marketId: `0x${string}`;
  expiry: number; intervalSec: number; collateral: `0x${string}`;
};

async function main() {
  const manifestPath = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const ev = manifest.contracts.EventDesks;
  if (!ev) throw new Error("no contracts.EventDesks in the manifest — run deploy-event-desks.ts first");

  const pub = await hre.viem.getPublicClient();
  const arena = await hre.viem.getContractAt("Arena", manifest.contracts.Arena.address);
  const treasury = await hre.viem.getContractAt("EventTreasury", ev.treasury);
  const desks = await Promise.all(
    (ev.desks as `0x${string}`[]).map((d) => hre.viem.getContractAt("EventDesk", d)),
  );

  if (process.env.RELEASE === "1") {
    for (const desk of desks) {
      if (!(await desk.read.inUse())) continue;
      const hash = await desk.write.setInUse([false]);
      await pub.waitForTransactionReceipt({ hash });
      console.log(`released ${desk.address}`);
    }
    return;
  }

  // ── never compete with the referee for the same wallet ────────────────────
  //
  // Binding needs the Arena's owner, which is also the key the watcher sends
  // every turn from. Transactions from one address are strictly ordered, so two
  // senders racing on it get one of them rejected. The binder is the one that
  // can afford to wait: it runs on a schedule and the next run is minutes away,
  // whereas a missed turn stalls a live fight. It also has nothing to do during
  // a fight — desks in use are skipped anyway.
  const active = (await arena.read.getActiveDuelIds()) as bigint[];
  if (active.length > 0) {
    console.log(`${active.length} fight(s) running — leaving the owner key to the watcher`);
    return;
  }

  // ── nothing to do while the current questions are still alive ────────────
  //
  // This runs on a schedule, so most of the time it finds a perfectly healthy
  // set of slots. Re-pointing them anyway would move collateral into a new
  // market every quarter of an hour for no gain, and would swap the question
  // out from under a player who read the lobby a moment ago. So: if all three
  // of Arena's slots still outlive a fight, do nothing and exit.
  //
  // FORCE=1 rebinds regardless — for picking a better-priced window by hand.
  const minLifeCheck = Number(process.env.MIN_LIFE_SEC ?? 1200);
  if (process.env.FORCE !== "1") {
    const bound = (ev.bound ?? []) as { label: string; desk: string; pool: string; expiry: number }[];
    const nowSec = Math.floor(Date.now() / 1000);
    const healthy = bound.filter((b) => b.expiry > nowSec + minLifeCheck);
    if (bound.length === 3 && healthy.length === 3) {
      const soonest = Math.min(...bound.map((b) => b.expiry)) - nowSec;
      console.log(
        `all three slots still open (${bound.map((b) => b.label).join(", ")}); ` +
        `soonest expires in ${Math.floor(soonest / 60)} min — nothing to do`,
      );
      return;
    }
    if (bound.length) {
      console.log(
        `rebinding: ${bound.length - healthy.length} of ${bound.length} slots have expired or are about to`,
      );
    }
  }

  // ── pick the windows ──────────────────────────────────────────────────────
  const minLife = Number(process.env.MIN_LIFE_SEC ?? 1200);
  const intervals = (process.env.INTERVALS ?? "60,240").split(",").map((s) => Number(s.trim()) * 60);
  // Lengths accepted only to fill a slot the preferred lengths could not.
  //
  // Measured over eleven hours of this venue: it publishes BTC and ETH and
  // nothing else, and three quarters of everything it makes is a fifteen-minute
  // question, which can never be used — a long fight would outlive it. That
  // leaves hourly and four-hourly as the whole usable supply: four
  // (asset, length) pairs for three slots, which is how the market ran dry.
  //
  // A daily question fixes the supply and costs some drama: over the fifteen
  // minutes of a fight, a question with a day to run barely moves. So it is a
  // reserve, not an equal — reached for only when the lively lengths cannot fill
  // three slots, and even then the nearest-even-money rule still decides which.
  const fallbackIntervals = (process.env.FALLBACK_INTERVALS ?? "1440")
    .split(",").filter(Boolean).map((s) => Number(s.trim()) * 60);
  const now = Math.floor(Date.now() / 1000);

  // Which venue's windows we will consider. Pinned, not discovered — see scanWindows.
  const factory = (process.env.FACTORY ?? ev.factory) as `0x${string}` | undefined;
  if (!factory) {
    throw new Error(
      "no contracts.EventDesks.factory in the manifest. It is the contract that publishes " +
      "MarketCreated for the venue we trade, and without it this script would scan every " +
      "venue on the chain and could bind a desk to another operator's market. Set it, or " +
      "pass FACTORY=0x… for a one-off run.",
    );
  }
  const alive = (await scanWindows(pub, factory, ev.collateral))
    .filter((w) => w.expiry > now + minLife);
  const live = alive.filter((w) => intervals.includes(w.intervalSec));
  const reserve = alive.filter((w) => fallbackIntervals.includes(w.intervalSec));

  /**
   * Choose the window priced NEAREST EVEN MONEY.
   *
   * The obvious rule — take the shortest window, its odds move more — is wrong,
   * and measurably so. A question drifts toward certainty as its deadline nears,
   * so a live hourly window part-way through its hour was quoting 0.014 while the
   * four-hour question on the same asset sat at 0.462. At 0.014 the answer is
   * effectively already known: the odds barely move, and a fighter offered it
   * declines every round, which is the right call and a dead fight.
   *
   * What makes a slot worth trading is that the answer is genuinely in doubt. So
   * pick on the price itself rather than on the window's length, and let the
   * length matter only through the requirement that it outlive the fight.
   */
  // Score every candidate once, then take the three most uncertain, never
  // repeating an (asset, window-length) pair — three copies of the same question
  // would give a fighter three ways to say the same thing.
  const score = async (ws: Window[]) => {
    const out = await Promise.all(ws.map(async (w) => ({ w, mid: await midPrice(pub, w.pool) })));
    return out.sort((a, b) => distanceFromEven(a.mid) - distanceFromEven(b.mid));
  };

  const chosen: { w: Window; mid: number | null; label: string }[] = [];
  const takenPairs = new Set<string>();
  const take = (cands: { w: Window; mid: number | null }[]) => {
    for (const cand of cands) {
      if (chosen.length === 3) return;
      const pair = `${cand.w.asset.toUpperCase()}:${cand.w.intervalSec}`;
      if (takenPairs.has(pair)) continue;
      takenPairs.add(pair);
      chosen.push({ ...cand, label: "" });
    }
  };

  take(await score(live));
  if (chosen.length < 3 && reserve.length) {
    const shortBy = 3 - chosen.length;
    take(await score(reserve));
    const used = chosen.length - (3 - shortBy);
    if (used > 0) {
      console.log(
        `only ${3 - shortBy} lively question(s) available — filled ${used} slot(s) from the ` +
        `longer-dated reserve, whose odds move less during a fight`,
      );
    }
  }
  if (chosen.length < 3) {
    const msg =
      `only ${chosen.length} distinct question(s) with >${minLife}s left; three slots need three. ` +
      `Widen INTERVALS or lower MIN_LIFE_SEC.`;
    // Running on a schedule, this is an ordinary condition rather than a fault:
    // the venue simply has not opened enough fresh windows yet. Leaving the
    // existing binding in place is strictly better than tearing it down, and
    // exiting loudly here would make a routine quiet period look like a broken
    // deployment. Fail only when there is nothing left standing to fall back on.
    const stillStanding = ((ev.bound ?? []) as { expiry: number }[])
      .filter((b) => b.expiry > Math.floor(Date.now() / 1000)).length;
    if (stillStanding > 0) {
      console.log(`${msg}\nKeeping the current binding — ${stillStanding} slot(s) still open.`);
      return;
    }
    throw new Error(msg);
  }

  // Name each slot. The label is what the fighter reads AND the word it answers
  // with, so it must be unique, spaceless and — critically — carry no digit: a
  // number in the prompt has already been echoed back and executed as a move.
  const horizonWord = (sec: number) => (sec <= 900 ? "SOON" : sec <= 3600 ? "HOUR" : "LATER");
  const usedLabels = new Set<string>();
  for (const c of chosen) {
    const asset = c.w.asset.toUpperCase();
    let name = `${asset}UP`;
    if (usedLabels.has(name)) name = `${asset}${horizonWord(c.w.intervalSec)}`;
    let n = 0;
    while (usedLabels.has(name)) name = `${asset}${horizonWord(c.w.intervalSec)}${"X".repeat(++n)}`;
    usedLabels.add(name);
    c.label = name.slice(0, 8);
  }

  for (const c of chosen) {
    console.log(
      `${c.label.padEnd(8)} ${c.w.asset} ${c.w.intervalSec / 60}min priced at ` +
      `${c.mid === null ? "no book" : c.mid.toFixed(3)}, ${c.w.expiry - now}s left  pool ${c.w.pool}`,
    );
  }

  // ── gather three desks: re-point the ones already in the Arena's slots ────
  //
  // The desks the Arena currently points at are exactly the ones whose questions
  // are being replaced, so they are the right ones to reuse. Taking a fresh trio
  // instead leaks desks: the old three stay claimed until their old windows
  // expire on their own, so a six-desk pool drains in two rebinds and the market
  // sits with a dead slot until the leftovers time out. That is what happened —
  // five of six desks held, one spare, and a slot that could not be refilled.
  //
  // A desk claimed but NOT in a slot is such a leftover. Since nothing is running
  // (checked at the top), hand it straight back rather than waiting it out.
  const registered = new Set<string>();
  for (const fn of ["EVENT_POOL_WETH", "EVENT_POOL_WBTC", "EVENT_POOL_SOMI"] as const) {
    try {
      const a = (await (arena.read as Record<string, () => Promise<unknown>>)[fn]()) as string;
      if (a && a !== "0x0000000000000000000000000000000000000000") registered.add(a.toLowerCase());
    } catch { /* slots not registered yet */ }
  }

  const reusable: typeof desks = [];
  const idle: typeof desks = [];
  for (const desk of desks) {
    const inSlot = registered.has(desk.address.toLowerCase());
    const claimed = (await desk.read.inUse()) as boolean;
    if (inSlot) { reusable.push(desk); continue; }
    if (!claimed) { idle.push(desk); continue; }
    const hash = await desk.write.setInUse([false]);
    await pub.waitForTransactionReceipt({ hash });
    idle.push(desk);
    console.log(`handed back ${desk.address} — claimed but not in a slot`);
  }

  // Reuse first, then spares. A reused desk is already claimed; setInUse(true)
  // below is idempotent, so the binding path does not need to know the difference.
  const free: typeof desks = [...reusable, ...idle];
  if (free.length < 3) {
    const msg =
      `only ${free.length} idle desk(s); the desks holding the last questions have not been ` +
      `handed back yet. Run with RELEASE=1 to force it.`;
    // Ordinary sequencing, not a fault: the watcher hands a desk back once its
    // own window has expired, and this runs on its own schedule, so it can
    // easily arrive in the seconds before that happens. The next run finds them
    // free. Fail loudly only when nothing is standing to fall back on.
    const stillStanding = ((ev.bound ?? []) as { expiry: number }[])
      .filter((b) => b.expiry > Math.floor(Date.now() / 1000)).length;
    if (stillStanding > 0) {
      console.log(`${msg}\nWaiting for the referee — ${stillStanding} slot(s) still open meanwhile.`);
      return;
    }
    throw new Error(msg);
  }

  const fundEach = BigInt(process.env.FUND_EACH ?? "0") * 10n ** 6n || BigInt(ev.fundEach ?? "50000000");
  const deskFor: `0x${string}`[] = [];

  for (const c of chosen) {
    const desk = free.shift()!;

    // A claimed desk refuses to be re-pointed — that guard is what stops a desk
    // moving under a live fight. Nothing is running (checked at the top), so a
    // desk being reused is released for the moment it takes to re-point it, then
    // claimed again below.
    if ((await desk.read.inUse()) as boolean) {
      const rel = await desk.write.setInUse([false]);
      await pub.waitForTransactionReceipt({ hash: rel });
    }

    // bind() retreats from any previous window first, collecting winnings and
    // pulling collateral back, so nothing is stranded in a pool nobody watches.
    let hash = await desk.write.bind([c.w.pool, c.w.marketId]);
    await pub.waitForTransactionReceipt({ hash });

    // Only now is there a vault to fund. Top up to the target rather than adding
    // blindly, so a desk carrying winnings from a previous window is not doubled.
    const held6 = ((await desk.read.getWithdrawableBalance([manifest.contracts.Arena.address, ev.collateral])) as bigint) / 10n ** 12n;
    if (held6 < fundEach) {
      hash = await treasury.write.fundDesk([desk.address, fundEach - held6]);
      await pub.waitForTransactionReceipt({ hash });
    }

    hash = await desk.write.setInUse([true]);
    await pub.waitForTransactionReceipt({ hash });

    const vault = (await desk.read.getWithdrawableBalance([manifest.contracts.Arena.address, ev.collateral])) as bigint;
    console.log(`${c.label} desk ${desk.address} bound and holding ${formatUnits(vault, 18)}`);
    deskFor.push(desk.address);
  }

  // ── register with Arena ───────────────────────────────────────────────────
  // All three slots now hold questions. The slot names [WETH, WBTC, SOMI] are
  // only positions in the contract's array — what a slot actually asks comes
  // from its label, which is what the fighter reads and answers with.
  const hash = await arena.write.setEventDesks([
    [deskFor[0], deskFor[1], deskFor[2]],
    [18, 18, 18],
    [label(chosen[0].label), label(chosen[1].label), label(chosen[2].label)],
  ]);
  await pub.waitForTransactionReceipt({ hash });
  console.log(`\nArena events slots: ${chosen.map((c, i) => `${c.label} ${deskFor[i]}`).join("  ")}`);

  ev.bound = chosen.map((c, i) => ({
    label: c.label,
    desk: deskFor[i],
    asset: c.w.asset,
    intervalSec: c.w.intervalSec,
    pool: c.w.pool,
    marketId: c.w.marketId,
    expiry: c.w.expiry,
  }));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Recorded the binding under contracts.EventDesks.bound`);
}

/** Top-of-book midpoint as a probability in [0,1], or null when nothing is quoted. */
async function midPrice(pub: any, pool: `0x${string}`): Promise<number | null> {
  const book = parseAbi([
    "function getBookLevels(bool isBid, uint64 numLevels) view returns ((uint256 price, uint256 quantity)[])",
  ]);
  const read = async (isBid: boolean) => {
    try {
      const levels = await pub.readContract({ address: pool, abi: book, functionName: "getBookLevels", args: [isBid, 1n] });
      return levels.length ? (levels[0].price as bigint) : 0n;
    } catch { return 0n; }
  };
  const [bid, ask] = await Promise.all([read(true), read(false)]);
  const mid = bid && ask ? (bid + ask) / 2n : bid || ask;
  if (mid === 0n) return null;
  // The pool quotes in its collateral's six decimals; one whole unit is certainty.
  return Number(mid) / 1e6;
}

/** How far from a genuine coin-flip. An unpriced window sorts last. */
function distanceFromEven(mid: number | null): number {
  return mid === null ? Number.POSITIVE_INFINITY : Math.abs(mid - 0.5);
}

/**
 * Read the windows one venue has published.
 *
 * `factory` is NOT optional, and leaving it out was a real bug: a log query with
 * no address matches that event shape from ANY contract on the chain. Somnia
 * testnet has run a single prediction venue so far, so nothing went wrong — but
 * the moment a second one appears, the highest-scoring window could belong to
 * another operator, and a desk pointed at it adopts THAT market's collateral
 * (EventDesk.bind reads it off the pool). The treasury holds none of that token,
 * so funding fails and Arena ends up with a slot registered on a question that
 * can never be traded: a dead slot, invisible until a fight's tape shows moves
 * that never reached a market.
 *
 * `wantCollateral` is the second guard, for the case the venue itself lists a
 * market denominated in something else. The event carries the collateral, and the
 * earlier version threw that field away.
 */
async function scanWindows(
  pub: any,
  factory: `0x${string}`,
  wantCollateral: `0x${string}`,
): Promise<Window[]> {
  const head = await pub.getBlockNumber();
  const out: Window[] = [];
  const want = wantCollateral.toLowerCase();
  let foreign = 0;
  for (let i = 0; i < SCAN_CHUNKS; i++) {
    const to = head - BigInt(i) * CHUNK;
    if (to <= CHUNK) break;
    try {
      const logs = await pub.getLogs({
        address: factory,
        event: MARKET_CREATED,
        fromBlock: to - (CHUNK - 1n),
        toBlock: to,
      });
      for (const l of logs) {
        const collateral = String(l.args.collateral).toLowerCase() as `0x${string}`;
        if (collateral !== want) { foreign++; continue; }
        out.push({
          asset: String(l.args.asset),
          pool: l.args.pool,
          marketId: l.args.marketId,
          expiry: Number(l.args.expiry),
          intervalSec: Number(l.args.intervalSec),
          collateral,
        });
      }
    } catch { /* range unavailable */ }
  }
  if (foreign) console.log(`  skipped ${foreign} window(s) denominated in another collateral`);
  return out;
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.shortMessage ?? e); process.exit(1); });
