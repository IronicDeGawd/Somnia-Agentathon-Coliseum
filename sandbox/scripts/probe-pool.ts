/**
 * Probe the SOMI/USDso pool with the CANONICAL ABI from
 * docs.dreamdex.io/developers/contracts/functions.
 *
 * Key corrections vs my earlier guesses:
 *   - getPoolParams returns 7 fields: baseToken, quoteToken, makerFee, takerFee,
 *     tickSize, minQuantity, lotSize  (I had fields in wrong order, missing tokens)
 *   - getBookLevels second arg is uint64 numLevels (I had uint256 depth)
 *   - placeTakerOrderWithoutVault signature confirmed identical
 */
import { createPublicClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import "dotenv/config";

const POOL = "0x259fD6559214dd5aD3752322426eA9F9fABEFff4" as const;
const RPC = "https://api.infra.testnet.somnia.network";

const ABI = [
  {
    name: "getPoolParams",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "baseToken_",          type: "address" },
      { name: "quoteToken_",         type: "address" },
      { name: "makerFeeBpsTimes1k_", type: "uint256" },
      { name: "takerFeeBpsTimes1k_", type: "uint256" },
      { name: "tickSize_",           type: "uint256" },
      { name: "minQuantity_",        type: "uint256" },
      { name: "lotSize_",            type: "uint256" },
    ],
  },
  {
    name: "getBookLevels",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "isBid",     type: "bool" },
      { name: "numLevels", type: "uint64" },
    ],
    outputs: [
      {
        name: "", type: "tuple[]",
        components: [
          { name: "price",    type: "uint256" },
          { name: "quantity", type: "uint256" },
        ],
      },
    ],
  },
  {
    name: "placeTakerOrderWithoutVault",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "isBid",                 type: "bool"    },
      { name: "userData",              type: "uint64"  },
      { name: "price",                 type: "uint256" },
      { name: "quantity",              type: "uint256" },
      { name: "expireTimestampNs",     type: "uint64"  },
      { name: "orderType",             type: "uint8"   },
      { name: "selfMatchingOption",    type: "uint8"   },
      { name: "builder",               type: "address" },
      { name: "builderFeeBpsTimes1k",  type: "uint96"  },
    ],
    outputs: [
      { name: "success", type: "bool"    },
      { name: "orderId", type: "uint128" },
    ],
  },
] as const;

const client = createPublicClient({ transport: http(RPC) });
const account = privateKeyToAccount(process.env.PRIVATE_KEY! as `0x${string}`);

(async () => {
  // --- Pool params with CORRECT ABI ---
  console.log("=== getPoolParams (canonical 7-field ABI) ===");
  try {
    const p = await client.readContract({
      address: POOL, abi: ABI, functionName: "getPoolParams",
    }) as readonly [string, string, bigint, bigint, bigint, bigint, bigint];
    console.log("  baseToken: ", p[0]);
    console.log("  quoteToken:", p[1]);
    console.log("  makerFee:  ", p[2].toString(), "bps×1000");
    console.log("  takerFee:  ", p[3].toString(), "bps×1000");
    console.log("  tickSize:  ", p[4].toString(), "raw  =", Number(p[4])/1e18, "USDso");
    console.log("  minQty:    ", p[5].toString(), "raw  =", Number(p[5])/1e18, "SOMI");
    console.log("  lotSize:   ", p[6].toString(), "raw  =", Number(p[6])/1e18, "SOMI");
  } catch (e: any) {
    console.log("  REVERT:", e.shortMessage ?? e.message);
  }

  console.log("\n=== getBookLevels(true=bids, 5) — canonical uint64 ===");
  try {
    const bids = await client.readContract({
      address: POOL, abi: ABI, functionName: "getBookLevels", args: [true, 5n],
    }) as any[];
    for (const b of bids) {
      console.log(`  ${b.price.toString().padStart(20)} (${Number(b.price)/1e18} USDso)  qty=${b.quantity.toString()} (${Number(b.quantity)/1e18} SOMI)`);
    }
  } catch (e: any) {
    console.log("  REVERT:", e.shortMessage ?? e.message);
  }

  console.log("\n=== getBookLevels(false=asks, 5) ===");
  try {
    const asks = await client.readContract({
      address: POOL, abi: ABI, functionName: "getBookLevels", args: [false, 5n],
    }) as any[];
    for (const a of asks) {
      console.log(`  ${a.price.toString().padStart(20)} (${Number(a.price)/1e18} USDso)  qty=${a.quantity.toString()} (${Number(a.quantity)/1e18} SOMI)`);
    }
  } catch (e: any) {
    console.log("  REVERT:", e.shortMessage ?? e.message);
  }

  // For SELL: price = minimum acceptable. To cross, need price ≤ best bid (0.1735).
  // Set 0.15 — well below best bid, will fill at the best bid's price (taker IOC).
  console.log("\n=== Simulating SELL 1 SOMI @ floor 0.15 (best bid is 0.1735) ===");
  try {
    const sim = await client.simulateContract({
      account,
      address: POOL, abi: ABI,
      functionName: "placeTakerOrderWithoutVault",
      value: parseEther("1"),
      args: [
        false,              // isBid: sell
        0n, parseEther("0.15"), parseEther("1"), 0n, 2, 0,
        "0x0000000000000000000000000000000000000000", 0n,
      ],
    });
    const [success, orderId] = sim.result as [boolean, bigint];
    console.log(`  success=${success}, orderId=${orderId.toString()}`);
  } catch (e: any) {
    console.log("  REVERT:", e.shortMessage ?? e.message);
  }

  console.log("\n=== getOwnOpenOrders() — check for self-match cause ===");
  try {
    const myOrders = await client.readContract({
      account,
      address: POOL,
      abi: [{
        name: "getOwnOpenOrders", type: "function", stateMutability: "view",
        inputs: [], outputs: [{ name: "", type: "uint128[]" }],
      }] as const,
      functionName: "getOwnOpenOrders",
    }) as bigint[];
    console.log("  own open orders:", myOrders.length, myOrders.map(x => x.toString()));
  } catch (e: any) {
    console.log("  REVERT:", e.shortMessage ?? e.message);
  }

  console.log("\n=== SELL with CancelMaker (selfMatching=1) instead ===");
  try {
    const sim = await client.simulateContract({
      account,
      address: POOL, abi: ABI,
      functionName: "placeTakerOrderWithoutVault",
      value: parseEther("1"),
      args: [
        false, 0n, parseEther("0.15"), parseEther("1"), 0n, 2,
        1,    // CancelMaker — cancel resting maker on self-match instead of taker
        "0x0000000000000000000000000000000000000000", 0n,
      ],
    });
    console.log("  result:", sim.result);
  } catch (e: any) {
    console.log("  REVERT:", e.shortMessage ?? e.message);
  }

  console.log("\n=== Simulating SELL 1 SOMI @ floor 0.1735 (exact best bid) ===");
  try {
    const sim = await client.simulateContract({
      account,
      address: POOL, abi: ABI,
      functionName: "placeTakerOrderWithoutVault",
      value: parseEther("1"),
      args: [
        false, 0n, parseEther("0.1735"), parseEther("1"), 0n, 2, 0,
        "0x0000000000000000000000000000000000000000", 0n,
      ],
    });
    const [success, orderId] = sim.result as [boolean, bigint];
    console.log(`  success=${success}, orderId=${orderId.toString()}`);
  } catch (e: any) {
    console.log("  REVERT:", e.shortMessage ?? e.message);
  }

  // ----- Hypothesis #1: non-zero expiry -----
  const futureNs = BigInt(Math.floor(Date.now() / 1000) + 3600) * 1_000_000_000n;
  console.log("\n=== SELL with expireTimestampNs = now + 1h ===");
  try {
    const sim = await client.simulateContract({
      account, address: POOL, abi: ABI,
      functionName: "placeTakerOrderWithoutVault",
      value: parseEther("1"),
      args: [
        false, 0n, parseEther("0.15"), parseEther("1"), futureNs, 2, 0,
        "0x0000000000000000000000000000000000000000", 0n,
      ],
    });
    console.log("  result:", sim.result);
  } catch (e: any) {
    console.log("  REVERT:", e.shortMessage ?? e.message);
  }

  // ----- Hypothesis #2: FOK instead of IOC -----
  console.log("\n=== SELL with FOK (orderType=1) instead of IOC ===");
  try {
    const sim = await client.simulateContract({
      account, address: POOL, abi: ABI,
      functionName: "placeTakerOrderWithoutVault",
      value: parseEther("1"),
      args: [
        false, 0n, parseEther("0.15"), parseEther("1"), futureNs, 1, 0,
        "0x0000000000000000000000000000000000000000", 0n,
      ],
    });
    console.log("  result:", sim.result);
  } catch (e: any) {
    console.log("  REVERT:", e.shortMessage ?? e.message);
  }

  // ----- Hypothesis: msg.value must equal raw quantity exactly + future expiry -----
  console.log("\n=== SELL with both fixes applied ===");
  try {
    const sim = await client.simulateContract({
      account, address: POOL, abi: ABI,
      functionName: "placeTakerOrderWithoutVault",
      value: parseEther("1"),
      args: [
        false, 0n, parseEther("0.1"), parseEther("1"), futureNs, 2, 0,
        "0x0000000000000000000000000000000000000000", 0n,
      ],
    });
    console.log("  result:", sim.result);
  } catch (e: any) {
    console.log("  REVERT:", e.shortMessage ?? e.message);
  }
})();
