// ============================================================================
// probe-fuel-conversion — can the house turn its stablecoin revenue into the
// chain's own coin, on chain, with no operator and no bridge?
//
// The whole "a dedicated pot pays for the fighters' thinking" idea rests on ONE
// fact: that there is a route from the currency players pay in to the currency
// inference is billed in. If that route exists the pot is buildable and the
// operator's manual top-up disappears. If it does not, no amount of contract
// design helps and the top-up is structural.
//
// The candidate is already in the game: one spot market trades the chain's own
// coin AGAINST the stablecoin. Selling it was proven today. Buying it is the
// direction that matters here, and buying the base of a native-base market means
// the venue must hand over real coin. Never tested.
//
//   pnpm exec hardhat run scripts/probe-fuel-conversion.ts --network somnia
//   DRY=1 to stop before ordering.
//
// Reads first, then spends a few units of stablecoin.
// ============================================================================
import hre from "hardhat";
import { formatUnits, parseAbi } from "viem";
import fs from "fs";
import path from "path";

const POOL = parseAbi([
  "function getPoolParams() view returns (address,address,uint256,uint256,uint256,uint256,uint256)",
  "function getBookLevels(bool,uint64) view returns ((uint256 price,uint256 quantity)[])",
  "function placeOrder(bool,uint64,uint256,uint256,uint64,uint8,uint8,address,uint96) returns (bool,uint128)",
]);
const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);

async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf-8"));
  const usdso = m.external.usdso as `0x${string}`;
  const pool = m.external.poolSomi as `0x${string}`;
  const pub = await hre.viem.getPublicClient();
  const [op] = await hre.viem.getWalletClients();
  const me = op.account.address;

  const p = await pub.readContract({ address: pool, abi: POOL, functionName: "getPoolParams" }) as readonly unknown[];
  const base = p[0] as `0x${string}`;
  const tick = p[4] as bigint, minQty = p[5] as bigint, lot = p[6] as bigint;
  const code = await pub.getCode({ address: base });
  console.log(`market's asset ${base}`);
  console.log(`  has code: ${!!code && code !== "0x"}  -> ${(!code || code === "0x") ? "this IS the chain's own coin" : "an ordinary token; wrong market"}`);
  if (code && code !== "0x") return;

  // Buying the BASE of this market means paying stablecoin and being handed coin.
  const asks = await pub.readContract({ address: pool, abi: POOL, functionName: "getBookLevels", args: [false, BigInt(1)] }) as readonly { price: bigint; quantity: bigint }[];
  if (asks.length === 0) { console.log("nobody offering the coin right now"); return; }
  // COINS lets this double as an operator top-up, not just a proof: the deployer
  // pays for every contract deployment in the chain's own coin, and it ran dry while
  // the Arena sat well funded because the pot was doing its job. Buying gas money
  // with stablecoin is the same trade the pot makes, done by hand.
  let qty = (BigInt(process.env.COINS ?? "1")) * BigInt(10) ** BigInt(18);
  if (qty < minQty) qty = minQty;
  if (lot > BigInt(0) && qty % lot !== BigInt(0)) qty = ((qty / lot) + BigInt(1)) * lot;
  if (qty > asks[0].quantity) qty = (asks[0].quantity / lot) * lot;
  let price = asks[0].price + BigInt(50) * tick;
  price = (price / tick) * tick;
  const cost = (price * qty) / BigInt(10) ** BigInt(18);

  const u0 = await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [me] }) as bigint;
  const c0 = await pub.getBalance({ address: me });
  console.log(`\n  offered: ${formatUnits(asks[0].quantity, 18)} coin at ${formatUnits(asks[0].price, 18)}`);
  console.log(`  buying  ${formatUnits(qty, 18)} coin for about ${formatUnits(cost, 18)} stablecoin`);
  console.log(`  before: ${formatUnits(u0, 18)} stablecoin, ${formatUnits(c0, 18)} coin`);
  if (process.env.DRY === "1") { console.log("DRY=1 — stopping."); return; }

  let h = await op.writeContract({ address: usdso, abi: ERC20, functionName: "approve", args: [pool, cost * BigInt(2)] });
  await pub.waitForTransactionReceipt({ hash: h });
  const block = await pub.getBlock();
  try {
    h = await op.writeContract({
      address: pool, abi: POOL, functionName: "placeOrder",
      args: [true, BigInt(0), price, qty, (block.timestamp + BigInt(3600)) * BigInt(1_000_000_000), 1, 0, "0x0000000000000000000000000000000000000000", BigInt(0)],
    });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    console.log(`  tx ${h} status=${r.status} gas=${r.gasUsed}`);
  } catch (e: any) {
    console.log(`  REFUSED: ${(e.shortMessage ?? e.message).split("\n")[0]}`);
  }
  const u1 = await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [me] }) as bigint;
  const c1 = await pub.getBalance({ address: me });
  console.log(`\n  stablecoin ${formatUnits(u0, 18)} -> ${formatUnits(u1, 18)}`);
  console.log(`  coin       ${formatUnits(c0, 18)} -> ${formatUnits(c1, 18)}`);
  // Gas is paid in the coin too, so a rise here is unambiguous but a small fall is not.
  console.log(`\n  ${c1 > c0 ? "CONVERSION WORKS: stablecoin in, real coin out, on chain, no operator."
    : u1 < u0 ? "stablecoin was spent but no coin arrived — the venue does not deliver native to a plain wallet this way"
    : "nothing moved; the order did not fill"}`);
  await op.writeContract({ address: usdso, abi: ERC20, functionName: "approve", args: [pool, BigInt(0)] });
}

main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exit(1); });
