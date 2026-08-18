import { expect } from "chai";
import hre from "hardhat";
import { getAddress } from "viem";

// The desk speaks 18 decimals to Arena and 6 to the pool.
const SCALE = 10n ** 12n;

// A market expiry well in the future, in nanoseconds.
const MARKET_EXPIRY_NS = 2_000_000_000n * 1_000_000_000n;

// The window's id in the claims registry. Published only in the MarketCreated
// log, never readable off the pool — which is why bind() must be told it.
const MARKET_ID = "0x" + "11".repeat(32) as `0x${string}`;
const MARKET_ID_2 = "0x" + "22".repeat(32) as `0x${string}`;

async function deploy() {
  const [owner, arena, stranger] = await hre.viem.getWalletClients();

  const collateral   = await hre.viem.deployContract("MockFaucetToken");
  const outcomeToken = await hre.viem.deployContract("MockOutcomeToken");
  const market       = await hre.viem.deployContract("MockBinaryMarket");
  const pool         = await hre.viem.deployContract("MockBinaryPool", [
    collateral.address, outcomeToken.address, market.address, MARKET_EXPIRY_NS,
  ]);
  const modl = await hre.viem.deployContract("MockMarketsModule", [collateral.address, outcomeToken.address]);
  const desk = await hre.viem.deployContract("EventDesk", [arena.account.address, modl.address]);
  await desk.write.bind([pool.address, MARKET_ID]);

  const treasury = await hre.viem.deployContract("EventTreasury", [collateral.address]);
  await treasury.write.approveDesk([desk.address, true]);

  return { owner, arena, stranger, collateral, outcomeToken, market, pool, desk, treasury, modl };
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

  describe("re-binding between duels", () => {
    // One desk serves many duels. Arena keys balances and snapshots by duelId as
    // well as pool address, so re-pointing BETWEEN duels collides with nothing —
    // but doing it DURING one would corrupt a live position.
    async function secondWindow(ctx: Awaited<ReturnType<typeof deploy>>) {
      const market2 = await hre.viem.deployContract("MockBinaryMarket");
      const pool2 = await hre.viem.deployContract("MockBinaryPool", [
        ctx.collateral.address, ctx.outcomeToken.address, market2.address, MARKET_EXPIRY_NS,
      ]);
      return { pool2, market2 };
    }

    it("refuses to move while a duel holds the desk", async () => {
      const ctx = await deploy();
      const { pool2 } = await secondWindow(ctx);
      await ctx.desk.write.setInUse([true]);
      await expect(ctx.desk.write.bind([pool2.address, MARKET_ID_2])).to.be.rejected;
    });

    it("moves once the duel releases it", async () => {
      const ctx = await deploy();
      const { pool2, market2 } = await secondWindow(ctx);
      await ctx.desk.write.setInUse([true]);
      await ctx.desk.write.setInUse([false]);
      await ctx.desk.write.bind([pool2.address, MARKET_ID_2]);

      expect(getAddress(await ctx.desk.read.pool())).to.equal(getAddress(pool2.address));
      expect(getAddress(await ctx.desk.read.market())).to.equal(getAddress(market2.address));
    });

    it("carries its collateral across to the new window instead of stranding it", async () => {
      const ctx = await deploy();
      await ctx.treasury.write.refill([50n * 10n ** 6n]);
      await ctx.treasury.write.fundDesk([ctx.desk.address, 50n * 10n ** 6n]);
      const { pool2 } = await secondWindow(ctx);

      await ctx.desk.write.bind([pool2.address, MARKET_ID_2]);

      expect(await ctx.pool.read.vault([ctx.desk.address])).to.equal(0n);
      expect(await pool2.read.vault([ctx.desk.address])).to.equal(50n * 10n ** 6n);
    });

    it("refuses to abandon an unredeemed position", async () => {
      // A winning outcome token is real value. Silently walking away from it
      // would bleed the treasury one duel at a time.
      const ctx = await deploy();
      const yesId = await ctx.desk.read.yesId();
      await ctx.outcomeToken.write.mint([ctx.desk.address, yesId, 1n]);
      const { pool2 } = await secondWindow(ctx);

      await expect(ctx.desk.write.bind([pool2.address, MARKET_ID_2])).to.be.rejected;
    });

    it("forgets the previous window's cached price", async () => {
      // A fresh window has its own price history; carrying the old one across
      // would misvalue the new position during a blackout.
      const ctx = await deploy();
      await ctx.pool.write.setBookLevel([true, 173_000n, 200n]);
      await ctx.desk.write.poke();
      expect(await ctx.desk.read.lastGoodBid()).to.equal(173_000n);

      const { pool2 } = await secondWindow(ctx);
      await ctx.desk.write.bind([pool2.address, MARKET_ID_2]);
      expect(await ctx.desk.read.lastGoodBid()).to.equal(0n);
    });

    it("grants the new pool its own operator rights", async () => {
      const ctx = await deploy();
      const { pool2 } = await secondWindow(ctx);
      await ctx.desk.write.bind([pool2.address, MARKET_ID_2]);
      expect(await ctx.outcomeToken.read.isOperator([ctx.desk.address, pool2.address])).to.equal(true);
    });

    it("only the owner may bind or claim", async () => {
      const ctx = await deploy();
      const { pool2 } = await secondWindow(ctx);
      await expect(ctx.desk.write.bind([pool2.address, MARKET_ID_2], { account: ctx.stranger.account })).to.be.rejected;
      await expect(ctx.desk.write.setInUse([true], { account: ctx.stranger.account })).to.be.rejected;
    });
  });

  describe("claiming a settled position", () => {
    // Nothing is pushed to us when a market settles — the protocol holds the
    // money until it is asked for, and the request goes to a different place
    // than trading does, keyed by an id the pool never exposes.
    async function withWinningPosition() {
      const ctx = await deploy();
      const yesId = await ctx.desk.read.yesId();
      await ctx.outcomeToken.write.mint([ctx.desk.address, yesId, 5n * 10n ** 6n]);   // 5 contracts
      await ctx.market.write.resolve([1n, 0n]);                                       // YES wins
      await ctx.modl.write.setPayout([MARKET_ID, yesId, 10n ** 6n]);                  // 1.0 each
      return ctx;
    }

    it("collects the winnings and puts them back in the trading pot", async () => {
      const ctx = await withWinningPosition();
      const vaultBefore = await ctx.pool.read.vault([ctx.desk.address]);

      await ctx.desk.write.redeemSettled();

      expect(await ctx.desk.read.yesBalance18()).to.equal(0n);
      expect(await ctx.pool.read.vault([ctx.desk.address])).to.equal(vaultBefore + 5n * 10n ** 6n);
      expect(await ctx.collateral.read.balanceOf([ctx.desk.address])).to.equal(0n);   // swept
    });

    it("grants the claims registry its own permission, which the pool's does not cover", async () => {
      const ctx = await withWinningPosition();
      expect(await ctx.outcomeToken.read.isOperator([ctx.desk.address, ctx.modl.address])).to.equal(false);
      await ctx.desk.write.redeemSettled();
      expect(await ctx.outcomeToken.read.isOperator([ctx.desk.address, ctx.modl.address])).to.equal(true);
    });

    it("leaves a still-trading position alone", async () => {
      // Claiming early is meaningless and the position may still be sellable.
      const ctx = await deploy();
      const yesId = await ctx.desk.read.yesId();
      await ctx.outcomeToken.write.mint([ctx.desk.address, yesId, 10n ** 6n]);
      await ctx.modl.write.setPayout([MARKET_ID, yesId, 10n ** 6n]);

      await ctx.desk.write.redeemSettled();
      expect(await ctx.desk.read.yesBalance18()).to.equal(10n ** 18n);                // untouched
    });

    it("does nothing when there is no position", async () => {
      const ctx = await deploy();
      await ctx.market.write.resolve([1n, 0n]);
      await ctx.desk.write.redeemSettled();                                            // must not revert
    });

    it("burns a losing position without collecting anything", async () => {
      const ctx = await deploy();
      const yesId = await ctx.desk.read.yesId();
      await ctx.outcomeToken.write.mint([ctx.desk.address, yesId, 3n * 10n ** 6n]);
      await ctx.market.write.resolve([0n, 1n]);                                        // YES loses
      await ctx.modl.write.setPayout([MARKET_ID, yesId, 0n]);

      const vaultBefore = await ctx.pool.read.vault([ctx.desk.address]);
      await ctx.desk.write.redeemSettled();
      expect(await ctx.desk.read.yesBalance18()).to.equal(0n);
      expect(await ctx.pool.read.vault([ctx.desk.address])).to.equal(vaultBefore);
    });

    it("survives a registry that refuses the claim", async () => {
      // An unknown or already-claimed market must not brick the desk.
      const ctx = await deploy();
      const yesId = await ctx.desk.read.yesId();
      await ctx.outcomeToken.write.mint([ctx.desk.address, yesId, 10n ** 6n]);
      await ctx.market.write.resolve([1n, 0n]);
      // No setPayout — the registry does not know this market.
      await ctx.desk.write.redeemSettled();                                            // must not revert
      expect(await ctx.desk.read.yesBalance18()).to.equal(10n ** 18n);
    });

    it("is permissionless, because it can only move our own money inward", async () => {
      const ctx = await withWinningPosition();
      await ctx.desk.write.redeemSettled({ account: ctx.stranger.account });
      expect(await ctx.desk.read.yesBalance18()).to.equal(0n);
    });

    it("frees a desk that would otherwise be stuck behind an uncollected win", async () => {
      // This is the capacity leak: without collection the desk refuses to move
      // to a new window, and with six desks you lose a slot at a time.
      const ctx = await withWinningPosition();
      const market2 = await hre.viem.deployContract("MockBinaryMarket");
      const pool2 = await hre.viem.deployContract("MockBinaryPool", [
        ctx.collateral.address, ctx.outcomeToken.address, market2.address, MARKET_EXPIRY_NS,
      ]);

      // bind collects first, so the move succeeds instead of reverting.
      await ctx.desk.write.bind([pool2.address, MARKET_ID_2]);
      expect(getAddress(await ctx.desk.read.pool())).to.equal(getAddress(pool2.address));
      expect(await pool2.read.vault([ctx.desk.address])).to.equal(5n * 10n ** 6n);   // winnings came along
    });

    it("refuses to bind without a market id, which would make claiming impossible", async () => {
      const ctx = await deploy();
      const market2 = await hre.viem.deployContract("MockBinaryMarket");
      const pool2 = await hre.viem.deployContract("MockBinaryPool", [
        ctx.collateral.address, ctx.outcomeToken.address, market2.address, MARKET_EXPIRY_NS,
      ]);
      const ZERO32 = ("0x" + "00".repeat(32)) as `0x${string}`;
      await expect(ctx.desk.write.bind([pool2.address, ZERO32])).to.be.rejected;
    });
  });

  describe("EventTreasury", () => {
    it("refills past the faucet's per-call cap by chunking", async () => {
      // Measured on testnet: faucet(10000) is the ceiling, faucet(100000) reverts.
      const { treasury, collateral } = await deploy();
      await treasury.write.refill([25_000n * 10n ** 6n]);
      expect(await treasury.read.balance()).to.equal(25_000n * 10n ** 6n);
      expect(await collateral.read.faucetCalls()).to.equal(3n);      // 10k + 10k + 5k
    });

    it("will not fund a desk it has not approved", async () => {
      const { treasury, arena } = await deploy();
      const rogue = await hre.viem.deployContract("EventDesk", [arena.account.address, treasury.address]);
      await treasury.write.refill([10n ** 6n]);
      await expect(treasury.write.fundDesk([rogue.address, 10n ** 6n])).to.be.rejected;
    });

    it("leaves no standing allowance after funding", async () => {
      const { treasury, desk, collateral } = await deploy();
      await treasury.write.refill([10n * 10n ** 6n]);
      await treasury.write.fundDesk([desk.address, 10n * 10n ** 6n]);
      expect(await collateral.read.allowance([treasury.address, desk.address])).to.equal(0n);
    });

    it("only the owner may approve or fund", async () => {
      const { treasury, desk, stranger } = await deploy();
      await treasury.write.refill([10n ** 6n]);
      await expect(
        treasury.write.approveDesk([desk.address, true], { account: stranger.account }),
      ).to.be.rejected;
      await expect(
        treasury.write.fundDesk([desk.address, 10n ** 6n], { account: stranger.account }),
      ).to.be.rejected;
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

  describe("maker blackout, before expiry", () => {
    // Observed live 2026-08-13: a 15-minute BTC window sat with a completely
    // empty book for its last ~7.5 minutes while still in Trading status. No
    // maker quotes a binary about to settle. Without this, Arena reads an empty
    // book, computes a mark price of zero, and values a real position at
    // nothing for half the window.
    it("serves the last known price when the book empties mid-life", async () => {
      const { desk, pool } = await deploy();
      await pool.write.setBookLevel([true, 173_000n, 200n]);
      await pool.write.setBookLevel([false, 198_000n, 200n]);
      await desk.write.poke();

      await pool.write.clearBook([true]);
      await pool.write.clearBook([false]);

      const bid = await desk.read.getBookLevels([true, 1n]);
      const ask = await desk.read.getBookLevels([false, 1n]);
      expect(bid[0].price).to.equal(173_000n * SCALE);
      expect(ask[0].price).to.equal(198_000n * SCALE);
      // Arena's midMarkPrice reads price only, so valuation survives the blackout.
      expect((bid[0].price + ask[0].price) / 2n).to.equal(185_500n * SCALE);
    });

    it("reports zero quantity, so Arena rejects the trade instead of sending it", async () => {
      // The price is knowable; the liquidity is not. Arena's own
      // `levels[0].quantity == 0` check turns this into a clean "empty book"
      // rejection rather than an order into a dead market.
      const { desk, pool } = await deploy();
      await pool.write.setBookLevel([true, 173_000n, 200n]);
      await desk.write.poke();
      await pool.write.clearBook([true]);

      const bid = await desk.read.getBookLevels([true, 1n]);
      expect(bid[0].quantity).to.equal(0n);
    });

    it("stays empty when it has never seen a price", async () => {
      const { desk } = await deploy();
      expect((await desk.read.getBookLevels([true, 1n])).length).to.equal(0);
    });

    it("caches the book on every trade, not just on poke", async () => {
      const ctx = await deploy();
      await ctx.pool.write.setBookLevel([true, 150_000n, 200n]);
      await ctx.pool.write.setBookLevel([false, 160_000n, 200n]);
      await placeAsArena(ctx, true, 160_000n * SCALE, 10n ** 18n);
      expect(await ctx.desk.read.lastGoodBid()).to.equal(150_000n);
      expect(await ctx.desk.read.lastGoodAsk()).to.equal(160_000n);
    });

    it("prefers the settled payout over the cached price once resolved", async () => {
      const { desk, pool, market } = await deploy();
      await pool.write.setBookLevel([true, 173_000n, 200n]);
      await desk.write.poke();
      await pool.write.clearBook([true]);
      await market.write.resolve([1n, 0n]);

      const bid = await desk.read.getBookLevels([true, 1n]);
      expect(bid[0].price).to.equal(10n ** 18n);          // 1.0, not the cached 0.173
    });
  });

  describe("order translation", () => {
    it("replaces Arena's expiry with the market's, which is the only reason it works", async () => {
      // Arena hard-codes +3600s. The pool reverts OrderExpiryBeyondMarket on
      // anything past its own expiry, so a forwarded value fails every time.
      // Confirmed against the live chain 2026-08-13: tx 0xaf42c76b, where
      // Arena's expiry sat 2816s beyond the market's and the order still filled.
      const ctx = await deploy();
      const shortExpiry = BigInt(Math.floor(Date.now() / 1000) + 60) * 1_000_000_000n;
      const nearPool = await hre.viem.deployContract("MockBinaryPool", [
        ctx.collateral.address, ctx.outcomeToken.address, ctx.market.address, shortExpiry,
      ]);
      const nearDesk = await hre.viem.deployContract("EventDesk", [ctx.arena.account.address, ctx.modl.address]);
      await nearDesk.write.bind([nearPool.address, MARKET_ID]);

      const arenaExpiry = BigInt(Math.floor(Date.now() / 1000) + 3600) * 1_000_000_000n;
      expect(arenaExpiry).to.be.greaterThan(shortExpiry);              // Arena's value would revert

      await nearDesk.write.placeOrder(
        [true, 0n, 200_000n * SCALE, 10n ** 18n, arenaExpiry, 0, 0,
         "0x0000000000000000000000000000000000000000", 0n],
        { account: ctx.arena.account },
      );
      expect(await nearPool.read.lastExpiry()).to.equal(shortExpiry);
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
    it("receives collateral from the treasury and reports it in 18 decimals", async () => {
      const { desk, pool, collateral, treasury, arena } = await deploy();
      await treasury.write.refill([50n * 10n ** 6n]);
      await treasury.write.fundDesk([desk.address, 50n * 10n ** 6n]);

      expect(await pool.read.vault([desk.address])).to.equal(50n * 10n ** 6n);
      // Arena asks about its own address; the desk answers with its vault position.
      expect(
        await desk.read.getWithdrawableBalance([arena.account.address, collateral.address]),
      ).to.equal(50n * 10n ** 18n);
    });

    it("knows nothing about faucets, so it can fund on mainnet too", async () => {
      // A faucet call inside the desk would revert against USDso, which has none.
      const { desk, collateral, owner } = await deploy();
      await collateral.write.mint([owner.account.address, 10n ** 6n]);
      await collateral.write.approve([desk.address, 10n ** 6n]);
      await desk.write.fund([10n ** 6n]);
      expect(await collateral.read.faucetCalls()).to.equal(0n);
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
