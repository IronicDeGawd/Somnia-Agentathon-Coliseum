import { expect } from "chai";
import hre from "hardhat";
import { parseEther, zeroAddress, decodeErrorResult } from "viem";

import {
  deployPerpVenue, marketByName, userData, alignUp, alignDown, expectCustomError,
} from "./helpers/perps";

const GTC = 2n ** 64n - 1n;

/**
 * `forceClose` refused every live attempt while reporting SUCCESS. THE DIAGNOSIS,
 * settled by `debug_traceTransaction` on the real attempts (see
 * `scripts/diagnose-force-close.ts`): a silent internal out-of-gas inside the perp
 * pool's oracle path, swallowed by `PerpAccount.trade`'s bare `try/catch` — never
 * margin, allowance, lease, venue, market, order type or price.
 *
 * THE FIX has two parts:
 *  1. `forceClose` now routes through `PerpAccount.tradeStrict`, which has no catch,
 *     so a revert or an out-of-gas below it reaches here instead of being reported
 *     as a clean `(false, 0)`.
 *  2. `forceClose` refuses up front when `gasleft()` is below a floor sized for the
 *     unhealthy path, so a doomed attempt is refused rather than burned.
 *
 * The regression that matters most sits in its own describe block below: none of
 * this may leak into `release` / `_flatten` / a desk's `trade`, which MUST stay
 * tolerant of a reverting pool or a frozen duel is the result.
 */
describe("PerpAccountRegistry.forceClose — the gas-starved rescue", function () {
  this.timeout(120_000);

  async function deploy() {
    const [owner, arena, stranger] = await hre.viem.getWalletClients();
    const venue = await deployPerpVenue(hre, arena.account.address);
    return { ...venue, arena, stranger, ownerWallet: owner };
  }

  /** Put a fighter into a short and then take the market away, exactly as the
   *  existing operator-surface tests do, so the account is quarantined with an
   *  open position — the shape a real rescue attempt is made against. */
  async function stickAFighter(ctx: Awaited<ReturnType<typeof deploy>>, duelId: bigint) {
    const m = marketByName("SOL");
    await ctx.registry.write.lease([duelId, 0, parseEther("18")], { account: ctx.arena.account });
    const account = await ctx.registry.read.accountOf([duelId, 0]) as string;

    const bids = await ctx.market("SOL").read.getBookLevels([true, 1n]) as
      { price: bigint; quantity: bigint }[];
    await ctx.desk("SOL").write.placeOrder(
      [false, userData(duelId, 0), alignDown(bids[0]!.price, m.tickSize), m.minQuantity,
       GTC, 1, 0, zeroAddress, 0n],
      { account: ctx.arena.account },
    );

    await ctx.market("SOL").write.clearBook([true]);
    await ctx.market("SOL").write.clearBook([false]);
    await ctx.registry.write.release([duelId, 0], { account: ctx.arena.account });
    expect(await ctx.registry.read.quarantined([account]), "stuck").to.equal(true);
    return account;
  }

  async function sizeOf(ctx: Awaited<ReturnType<typeof deploy>>, marketName: string, account: string) {
    const p = await ctx.bank.read.getPosition([account, ctx.market(marketName).address]) as unknown[];
    return p[0] as bigint;
  }

  /** True if the promise rejected, for asserting a plain (non-custom-error) revert
   *  such as an out-of-gas or a require string — the shapes `expectCustomError`
   *  cannot name because they carry no matching selector. */
  async function expectReverts(p: Promise<unknown>, why: string) {
    try {
      await p;
    } catch {
      return;
    }
    throw new Error(`expected a revert (${why}) but the call succeeded`);
  }

  describe("the diagnosed failure — a gas-starved pool", () => {
    it("reverts loudly instead of silently returning ok=false when the pool burns all its forwarded gas", async () => {
      // THE LIVE SIGNATURE, reproduced: a pool whose placeOrder never returns, it just
      // consumes whatever gas the caller forwarded — exactly what a starved oracle
      // read did in production. Before the fix this reached PerpAccount.trade's bare
      // catch and forceClose reported `ok=false` with no revert, silently. After the
      // fix, tradeStrict has no catch, so the out-of-gas propagates as a real revert.
      const ctx = await deploy();
      const account = await stickAFighter(ctx, 101n);
      const m = marketByName("SOL");
      await ctx.market("SOL").write.setBurnGas([true]);

      const price = alignUp(m.mark * 105n / 100n, m.tickSize);
      await expectReverts(
        ctx.registry.write.forceClose([account, ctx.market("SOL").address, true, price, m.minQuantity]),
        "gas-starved pool must not silently succeed",
      );

      // And nothing moved — the whole rescue transaction reverted, so the position
      // the diagnosis found stuck is exactly as stuck as before the attempt.
      expect(await sizeOf(ctx, "SOL", account), "still short, untouched").to.be.lessThan(0n);
    });

    it("surfaces a plain revert from the pool rather than swallowing it", async () => {
      const ctx = await deploy();
      const account = await stickAFighter(ctx, 102n);
      const m = marketByName("SOL");
      await ctx.market("SOL").write.setRevertOnPlace([true]);

      const price = alignUp(m.mark * 105n / 100n, m.tickSize);
      await expectReverts(
        ctx.registry.write.forceClose([account, ctx.market("SOL").address, true, price, m.minQuantity]),
        "a reverting pool must reach the caller, not report ok=false",
      );
    });

    it("still fills and still emits ForceClosed(..., true) against a healthy pool", async () => {
      // The fix must not turn forceClose into something that only ever reverts —
      // routing through tradeStrict changes nothing about a fill that actually works.
      const ctx = await deploy();
      const account = await stickAFighter(ctx, 103n);
      const m = marketByName("SOL");

      const price = alignUp(m.mark * 105n / 100n, m.tickSize);
      await ctx.market("SOL").write.setBookLevel([false, price, m.minQuantity * 5n]);

      const hash = await ctx.registry.write.forceClose(
        [account, ctx.market("SOL").address, true, price, m.minQuantity]);
      const receipt = await (await hre.viem.getPublicClient()).getTransactionReceipt({ hash });
      expect(receipt.status, "the rescue transaction itself succeeded").to.equal("success");
      expect(await sizeOf(ctx, "SOL", account), "flat").to.equal(0n);
    });
  });

  describe("the gas floor", () => {
    it("refuses up front, carrying both figures, when called with too little gas", async () => {
      const ctx = await deploy();
      const account = await stickAFighter(ctx, 104n);
      const m = marketByName("SOL");
      const floor = await ctx.registry.read.rescueGasFloor() as bigint;
      expect(floor, "the documented default").to.equal(2_000_000n);

      const price = alignUp(m.mark * 105n / 100n, m.tickSize);
      try {
        await ctx.registry.write.forceClose(
          [account, ctx.market("SOL").address, true, price, m.minQuantity],
          { gas: 200_000n },
        );
        expect.fail("expected InsufficientGasForRescue");
      } catch (e) {
        const raw = extractRevertData(e);
        if (!raw) throw new Error(`expected revert data, got: ${String((e as Error)?.message ?? e)}`);
        const decoded = decodeErrorResult({ abi: ctx.registry.abi, data: raw });
        expect(decoded.errorName).to.equal("InsufficientGasForRescue");
        const [have, want] = decoded.args as [bigint, bigint];
        expect(want, "the want figure is the configured floor").to.equal(floor);
        expect(have, "the have figure is below the floor it tripped").to.be.lessThan(floor);
      }
    });

    it("is overridable by the owner", async () => {
      const ctx = await deploy();
      await ctx.registry.write.setRescueGasFloor([1_500_000n]);
      expect(await ctx.registry.read.rescueGasFloor()).to.equal(1_500_000n);
    });

    it("refuses a floor below the measured minimum", async () => {
      const ctx = await deploy();
      const min = await ctx.registry.read.MIN_RESCUE_GAS_FLOOR() as bigint;
      expect(min, "the documented minimum").to.equal(1_000_000n);
      await expectCustomError(
        ctx.registry.write.setRescueGasFloor([min - 1n]),
        "RescueGasFloorTooLow(uint256,uint256)",
      );
      // the floor is unchanged
      expect(await ctx.registry.read.rescueGasFloor()).to.equal(2_000_000n);
    });

    it("accepts the minimum itself, right at the boundary", async () => {
      const ctx = await deploy();
      const min = await ctx.registry.read.MIN_RESCUE_GAS_FLOOR() as bigint;
      await ctx.registry.write.setRescueGasFloor([min]);
      expect(await ctx.registry.read.rescueGasFloor()).to.equal(min);
    });

    it("refuses a zero floor, which would otherwise be a no-op guard", async () => {
      const ctx = await deploy();
      const min = await ctx.registry.read.MIN_RESCUE_GAS_FLOOR() as bigint;
      await expectCustomError(
        ctx.registry.write.setRescueGasFloor([0n]),
        `RescueGasFloorTooLow(0, ${min})`,
      );
      expect(await ctx.registry.read.rescueGasFloor()).to.equal(2_000_000n);
    });

    it("keeps the setter owner-only", async () => {
      const ctx = await deploy();
      await expectCustomError(
        ctx.registry.write.setRescueGasFloor([500_000n], { account: ctx.stranger.account }),
        "NotOwner()",
      );
    });
  });

  /**
   * THE REGRESSION THAT MATTERS MOST. If the fix leaked strictness into the
   * live-fight or wind-down path, a reverting or gas-starved pool would freeze a
   * duel — worse than the silent-refusal bug this whole phase exists to fix, because
   * players could no longer recover their stake at all.
   */
  describe("the live-fight and wind-down paths stay tolerant", () => {
    it("a desk's trade() does not revert against a reverting pool", async () => {
      const ctx = await deploy();
      await ctx.registry.write.lease([110n, 0, parseEther("6")], { account: ctx.arena.account });
      await ctx.market("SOL").write.setRevertOnPlace([true]);

      const m = marketByName("SOL");
      const { result } = await ctx.desk("SOL").simulate.placeOrder(
        [true, userData(110n, 0), m.mark, m.minQuantity, GTC, 1, 0, zeroAddress, 0n],
        { account: ctx.arena.account },
      );
      expect((result as [boolean, bigint])[0], "tolerated, not thrown").to.equal(false);
    });

    it("a desk's trade() does not revert against a gas-starved pool", async () => {
      const ctx = await deploy();
      await ctx.registry.write.lease([111n, 0, parseEther("6")], { account: ctx.arena.account });
      await ctx.market("SOL").write.setBurnGas([true]);

      const m = marketByName("SOL");
      const { result } = await ctx.desk("SOL").simulate.placeOrder(
        [true, userData(111n, 0), m.mark, m.minQuantity, GTC, 1, 0, zeroAddress, 0n],
        { account: ctx.arena.account },
      );
      expect((result as [boolean, bigint])[0], "tolerated, not thrown").to.equal(false);
    });

    it("release() still quarantines cleanly rather than reverting when the pool reverts on close", async () => {
      const ctx = await deploy();
      const m = marketByName("SOL");
      await ctx.registry.write.lease([112n, 0, parseEther("18")], { account: ctx.arena.account });
      const account = await ctx.registry.read.accountOf([112n, 0]) as string;

      const bids = await ctx.market("SOL").read.getBookLevels([true, 1n]) as
        { price: bigint; quantity: bigint }[];
      await ctx.desk("SOL").write.placeOrder(
        [false, userData(112n, 0), alignDown(bids[0]!.price, m.tickSize), m.minQuantity,
         GTC, 1, 0, zeroAddress, 0n],
        { account: ctx.arena.account },
      );

      // The book is still there — _flatten would otherwise close it cleanly — but the
      // pool itself now reverts on every order, modelling a market gone hostile mid-fight.
      await ctx.market("SOL").write.setRevertOnPlace([true]);

      await ctx.registry.write.release([112n, 0], { account: ctx.arena.account });
      expect(await ctx.registry.read.quarantined([account]), "quarantined, not reverted").to.equal(true);
      expect(await sizeOf(ctx, "SOL", account), "still open").to.be.lessThan(0n);
    });

    it("release() still quarantines cleanly rather than reverting when the pool burns all its gas on close", async () => {
      const ctx = await deploy();
      const m = marketByName("SOL");
      await ctx.registry.write.lease([113n, 0, parseEther("18")], { account: ctx.arena.account });
      const account = await ctx.registry.read.accountOf([113n, 0]) as string;

      const bids = await ctx.market("SOL").read.getBookLevels([true, 1n]) as
        { price: bigint; quantity: bigint }[];
      await ctx.desk("SOL").write.placeOrder(
        [false, userData(113n, 0), alignDown(bids[0]!.price, m.tickSize), m.minQuantity,
         GTC, 1, 0, zeroAddress, 0n],
        { account: ctx.arena.account },
      );

      await ctx.market("SOL").write.setBurnGas([true]);

      await ctx.registry.write.release([113n, 0], { account: ctx.arena.account });
      expect(await ctx.registry.read.quarantined([account]), "quarantined, not reverted").to.equal(true);
      expect(await sizeOf(ctx, "SOL", account), "still open").to.be.lessThan(0n);
    });
  });
});

/** Pull the raw revert bytes out of whatever shape viem wraps a failed write in. */
function extractRevertData(e: unknown): `0x${string}` | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const err = e as any;
  return err?.data ?? err?.cause?.data ?? err?.cause?.cause?.data ?? err?.cause?.cause?.cause?.data ?? undefined;
}
