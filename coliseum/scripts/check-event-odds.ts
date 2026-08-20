// check-event-odds — what a fighter is actually offered on each claimed event
// desk right now.
//
// READ THE DESK, NOT THE POOL BEHIND IT. The desk is a translator: it scales the
// real binary pool's book into the shape Arena expects. Querying the pool
// directly with a spot-book signature returns nothing, which reads as "no market"
// when the market is in fact quoting fine. That mistake cost a wrong diagnosis.
//
// It also reports the EXIT side, which is the interesting half: Arena will only
// offer a fighter a way out of a position if the advertised position token can
// answer a balance question. The event desks advertise one that cannot, so the
// exit is withheld and every event position is one-way.
import hre from "hardhat";
import { formatUnits } from "viem";
import fs from "fs"; import path from "path";

const DESK = [
  { name: "pool", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "inUse", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { name: "getBookLevels", type: "function", stateMutability: "view",
    inputs: [{ type: "bool" }, { type: "uint64" }],
    outputs: [{ type: "tuple[]", components: [{ name: "price", type: "uint256" }, { name: "quantity", type: "uint256" }] }] },
  { name: "getPoolParams", type: "function", stateMutability: "view", inputs: [],
    outputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" },
              { type: "uint256" }, { type: "uint256" }, { type: "uint256" }] },
] as const;
const POOL = [
  { name: "marketExpiryNs", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;
const ERC20 = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const word = (m: number) =>
  m < 0.15 ? "very unlikely" : m < 0.35 ? "unlikely" : m < 0.5 ? "coin toss, leaning no"
  : m < 0.65 ? "coin toss, leaning yes" : m < 0.85 ? "likely" : "very likely";

async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${hre.network.name}.json`), "utf-8"));
  const arena = m.contracts.Arena.address as `0x${string}`;
  const desks = m.contracts.EventDesks.desks as `0x${string}`[];
  const pub = await hre.viem.getPublicClient();
  const nowS = Math.floor(Date.now() / 1000);

  for (const desk of desks) {
    const rd = (fn: string, args: any[] = []) =>
      pub.readContract({ address: desk, abi: DESK as any, functionName: fn, args });
    if (!(await rd("inUse") as boolean)) { console.log(`${desk.slice(0, 10)}  free`); continue; }

    const pool = await rd("pool") as `0x${string}`;
    const side = async (isBid: boolean) => {
      try { const l = await rd("getBookLevels", [isBid, 1n]) as any[];
            return l.length ? { p: BigInt(l[0].price), q: BigInt(l[0].quantity) } : { p: 0n, q: 0n }; }
      catch { return { p: 0n, q: 0n }; }
    };
    const bid = await side(true), ask = await side(false);
    const mid = bid.p > 0n && ask.p > 0n ? (bid.p + ask.p) / 2n : bid.p > 0n ? bid.p : ask.p;
    const f = Number(formatUnits(mid, 18));

    let leftMin = 0;
    try {
      const ns = await pub.readContract({ address: pool, abi: POOL as any, functionName: "marketExpiryNs" }) as bigint;
      leftMin = Math.floor((Number(ns / 1_000_000_000n) - nowS) / 60);
    } catch {}

    // The exit gate, asked exactly the way Arena asks it.
    const base = (await rd("getPoolParams") as any[])[0] as `0x${string}`;
    let exit = "withheld — the position token cannot answer a balance question";
    try {
      const held = await pub.readContract({ address: base, abi: ERC20 as any, functionName: "balanceOf", args: [arena] }) as bigint;
      exit = `offerable — arena holds ${formatUnits(held, 18)}`;
    } catch { /* the message above is the finding, not a failure of this script */ }

    console.log(
      `${desk.slice(0, 10)}  mid ${f.toFixed(3)} (${word(f)})  ` +
      `bid ${Number(formatUnits(bid.p, 18)).toFixed(3)}x${formatUnits(bid.q, 18)}  ` +
      `ask ${Number(formatUnits(ask.p, 18)).toFixed(3)}x${formatUnits(ask.q, 18)}  ` +
      `${leftMin} min left\n              back: ${bid.q > 0n || ask.q > 0n ? "offerable" : "no size — withheld"}   drop: ${exit}`,
    );
  }
}
main().catch(e => { console.error(e.shortMessage ?? e.message ?? e); process.exit(1); });
