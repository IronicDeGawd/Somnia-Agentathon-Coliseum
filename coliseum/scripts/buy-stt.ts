/**
 * buy-stt.ts
 * ----------
 * Buy native STT with USDso on the SOMI order book, and withdraw it as real
 * spendable gas.
 *
 * This is the mirror of get-usdso.ts. That one sells STT for USDso; this one
 * buys. It works because the SOMI book's base token IS the native coin — the
 * "token address" it uses for the base side is a placeholder with no code, not
 * an ERC-20 — so filling a buy and withdrawing that side pays out native STT.
 *
 * Since USDso mints freely on testnet, this makes STT effectively unlimited.
 *
 *   BUY_STT=100 pnpm exec hardhat run scripts/buy-stt.ts --network somnia
 *
 * Env:
 *   BUY_STT  — how much STT to buy (default 10).
 *   TO       — optional address to forward the STT to; defaults to the caller.
 */
import hre from "hardhat";
import { parseEther, formatEther, formatUnits, parseAbi } from "viem";

const SOMI_POOL = "0x259fD6559214dd5aD3752322426eA9F9fABEFff4" as const;
const USDSO = "0x9c32F3827A1a99f0cf9B213de8b53eC3d57bb171" as const;

/// The book's base "token". Deliberately NOT an ERC-20: it has no code at all,
/// and stands for the native coin. Withdrawing this side sends real STT.
const NATIVE = "0x28f34DeFd2b4CB48d9eE6d89f2Be4Bc601694c00" as const;

const TICK = parseEther("0.0001");
const ZERO = "0x0000000000000000000000000000000000000000" as const;

/// Native-base pools guard for payout gas headroom and revert below ~5M.
/// Simulate with the same limit that gets broadcast, or the simulation lies.
const NATIVE_PAYOUT_GAS = BigInt(5_000_000);

const POOL = parseAbi([
  "function placeOrder(bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) payable returns (bool success, uint128 orderId)",
  "function getBookLevels(bool isBid, uint64 numLevels) view returns ((uint256 price, uint256 quantity)[])",
  "function getWithdrawableBalance(address user, address token) view returns (uint256)",
  "function deposit(address token, uint256 amount)",
  "function withdraw(address token, uint256 amount)",
]);
const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);

async function main() {
  const [wallet] = await hre.viem.getWalletClients();
  const pub = await hre.viem.getPublicClient();
  const me = wallet.account.address;
  const want = parseEther(process.env.BUY_STT ?? "10");
  const forwardTo = (process.env.TO ?? "") as `0x${string}` | "";

  const asks = (await pub.readContract({
    address: SOMI_POOL, abi: POOL, functionName: "getBookLevels", args: [false, 10n],
  })) as readonly { price: bigint; quantity: bigint }[];
  if (!asks.length) { console.log("No asks — nobody is selling STT right now. Abort."); return; }

  // Walk the book to see whether the size is even there, and at what average.
  let remaining = want, cost = 0n, worst = 0n;
  for (const level of asks) {
    if (remaining === 0n) break;
    const take = remaining < level.quantity ? remaining : level.quantity;
    cost += (take * level.price) / 10n ** 18n;
    remaining -= take;
    worst = level.price;
  }
  if (remaining > 0n) {
    console.log(`Book only holds ${formatEther(want - remaining)} STT — asked for ${formatEther(want)}. Abort.`);
    return;
  }
  // Cross with headroom above the deepest level we need, aligned up to a tick.
  const limit = ((worst + 10n * TICK) / TICK) * TICK;
  const budget = (want * limit) / 10n ** 18n;

  console.log(`Buying ${formatEther(want)} STT`);
  console.log(`  book cost   ~${formatEther(cost)} USDso  (avg ${formatEther((cost * 10n ** 18n) / want)} per STT)`);
  console.log(`  limit price ${formatEther(limit)}  → budget ${formatEther(budget)} USDso`);

  const usdso = (await pub.readContract({ address: USDSO, abi: ERC20, functionName: "balanceOf", args: [me] })) as bigint;
  if (usdso < budget) { console.log(`Holding only ${formatUnits(usdso, 18)} USDso. Abort.`); return; }

  const sttBefore = await pub.getBalance({ address: me });

  // The book is a vault: funds are deposited first, then orders draw on them.
  const allowance = (await pub.readContract({ address: USDSO, abi: ERC20, functionName: "allowance", args: [me, SOMI_POOL] })) as bigint;
  if (allowance < budget) {
    const h = await wallet.writeContract({ address: USDSO, abi: ERC20, functionName: "approve", args: [SOMI_POOL, budget] });
    await pub.waitForTransactionReceipt({ hash: h });
  }
  let hash = await wallet.writeContract({ address: SOMI_POOL, abi: POOL, functionName: "deposit", args: [USDSO, budget] });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`  deposited ${formatEther(budget)} USDso into the book`);

  const args = [true, 0n, limit, want, BigInt(Math.floor(Date.now() / 1000) + 3600) * 1_000_000_000n, 2, 0, ZERO, 0n] as const;
  const sim = await pub.simulateContract({
    account: wallet.account, address: SOMI_POOL, abi: POOL, functionName: "placeOrder",
    args: args as never, gas: NATIVE_PAYOUT_GAS,
  });
  const [ok] = sim.result as unknown as [boolean, bigint];
  if (!ok) { console.log("simulate success=false — the order would be rejected. Abort."); return; }

  hash = await wallet.writeContract({
    address: SOMI_POOL, abi: POOL, functionName: "placeOrder", args: args as never, gas: NATIVE_PAYOUT_GAS,
  });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`  filled: ${hash}`);

  // Take the native side out of the vault — this is where it becomes gas.
  const bought = (await pub.readContract({ address: SOMI_POOL, abi: POOL, functionName: "getWithdrawableBalance", args: [me, NATIVE] })) as bigint;
  if (bought > 0n) {
    hash = await wallet.writeContract({ address: SOMI_POOL, abi: POOL, functionName: "withdraw", args: [NATIVE, bought], gas: NATIVE_PAYOUT_GAS });
    await pub.waitForTransactionReceipt({ hash });
    console.log(`  withdrew ${formatEther(bought)} STT as native`);
  }
  // Anything unspent goes back rather than sitting in the book.
  const leftover = (await pub.readContract({ address: SOMI_POOL, abi: POOL, functionName: "getWithdrawableBalance", args: [me, USDSO] })) as bigint;
  if (leftover > 0n) {
    hash = await wallet.writeContract({ address: SOMI_POOL, abi: POOL, functionName: "withdraw", args: [USDSO, leftover] });
    await pub.waitForTransactionReceipt({ hash });
    console.log(`  returned ${formatEther(leftover)} unspent USDso`);
  }

  const sttAfter = await pub.getBalance({ address: me });
  console.log(`\nSTT ${formatEther(sttBefore)} → ${formatEther(sttAfter)}  (gas paid out of this too)`);

  if (forwardTo) {
    // Forward only what this purchase actually delivered, never the balance that
    // was already here — that STT is what pays for turns and top-ups, and a
    // "send everything above a floor" rule would quietly empty it.
    const gained = sttAfter > sttBefore ? sttAfter - sttBefore : 0n;
    const keep = parseEther("5");
    const spare = sttAfter > keep ? sttAfter - keep : 0n;
    const send = gained < spare ? gained : spare;
    if (send === 0n) { console.log("nothing spare to forward"); return; }
    const h = await wallet.sendTransaction({ to: forwardTo, value: send });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(`forwarded ${formatEther(send)} STT to ${forwardTo}  ${h}`);
    console.log(`operator keeps ${formatEther(sttAfter - send)} STT for running duels`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.shortMessage ?? e); process.exit(1); });
