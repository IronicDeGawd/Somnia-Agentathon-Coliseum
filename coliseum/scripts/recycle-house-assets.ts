// ============================================================================
// recycle-house-assets — turn the assets the house has accumulated back into cash.
//
// The second half of the old leak, and the half that survives retiring the venue
// deposits. Every buy a fighter makes converts the house's cash into an asset that
// is delivered to the Arena's balance, and nothing ever converts it back. Measured
// across duel 58: cash fell 563.91 -> 536.35 USDso while the WETH holding rose
// 0.054 -> 0.067, which at the going price is the same money in a different form.
//
// Left alone this is not a fault that breaks a fight — it distorts the books,
// because `seedLiquidity` still counts departed cash as cash. But it compounds, and
// the assets are real money: 0.067 of the WETH base is roughly 150 USDso.
//
// So: pull the asset out of the Arena, sell it at the venue, send the cash back.
// Three steps, each checked, and the cash goes back to the ARENA rather than to the
// operator — it is the house's money and it should stay working.
//
//   pnpm exec hardhat run scripts/recycle-house-assets.ts --network somnia
//   DRY=1 … report what would happen and stop.
//
// The arena must be empty: a fighter mid-fight may be counting on a holding, and
// selling it underneath them would change a live fight's score.
// ============================================================================
import hre from "hardhat";
import { formatUnits, parseAbi } from "viem";
import fs from "fs";
import path from "path";

const ARENA_ABI = parseAbi([
  "function sweepToken(address,address,uint256)",
  "function activeDuelId() view returns (uint256)",
]);
const POOL_ABI = parseAbi([
  "function getPoolParams() view returns (address,address,uint256,uint256,uint256,uint256,uint256)",
  "function getBookLevels(bool,uint64) view returns ((uint256 price,uint256 quantity)[])",
  "function placeOrder(bool,uint64,uint256,uint256,uint64,uint8,uint8,address,uint96) returns (bool,uint128)",
]);
const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
]);

async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"));
  const arena = m.contracts.Arena.address as `0x${string}`;
  const usdso = m.external.usdso as `0x${string}`;
  const pools: [string, `0x${string}`][] = [
    ["WETH", m.external.poolWeth], ["WBTC", m.external.poolWbtc], ["SOMI", m.external.poolSomi],
  ];

  const pub = await hre.viem.getPublicClient();
  const [op] = await hre.viem.getWalletClients();
  const dry = process.env.DRY === "1";

  const active = await pub.readContract({ address: arena, abi: ARENA_ABI, functionName: "activeDuelId" }) as bigint;
  if (active !== BigInt(0)) { console.log(`duel ${active} is live — a fighter may be holding this. Wait.`); return; }

  let recovered = BigInt(0);

  for (const [name, pool] of pools) {
    const p = await pub.readContract({ address: pool, abi: POOL_ABI, functionName: "getPoolParams" }) as readonly unknown[];
    const base = p[0] as `0x${string}`;
    const tick = p[4] as bigint, lot = p[6] as bigint;
    const code = await pub.getCode({ address: base });
    if (!code || code === "0x") {
      // The chain's own coin. The arena's coin balance is also its inference fuel, so
      // it is deliberately NOT swept here — taking it could stop the fighters thinking.
      console.log(`${name}: the chain's own coin — left alone on purpose (it is also the inference fuel)`);
      continue;
    }
    const dec = Number(await pub.readContract({ address: base, abi: ERC20, functionName: "decimals" }));
    const held = await pub.readContract({ address: base, abi: ERC20, functionName: "balanceOf", args: [arena] }) as bigint;
    if (held === BigInt(0)) { console.log(`${name}: the arena holds none`); continue; }

    // Size the sale to what the book can actually absorb. These orders are
    // fill-or-kill, so ONE unit more than the resting depth cancels the whole thing —
    // which is exactly how a first attempt at this failed: 0.067 offered against a
    // best bid holding 0.046. So take the depth, not the holding.
    const bids = await pub.readContract({ address: pool, abi: POOL_ABI, functionName: "getBookLevels", args: [true, BigInt(1)] }) as readonly { price: bigint; quantity: bigint }[];
    if (bids.length === 0) { console.log(`${name}: nobody bidding right now`); continue; }
    const capacity = bids[0].quantity;
    let sellable = held < capacity ? held : capacity;
    if (lot > BigInt(0)) sellable = (sellable / lot) * lot;
    if (sellable === BigInt(0)) { console.log(`${name}: holds ${formatUnits(held, dec)} but the book can take none of it right now`); continue; }
    let price = bids[0].price - BigInt(20) * tick;
    price = (price / tick) * tick;
    const expect = (price * sellable) / BigInt(10) ** BigInt(dec);
    console.log(`${name}: arena holds ${formatUnits(held, dec)}, book can take ${formatUnits(capacity, dec)}`);
    console.log(`  selling ${formatUnits(sellable, dec)} at ~${formatUnits(price, 18)} for about ${formatUnits(expect, 18)} USDso${sellable < held ? "  (the rest stays for a later pass)" : ""}`);
    if (dry) continue;

    // 1. out of the arena. `sweepToken` refuses USDso by design, so this can only
    //    ever move an asset, never a player's deposit.
    let h = await op.writeContract({ address: arena, abi: ARENA_ABI, functionName: "sweepToken", args: [base, op.account.address, sellable] });
    await pub.waitForTransactionReceipt({ hash: h });

    // 2. sell it. The venue bills and pays the caller, which is the operator here.
    const u0 = await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [op.account.address] }) as bigint;
    h = await op.writeContract({ address: base, abi: ERC20, functionName: "approve", args: [pool, sellable] });
    await pub.waitForTransactionReceipt({ hash: h });
    const block = await pub.getBlock();
    try {
      h = await op.writeContract({
        address: pool, abi: POOL_ABI, functionName: "placeOrder",
        args: [false, BigInt(0), price, sellable, (block.timestamp + BigInt(3600)) * BigInt(1_000_000_000), 1, 0, "0x0000000000000000000000000000000000000000", BigInt(0)],
      });
      const r = await pub.waitForTransactionReceipt({ hash: h });
      console.log(`  sold: tx ${h} status=${r.status}`);
    } catch (e: any) {
      console.log(`  sale refused: ${(e.shortMessage ?? e.message).split("\n")[0]}`);
      console.log(`  putting the asset back rather than leaving it with the operator`);
      await op.writeContract({ address: base, abi: ERC20, functionName: "transfer", args: [arena, sellable] });
      continue;
    }
    const u1 = await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [op.account.address] }) as bigint;
    const proceeds = u1 - u0;

    // 3. the cash goes back to the ARENA, not to the operator. It is house money and
    //    it should stay where it can fund the next fight.
    if (proceeds > BigInt(0)) {
      h = await op.writeContract({ address: usdso, abi: ERC20, functionName: "transfer", args: [arena, proceeds] });
      await pub.waitForTransactionReceipt({ hash: h });
      recovered += proceeds;
      console.log(`  ${formatUnits(proceeds, 18)} USDso returned to the arena`);
    }
    // Anything the venue would not take goes home too.
    const leftover = await pub.readContract({ address: base, abi: ERC20, functionName: "balanceOf", args: [op.account.address] }) as bigint;
    if (leftover > BigInt(0)) {
      await op.writeContract({ address: base, abi: ERC20, functionName: "transfer", args: [arena, leftover] });
      console.log(`  ${formatUnits(leftover, dec)} unsold returned to the arena`);
    }
  }

  const bal = await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [arena] }) as bigint;
  console.log(`\nrecycled ${formatUnits(recovered, 18)} USDso. Arena now holds ${formatUnits(bal, 18)}.`);
}

main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exit(1); });
