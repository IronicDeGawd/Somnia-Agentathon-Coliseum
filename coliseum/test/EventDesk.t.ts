import { expect } from "chai";
import hre from "hardhat";
import { getAddress } from "viem";

// The desk speaks 18 decimals to Arena and 6 to the pool.
const SCALE = 10n ** 12n;

// A market expiry well in the future, in nanoseconds.
const MARKET_EXPIRY_NS = 2_000_000_000n * 1_000_000_000n;

async function deploy() {
  const [owner, arena, stranger] = await hre.viem.getWalletClients();

  const collateral   = await hre.viem.deployContract("MockFaucetToken");
  const outcomeToken = await hre.viem.deployContract("MockOutcomeToken");
  const market       = await hre.viem.deployContract("MockBinaryMarket");
  const pool         = await hre.viem.deployContract("MockBinaryPool", [
    collateral.address, outcomeToken.address, market.address, MARKET_EXPIRY_NS,
  ]);
  const desk = await hre.viem.deployContract("EventDesk", [pool.address, arena.account.address]);

  return { owner, arena, stranger, collateral, outcomeToken, market, pool, desk };
}

/** Place an order through the desk as Arena would: 18-dp price/quantity, +1h expiry. */
async function placeAsArena(
  ctx: Awaited<ReturnType<typeof deploy>>,
  isBid: boolean,
  price18: bigint,
  qty18: bigint,
) {
  const arenaExpiry = BigInt(Math.floor(Date.now() / 1000) + 3600) * 1_000_000_000n;
  return ctx.desk.write.placeOrder(
    [isBid, 7n, price18, qty18, arenaExpiry, 0, 0, "0x0000000000000000000000000000000000000000", 0n],
    { account: ctx.arena.account },
  );
}

describe("EventDesk", () => {
  describe("construction", () => {
    it("grants the pool operator rights on the outcome-token singleton", async () => {
      // Selling escrows outcome tokens, which the pool pulls under this grant.
      // Without it every sell would revert.
      const { desk, pool, outcomeToken } = await deploy();
      expect(await outcomeToken.read.isOperator([desk.address, pool.address])).to.equal(true);
    });

    it("reads its market identity off the pool", async () => {
      const { desk, collateral, market, outcomeToken } = await deploy();
      expect(getAddress(await desk.read.collateral())).to.equal(getAddress(collateral.address));
      expect(getAddress(await desk.read.market())).to.equal(getAddress(market.address));
      expect(getAddress(await desk.read.outcomeToken())).to.equal(getAddress(outcomeToken.address));
    });
  });

  describe("the book, while trading", () => {
    it("scales 6-decimal pool prices up to the 18 decimals Arena expects", async () => {
      const { desk, pool } = await deploy();
      await pool.write.setBookLevel([true, 218_000n, 200_000_000n]);   // 0.218 x 200 contracts

      const levels = await desk.read.getBookLevels([true, 3n]);
      expect(levels.length).to.equal(1);
      expect(levels[0].price).to.equal(218_000n * SCALE);              // 0.218e18
      expect(levels[0].quantity).to.equal(200_000_000n * SCALE);
    });

    it("keeps bid and ask distinct so a midpoint can be computed", async () => {
      const { desk, pool } = await deploy();
      await pool.write.setBookLevel([true, 193_000n, 1n]);
      await pool.write.setBookLevel([false, 218_000n, 1n]);

      const bid = await desk.read.getBookLevels([true, 1n]);
      const ask = await desk.read.getBookLevels([false, 1n]);
      const mid = (bid[0].price + ask[0].price) / 2n;
      expect(mid).to.equal(205_500n * SCALE);                          // 0.2055e18
    });
  });

  describe("the book, after settlement", () => {
    // This is the whole reason the desk intercepts reads. A resolved window has
    // an empty book, and Arena reads an empty book as "worth zero" — which would
    // hand the duel to whoever happened to be holding cash.
    it("reports 1.0 for the winning side instead of an empty book", async () => {
      const { desk, pool, market } = await deploy();
      await pool.write.clearBook([true]);
      await pool.write.clearBook([false]);
      await market.write.resolve([1n, 0n]);                            // YES wins

      const levels = await desk.read.getBookLevels([true, 1n]);
      expect(levels.length).to.equal(1);
      expect(levels[0].price).to.equal(10n ** 18n);
      expect(await desk.read.resolvedPrice18()).to.equal(10n ** 18n);
    });

    it("reports 0 for the losing side", async () => {
      const { desk, market } = await deploy();
      await market.write.resolve([0n, 1n]);                            // NO wins
      expect(await desk.read.resolvedPrice18()).to.equal(0n);
    });

    it("reports 0.5 for a voided market, matching the protocol's refund", async () => {
      const { desk, market } = await deploy();
      await market.write.void();
      expect(await desk.read.resolvedPrice18()).to.equal(5n * 10n ** 17n);
    });

    it("answers the same price on both sides, so the midpoint is the payout", async () => {
      const { desk, market } = await deploy();
      await market.write.resolve([1n, 0n]);
      const bid = await desk.read.getBookLevels([true, 1n]);
      const ask = await desk.read.getBookLevels([false, 1n]);
      expect((bid[0].price + ask[0].price) / 2n).to.equal(10n ** 18n);
    });

    it("still passes the live book through while the market is unresolved", async () => {
      const { desk, pool } = await deploy();
      await pool.write.setBookLevel([true, 100_000n, 5n]);
      const levels = await desk.read.getBookLevels([true, 1n]);
      expect(levels[0].price).to.equal(100_000n * SCALE);
    });
  });

  describe("order translation", () => {
    it("replaces Arena's expiry with the market's, which is the only reason it works", async () => {
      // Arena hard-codes +3600s. The pool reverts OrderExpiryBeyondMarket on
      // anything past its own expiry, so a forwarded value fails every time.
      const { desk, pool, arena } = await deploy();
      const shortExpiry = BigInt(Math.floor(Date.now() / 1000) + 60) * 1_000_000_000n;
      const nearPool = await hre.viem.deployContract("MockBinaryPool", [
        (await deploy()).collateral.address,
        (await deploy()).outcomeToken.address,
        (await deploy()).market.address,
        shortExpiry,
      ]);
      const nearDesk = await hre.viem.deployContract("EventDesk", [nearPool.address, arena.account.address]);

      const arenaExpiry = BigInt(Math.floor(Date.now() / 1000) + 3600) * 1_000_000_000n;
      expect(arenaExpiry).to.be.greaterThan(shortExpiry);              // Arena's value would revert

      await nearDesk.write.placeOrder(
        [true, 0n, 200_000n * SCALE, 1n * SCALE * 10n ** 6n, arenaExpiry, 0, 0,
         "0x0000000000000000000000000000000000000000", 0n],
        { account: arena.account },
      );
      expect(await nearPool.read.lastExpiry()).to.equal(shortExpiry);

      void desk; void pool;
    });

    it("maps a bid to BUY_YES and an ask to SELL_YES", async () => {
      const ctx = await deploy();
      await placeAsArena(ctx, true, 200_000n * SCALE, 10n ** 18n);
      expect(await ctx.pool.read.lastKind()).to.equal(0);              // BUY_YES

      await placeAsArena(ctx, false, 200_000n * SCALE, 10n ** 18n);
      expect(await ctx.pool.read.lastKind()).to.equal(1);              // SELL_YES
    });

    it("scales price and quantity back down to the pool's 6 decimals", async () => {
      const ctx = await deploy();
      await placeAsArena(ctx, true, 218_000n * SCALE, 10n ** 18n);     // 0.218, one contract
      expect(await ctx.pool.read.lastPrice()).to.equal(218_000n);
      expect(await ctx.pool.read.lastQuantity()).to.equal(10n ** 6n);
    });

    it("sends IOC, matching Arena's taker intent", async () => {
      const ctx = await deploy();
      await placeAsArena(ctx, true, 200_000n * SCALE, 10n ** 18n);
      expect(await ctx.pool.read.lastOrderType()).to.equal(2);
    });

    it("forwards userData untouched", async () => {
      const ctx = await deploy();
      await placeAsArena(ctx, true, 200_000n * SCALE, 10n ** 18n);
      expect(await ctx.pool.read.lastUserData()).to.equal(7n);
    });
  });

  describe("proceeds handling", () => {
    it("sweeps wallet-side fills back into the vault", async () => {
      // A binary pool pays fills and price improvement to the caller's address,
      // but Arena's affordability check only ever reads the vault. Value left
      // loose would be invisible to it.
      const ctx = await deploy();
      await ctx.pool.write.setPayoutOnFill([500_000n]);                // 0.5 collateral

      const vaultBefore = await ctx.pool.read.vault([ctx.desk.address]);
      await placeAsArena(ctx, false, 200_000n * SCALE, 10n ** 18n);

      expect(await ctx.collateral.read.balanceOf([ctx.desk.address])).to.equal(0n);
      expect(await ctx.pool.read.vault([ctx.desk.address])).to.equal(vaultBefore + 500_000n);
    });
  });

  describe("funding", () => {
    it("funds itself from the faucet and reports the balance in 18 decimals", async () => {
      const { desk, pool, collateral, arena } = await deploy();
      await desk.write.deposit(["0x0000000000000000000000000000000000000000", 50n * 10n ** 18n]);

      expect(await collateral.read.faucetCalls()).to.equal(1n);
      expect(await pool.read.vault([desk.address])).to.equal(50n * 10n ** 6n);
      // Arena asks about its own address; the desk answers with its vault position.
      expect(
        await desk.read.getWithdrawableBalance([arena.account.address, collateral.address]),
      ).to.equal(50n * 10n ** 18n);
    });
  });

  describe("pool parameters", () => {
    it("reports the trading grid scaled to 18 decimals", async () => {
      const { desk, collateral, outcomeToken } = await deploy();
      const [base, quote, , , tick, minQty, lot] = await desk.read.getPoolParams();

      expect(getAddress(base)).to.equal(getAddress(outcomeToken.address));
      expect(getAddress(quote)).to.equal(getAddress(collateral.address));
      expect(tick).to.equal(1000n * SCALE);
      expect(minQty).to.equal(1000n * SCALE);                          // 1e15, matching spot pools
      expect(lot).to.equal(1000n * SCALE);
    });
  });

  describe("access control", () => {
    it("only Arena may trade through the desk", async () => {
      const { desk, stranger } = await deploy();
      const expiry = BigInt(Math.floor(Date.now() / 1000) + 60) * 1_000_000_000n;
      await expect(
        desk.write.placeOrder(
          [true, 0n, 1n, 1n, expiry, 0, 0, "0x0000000000000000000000000000000000000000", 0n],
          { account: stranger.account },
        ),
      ).to.be.rejected;
    });

    it("only the owner may withdraw", async () => {
      const { desk, stranger, collateral } = await deploy();
      await expect(
        desk.write.withdraw([collateral.address, 1n], { account: stranger.account }),
      ).to.be.rejected;
    });
  });
});
