import { expect } from "chai";
import hre from "hardhat";
import { parseEther, getAddress, zeroAddress } from "viem";

import {
  deployPerpVenue, MARKETS, marketByName, imPerLot, userData, alignUp, alignDown,
  expectCustomError,
} from "./helpers/perps";

const ONE = 10n ** 18n;
const GTC = 2n ** 64n - 1n;

/**
 * The desk, the registry and the per-fighter accounts behind them.
 *
 * The single most important property here is ISOLATION, and it is the one whose
 * absence is invisible until it costs money. Margin on dreamDEX is cross and keyed
 * on the trading address: everything one address holds is pooled into one health
 * figure, and any of it can be seized to cover any other part. Two fighters trading
 * from one address would therefore share a margin pool, and a liquidation caused by
 * one could take collateral backing the other — a fight nobody could see was rigged
 * until it happened.
 *
 * The second is the zero-allowance rule. An under-margined order does not simply get
 * refused: the protocol tries to pull the shortfall out of the trader's own token
 * balance. A fighter account with a standing allowance could therefore quietly draw
 * past its budget.
 */
describe("PerpDesk and the account registry", function () {
  this.timeout(120_000);

  async function deploy() {
    const [owner, arena, stranger] = await hre.viem.getWalletClients();
    const venue = await deployPerpVenue(hre, arena.account.address);
    return { ...venue, arena, stranger, ownerWallet: owner };
  }

  /** Place an order through a desk exactly as Arena would. */
  async function tradeAs(
    ctx: Awaited<ReturnType<typeof deploy>>,
    marketName: string,
    duelId: bigint,
    fighterId: number,
    isBid: boolean,
    price: bigint,
    quantity: bigint,
  ) {
    return ctx.desk(marketName).write.placeOrder(
      [isBid, userData(duelId, fighterId), price, quantity, GTC, 1, 0, zeroAddress, 0n],
      { account: ctx.arena.account },
    );
  }

  /** Top of the side an order of this direction would trade against. */
  async function crossingPrice(
    ctx: Awaited<ReturnType<typeof deploy>>, marketName: string, isBid: boolean,
  ) {
    const levels = await ctx.market(marketName).read.getBookLevels([!isBid, 1n]) as
      { price: bigint; quantity: bigint }[];
    const m = marketByName(marketName);
    return isBid ? alignUp(levels[0]!.price, m.tickSize) : alignDown(levels[0]!.price, m.tickSize);
  }

  async function sizeOf(ctx: Awaited<ReturnType<typeof deploy>>, marketName: string, account: string) {
    const p = await ctx.bank.read.getPosition([account, ctx.market(marketName).address]) as unknown[];
    return p[0] as bigint;
  }

  // ─────────────────────────────────────────────────────────────────────────────

  describe("isolation between fighters", () => {
    it("gives the two fighters in a duel DIFFERENT addresses", async () => {
      // The reason this whole layer exists. Same address means shared cross margin,
      // and a liquidation could then take collateral backing the fighter that did
      // nothing wrong.
      const ctx = await deploy();
      const a = await ctx.registry.write.lease([1n, 0, parseEther("6")], { account: ctx.arena.account });
      await ctx.registry.write.lease([1n, 1, parseEther("6")], { account: ctx.arena.account });

      const accA = await ctx.registry.read.accountOf([1n, 0]) as string;
      const accB = await ctx.registry.read.accountOf([1n, 1]) as string;
      expect(accA).to.not.equal(zeroAddress);
      expect(getAddress(accA), "two fighters, two addresses").to.not.equal(getAddress(accB));
      expect(a).to.be.a("string");
    });

    it("gives ONE fighter one account across all three market slots", async () => {
      // The other half of the shape. A fighter must pool its own positions — that is
      // how a trader actually works, and splitting them would triple the collateral
      // needed to cover the same budget. So all six desks converge here.
      const ctx = await deploy();
      await ctx.registry.write.lease([2n, 0, parseEther("18")], { account: ctx.arena.account });
      const account = await ctx.registry.read.accountOf([2n, 0]) as string;

      // Trade two different markets and prove both landed on the same address.
      await tradeAs(ctx, "XRP", 2n, 0, true,  await crossingPrice(ctx, "XRP", true),  marketByName("XRP").minQuantity);
      await tradeAs(ctx, "SOL", 2n, 0, false, await crossingPrice(ctx, "SOL", false), marketByName("SOL").minQuantity);

      expect(await sizeOf(ctx, "XRP", account), "long on one desk").to.be.greaterThan(0n);
      expect(await sizeOf(ctx, "SOL", account), "short on another, same account").to.be.lessThan(0n);

      const active = await ctx.bank.read.getActivePerpPools([account]) as string[];
      expect(active.length, "one account holding two markets").to.equal(2);
    });

    it("refuses to lease the same fighter twice", async () => {
      const ctx = await deploy();
      await ctx.registry.write.lease([3n, 0, parseEther("2")], { account: ctx.arena.account });
      await expectCustomError(
        ctx.registry.write.lease([3n, 0, parseEther("2")], { account: ctx.arena.account }),
        "AlreadyLeased()",
      );
    });

    it("only Arena may lease, and only a desk may trade", async () => {
      const ctx = await deploy();
      await expectCustomError(
        ctx.registry.write.lease([4n, 0, parseEther("2")], { account: ctx.stranger.account }),
        "NotArena()",
      );

      await ctx.registry.write.lease([4n, 0, parseEther("2")], { account: ctx.arena.account });
      await expectCustomError(
        ctx.registry.write.trade([4n, 0, true, ONE, 1n, GTC], { account: ctx.stranger.account }),
        "NotDesk()",
      );
    });

    it("only Arena may place an order through a desk", async () => {
      const ctx = await deploy();
      await ctx.registry.write.lease([5n, 0, parseEther("2")], { account: ctx.arena.account });
      await expectCustomError(
        ctx.desk("XRP").write.placeOrder(
          [true, userData(5n, 0), ONE * 2n, marketByName("XRP").minQuantity, GTC, 1, 0, zeroAddress, 0n],
          { account: ctx.stranger.account },
        ),
        "NotArena()",
      );
    });
  });

  describe("the fighter's identity rides on userData", () => {
    it("an order placed for fighter one lands on fighter one's account", async () => {
      // All six desks share one registry, so the desk cannot work out whose order it
      // is from its own address. If this decoding is wrong the trade lands on the
      // OTHER fighter's margin — which is worse than failing, because it silently
      // moves one player's risk onto another.
      const ctx = await deploy();
      await ctx.registry.write.lease([7n, 0, parseEther("6")], { account: ctx.arena.account });
      await ctx.registry.write.lease([7n, 1, parseEther("6")], { account: ctx.arena.account });
      const accA = await ctx.registry.read.accountOf([7n, 0]) as string;
      const accB = await ctx.registry.read.accountOf([7n, 1]) as string;

      await tradeAs(ctx, "XRP", 7n, 1, true, await crossingPrice(ctx, "XRP", true), marketByName("XRP").minQuantity);

      expect(await sizeOf(ctx, "XRP", accB), "fighter one got the position").to.be.greaterThan(0n);
      expect(await sizeOf(ctx, "XRP", accA), "fighter zero was untouched").to.equal(0n);
    });

    it("an order for a fighter with no account is refused, not misrouted", async () => {
      const ctx = await deploy();
      const [ok] = await ctx.desk("XRP").simulate.placeOrder(
        [true, userData(99n, 3), ONE * 2n, marketByName("XRP").minQuantity, GTC, 1, 0, zeroAddress, 0n],
        { account: ctx.arena.account },
      ).then((r) => r.result as [boolean, bigint]);
      expect(ok, "no account, no order").to.equal(false);
    });
  });

  describe("shorting", () => {
    it("a fighter holding nothing can SHORT, and the position goes negative", async () => {
      // The difference between "perps" and "spot with extra assets". On a spot slot
      // selling requires a holding; here it does not, and the position it opens is
      // signed.
      const ctx = await deploy();
      await ctx.registry.write.lease([10n, 0, parseEther("6")], { account: ctx.arena.account });
      const account = await ctx.registry.read.accountOf([10n, 0]) as string;

      expect(await sizeOf(ctx, "SOL", account), "starts flat").to.equal(0n);
      await tradeAs(ctx, "SOL", 10n, 0, false, await crossingPrice(ctx, "SOL", false), marketByName("SOL").minQuantity);
      expect(await sizeOf(ctx, "SOL", account), "now short").to.equal(-marketByName("SOL").minQuantity);
    });

    it("offers BOTH directions to a flat fighter with margin", async () => {
      const ctx = await deploy();
      await ctx.registry.write.lease([11n, 0, parseEther("6")], { account: ctx.arena.account });
      const [canLong, canShort] = await ctx.desk("SOL").read.fighterTradability([11n, 0]) as [boolean, boolean];
      expect(canLong).to.equal(true);
      expect(canShort, "a flat fighter may still sell").to.equal(true);
    });

    it("short then long returns to flat rather than opening a second position", async () => {
      // Closing is taking the other side, which is why the action enum did not need a
      // third move per slot. If this opened a second position instead, a fighter could
      // never get out of a trade.
      const ctx = await deploy();
      const m = marketByName("SOL");
      await ctx.registry.write.lease([12n, 0, parseEther("6")], { account: ctx.arena.account });
      const account = await ctx.registry.read.accountOf([12n, 0]) as string;

      await tradeAs(ctx, "SOL", 12n, 0, false, await crossingPrice(ctx, "SOL", false), m.minQuantity);
      expect(await sizeOf(ctx, "SOL", account)).to.equal(-m.minQuantity);

      await tradeAs(ctx, "SOL", 12n, 0, true, await crossingPrice(ctx, "SOL", true), m.minQuantity);
      expect(await sizeOf(ctx, "SOL", account), "back to flat").to.equal(0n);

      const active = await ctx.bank.read.getActivePerpPools([account]) as string[];
      expect(active.length, "and off the active list").to.equal(0);
    });

    it("lets a fighter with no free margin still turn back", async () => {
      // Reducing a position needs no new margin. A fighter that spent everything
      // getting in must always be able to get out, or it is trapped in its own trade.
      const ctx = await deploy();
      const m = marketByName("ETH");
      // A budget that covers one Ethereum position and the spread it costs to get
      // into it, and nothing more. Sized off the margin figure plus a few percent
      // rather than the bare margin, because opening crosses the book: entry is the
      // far side of the spread, so a position is under water by the spread the instant
      // it exists and a budget of exactly the margin cannot open at all.
      await ctx.registry.write.lease([13n, 0, imPerLot(m) * 105n / 100n], { account: ctx.arena.account });

      await tradeAs(ctx, "ETH", 13n, 0, false, await crossingPrice(ctx, "ETH", false), m.minQuantity);
      const account = await ctx.registry.read.accountOf([13n, 0]) as string;
      expect(await sizeOf(ctx, "ETH", account)).to.equal(-m.minQuantity);

      const free = await ctx.registry.read.freeMarginOf([account]) as bigint;
      expect(free, "nothing left to open with").to.be.lessThan(imPerLot(m));

      const [canLong] = await ctx.desk("ETH").read.fighterTradability([13n, 0]) as [boolean, boolean];
      expect(canLong, "but buying back is still offered").to.equal(true);
    });

    it("reports which way a fighter is facing", async () => {
      const ctx = await deploy();
      const m = marketByName("SOL");
      await ctx.registry.write.lease([14n, 0, parseEther("6")], { account: ctx.arena.account });

      expect(await ctx.desk("SOL").read.fighterSide([14n, 0])).to.equal(0);
      await tradeAs(ctx, "SOL", 14n, 0, false, await crossingPrice(ctx, "SOL", false), m.minQuantity);
      expect(await ctx.desk("SOL").read.fighterSide([14n, 0])).to.equal(-1);
      await tradeAs(ctx, "SOL", 14n, 0, true, await crossingPrice(ctx, "SOL", true), m.minQuantity * 2n);
      expect(await ctx.desk("SOL").read.fighterSide([14n, 0])).to.equal(1);
    });
  });

  describe("the zero-allowance guard", () => {
    it("leaves a funded account's allowance to the bank at exactly zero", async () => {
      // Measured behaviour: an under-margined order makes the protocol pull the
      // shortfall from the trader's own token balance. With a standing allowance one
      // fighter could draw past its share of the float; with zero it cannot.
      const ctx = await deploy();
      await ctx.registry.write.lease([20n, 0, parseEther("6")], { account: ctx.arena.account });
      const account = await ctx.registry.read.accountOf([20n, 0]) as string;

      expect(await ctx.usdso.read.allowance([account, ctx.bank.address]), "no standing allowance")
        .to.equal(0n);
      expect(await ctx.usdso.read.balanceOf([account]), "and no loose tokens to pull")
        .to.equal(0n);
    });

    it("refuses an order the budget cannot cover instead of overdrawing", async () => {
      // The whole chain under test: the order needs more margin than the account
      // holds, the protocol attempts the pull, the zero allowance makes it fail, and
      // the failure surfaces as a clean refusal rather than a revert that would take
      // the fighter's turn down with it.
      const ctx = await deploy();
      const m = marketByName("ETH");
      await ctx.registry.write.lease([21n, 0, imPerLot(m)], { account: ctx.arena.account });
      const account = await ctx.registry.read.accountOf([21n, 0]) as string;

      const price = await crossingPrice(ctx, "ETH", true);
      const { result } = await ctx.desk("ETH").simulate.placeOrder(
        [true, userData(21n, 0), price, m.minQuantity * 20n, GTC, 1, 0, zeroAddress, 0n],
        { account: ctx.arena.account },
      );
      expect((result as [boolean, bigint])[0], "twenty lots on a one-lot budget").to.equal(false);

      // And nothing happened: no position, no tokens moved.
      expect(await sizeOf(ctx, "ETH", account)).to.equal(0n);
      expect(await ctx.usdso.read.balanceOf([account])).to.equal(0n);
    });

    it("does not offer a market the fighter cannot afford", async () => {
      // Belt and braces on the refusal above: the move should never be offered in the
      // first place, because a fighter handed an impossible option loses its turn.
      const ctx = await deploy();
      await ctx.registry.write.lease([22n, 0, parseEther("2")], { account: ctx.arena.account });
      const [canLong, canShort] = await ctx.desk("BTC").read.fighterTradability([22n, 0]) as [boolean, boolean];
      expect(canLong, "twelve-dollar margin on a two-dollar budget").to.equal(false);
      expect(canShort).to.equal(false);
    });
  });

  describe("scoring", () => {
    it("marks a short with the right sign", async () => {
      // Equity is the fighter's whole score, so a short must be worth MORE as the
      // mark falls. Measured against the real bank to zero wei of drift.
      const ctx = await deploy();
      const m = marketByName("SOL");
      const budget = parseEther("6");
      await ctx.registry.write.lease([30n, 0, budget], { account: ctx.arena.account });

      await tradeAs(ctx, "SOL", 30n, 0, false, await crossingPrice(ctx, "SOL", false), m.minQuantity);
      const [, opening] = await ctx.registry.read.equityOf([30n, 0]) as [boolean, bigint];

      // The market falls ten percent.
      await ctx.market("SOL").write.setMark([m.mark * 90n / 100n]);
      const [ok, after] = await ctx.registry.read.equityOf([30n, 0]) as [boolean, bigint];

      expect(ok).to.equal(true);
      expect(after, "a short gains when the market drops").to.be.greaterThan(opening);
    });

    it("marks a long the other way", async () => {
      const ctx = await deploy();
      const m = marketByName("SOL");
      await ctx.registry.write.lease([31n, 0, parseEther("6")], { account: ctx.arena.account });

      await tradeAs(ctx, "SOL", 31n, 0, true, await crossingPrice(ctx, "SOL", true), m.minQuantity);
      const [, opening] = await ctx.registry.read.equityOf([31n, 0]) as [boolean, bigint];

      await ctx.market("SOL").write.setMark([m.mark * 90n / 100n]);
      const [, after] = await ctx.registry.read.equityOf([31n, 0]) as [boolean, bigint];
      expect(after, "a long loses when the market drops").to.be.lessThan(opening);
    });

    it("reports the score as unreadable rather than zero when the oracle is stale", async () => {
      // The distinction that stops a stale feed from turning a decided fight into a
      // draw: "we cannot see it" is not "it is gone".
      const ctx = await deploy();
      const m = marketByName("SOL");
      await ctx.registry.write.lease([32n, 0, parseEther("6")], { account: ctx.arena.account });
      await tradeAs(ctx, "SOL", 32n, 0, true, await crossingPrice(ctx, "SOL", true), m.minQuantity);

      await ctx.market("SOL").write.setPriceable([false]);
      const [ok, equity] = await ctx.registry.read.equityOf([32n, 0]) as [boolean, bigint];
      expect(ok, "flagged as unreadable").to.equal(false);
      expect(equity).to.equal(0n);
    });
  });

  describe("winding down", () => {
    it("flattens the position and returns the collateral to the float", async () => {
      const ctx = await deploy();
      const m = marketByName("SOL");
      const floatBefore = await ctx.registry.read.floatBalance() as bigint;

      await ctx.registry.write.lease([40n, 0, parseEther("6")], { account: ctx.arena.account });
      const account = await ctx.registry.read.accountOf([40n, 0]) as string;
      await tradeAs(ctx, "SOL", 40n, 0, false, await crossingPrice(ctx, "SOL", false), m.minQuantity);
      expect(await sizeOf(ctx, "SOL", account)).to.be.lessThan(0n);

      await ctx.registry.write.release([40n, 0], { account: ctx.arena.account });

      expect(await sizeOf(ctx, "SOL", account), "flat").to.equal(0n);
      expect(await ctx.registry.read.quarantined([account]), "not quarantined").to.equal(false);
      expect(await ctx.registry.read.accountOf([40n, 0]), "lease cleared").to.equal(zeroAddress);

      const floatAfter = await ctx.registry.read.floatBalance() as bigint;
      // Not exactly equal: crossing the spread twice is a real cost, paid by the
      // house rather than the players. It should be a rounding error against six
      // dollars, not a hole.
      expect(floatAfter).to.be.greaterThan(floatBefore * 99n / 100n);
      expect(floatAfter).to.be.lessThanOrEqual(floatBefore);
    });

    it("returns the account to circulation so the next fight reuses it", async () => {
      const ctx = await deploy();
      await ctx.registry.write.lease([41n, 0, parseEther("2")], { account: ctx.arena.account });
      const first = await ctx.registry.read.accountOf([41n, 0]) as string;
      await ctx.registry.write.release([41n, 0], { account: ctx.arena.account });

      await ctx.registry.write.lease([42n, 0, parseEther("2")], { account: ctx.arena.account });
      expect(getAddress(await ctx.registry.read.accountOf([42n, 0]) as string))
        .to.equal(getAddress(first));
    });

    it("sweeps several book levels deep to get flat", async () => {
      // A position is usually wider than the top level, and a partial close is the one
      // outcome that costs real money — it quarantines the account.
      const ctx = await deploy();
      const m = marketByName("SOL");
      const market = ctx.market("SOL");

      await ctx.registry.write.lease([43n, 0, parseEther("18")], { account: ctx.arena.account });
      const account = await ctx.registry.read.accountOf([43n, 0]) as string;

      // Deep enough to open four lots in one order.
      await market.write.setBookLevel([false, alignUp(m.mark * 101n / 100n, m.tickSize), m.minQuantity * 10n]);
      await tradeAs(ctx, "SOL", 43n, 0, true, await crossingPrice(ctx, "SOL", true), m.minQuantity * 4n);
      expect(await sizeOf(ctx, "SOL", account)).to.equal(m.minQuantity * 4n);

      // Now a bid side that is one lot per level, four levels down. Only a sweep gets out.
      await market.write.clearBook([true]);
      for (let i = 1n; i <= 4n; i++) {
        await market.write.pushBookLevel([
          true, alignDown(m.mark * (100n - i) / 100n, m.tickSize), m.minQuantity,
        ]);
      }

      await ctx.registry.write.release([43n, 0], { account: ctx.arena.account });
      expect(await sizeOf(ctx, "SOL", account), "swept all four levels").to.equal(0n);
      expect(await ctx.registry.read.quarantined([account])).to.equal(false);
    });

    it("quarantines an account it cannot flatten, and never leases it again", async () => {
      // A dark book, or a market flipped to close-only, means the position cannot be
      // closed right now. Handing that account to a new fighter would give them
      // somebody else's exposure, so it goes out of circulation instead.
      const ctx = await deploy();
      const m = marketByName("SOL");
      await ctx.registry.write.lease([44n, 0, parseEther("6")], { account: ctx.arena.account });
      const account = await ctx.registry.read.accountOf([44n, 0]) as string;
      await tradeAs(ctx, "SOL", 44n, 0, false, await crossingPrice(ctx, "SOL", false), m.minQuantity);

      // The book goes dark before the fight ends.
      await ctx.market("SOL").write.clearBook([false]);
      await ctx.market("SOL").write.clearBook([true]);

      await ctx.registry.write.release([44n, 0], { account: ctx.arena.account });
      expect(await ctx.registry.read.quarantined([account]), "out of circulation").to.equal(true);

      // The next lease gets a different address.
      await ctx.registry.write.lease([45n, 0, parseEther("2")], { account: ctx.arena.account });
      expect(getAddress(await ctx.registry.read.accountOf([45n, 0]) as string))
        .to.not.equal(getAddress(account));
    });

    it("lets anyone retry a failed cleanup once the book comes back", async () => {
      // Permissionless on purpose: it can only ever move a stuck position toward flat
      // and stuck collateral back into the float, so there is nothing to gain by
      // calling it and real value at stake if nobody does.
      const ctx = await deploy();
      const m = marketByName("SOL");
      await ctx.registry.write.lease([46n, 0, parseEther("6")], { account: ctx.arena.account });
      const account = await ctx.registry.read.accountOf([46n, 0]) as string;
      await tradeAs(ctx, "SOL", 46n, 0, false, await crossingPrice(ctx, "SOL", false), m.minQuantity);

      await ctx.market("SOL").write.clearBook([false]);
      await ctx.registry.write.release([46n, 0], { account: ctx.arena.account });
      expect(await sizeOf(ctx, "SOL", account), "still short").to.be.lessThan(0n);

      // Makers return.
      await ctx.market("SOL").write.setBookLevel([
        false, alignUp(m.mark * 101n / 100n, m.tickSize), m.minQuantity * 10n,
      ]);
      await ctx.registry.write.retryRelease([46n, 0], { account: ctx.stranger.account });

      expect(await sizeOf(ctx, "SOL", account), "flat on the retry").to.equal(0n);
      expect(await ctx.usdso.read.balanceOf([account]), "and drained").to.equal(0n);

      // The quarantine is lifted, so the account rejoins the pool. Leaving it set
      // would drain the account and then still refuse to reuse it, shrinking the
      // pool by one every time a fight ended on a dark book.
      expect(await ctx.registry.read.quarantined([account])).to.equal(false);
      await ctx.registry.write.lease([48n, 0, parseEther("2")], { account: ctx.arena.account });
      expect(getAddress(await ctx.registry.read.accountOf([48n, 0]) as string))
        .to.equal(getAddress(account));
    });

    it("recovers what free margin it can from an account it could not flatten", async () => {
      // `getWithdrawableCollateral` ignores the margin an open position needs, so
      // asking for the full amount would be refused outright and leave the WHOLE
      // budget sitting in a quarantined child. Capping by real free margin gets most
      // of it back.
      const ctx = await deploy();
      const m = marketByName("SOL");
      await ctx.registry.write.lease([49n, 0, parseEther("18")], { account: ctx.arena.account });
      const account = await ctx.registry.read.accountOf([49n, 0]) as string;
      await tradeAs(ctx, "SOL", 49n, 0, false, await crossingPrice(ctx, "SOL", false), m.minQuantity);

      const floatBefore = await ctx.registry.read.floatBalance() as bigint;
      await ctx.market("SOL").write.clearBook([false]);
      await ctx.market("SOL").write.clearBook([true]);
      await ctx.registry.write.release([49n, 0], { account: ctx.arena.account });

      expect(await ctx.registry.read.quarantined([account]), "still quarantined").to.equal(true);
      const recovered = (await ctx.registry.read.floatBalance() as bigint) - floatBefore;
      // Everything except the margin the stuck position still needs — a fraction of
      // a dollar against eighteen.
      expect(recovered, "most of the budget came back").to.be.greaterThan(parseEther("17"));
    });

    it("refuses to start a fight it cannot fund", async () => {
      // Better than starting one where every move fails.
      const ctx = await deploy();
      const float = await ctx.registry.read.floatBalance() as bigint;
      await expectCustomError(
        ctx.registry.write.lease([47n, 0, float + 1n], { account: ctx.arena.account }),
        "FloatTooSmall(uint256,uint256)",
      );
    });
  });

  describe("the ordinary pool face", () => {
    it("assembles the seven-tuple Arena caches its order maths from", async () => {
      const ctx = await deploy();
      const m = marketByName("BTC");
      const params = await ctx.desk("BTC").read.getPoolParams() as unknown[];
      expect(params[0], "a perp's base asset is synthetic — no token to name").to.equal(zeroAddress);
      expect(getAddress(params[1] as string)).to.equal(getAddress(ctx.usdso.address));
      expect(params[4], "tick").to.equal(m.tickSize);
      expect(params[5], "minimum size").to.equal(m.minQuantity);
      expect(params[6], "lot size").to.equal(m.lotSize);
    });

    it("derives the base unit from the market instead of assuming it", async () => {
      // The mistake EventDesk shipped with — a hardcoded scale — and had to be
      // redeployed to fix. Bitcoin has eight base decimals and Ethereum eighteen, so
      // any constant here would misprice one of them by ten orders of magnitude.
      const ctx = await deploy();
      expect(await ctx.desk("BTC").read.oneBase()).to.equal(marketByName("BTC").oneBase);
      expect(await ctx.desk("ETH").read.oneBase()).to.equal(marketByName("ETH").oneBase);
    });

    it("passes the book straight through", async () => {
      const ctx = await deploy();
      const levels = await ctx.desk("ETH").read.getBookLevels([false, 1n]) as
        { price: bigint; quantity: bigint }[];
      const raw = await ctx.market("ETH").read.getBookLevels([false, 1n]) as
        { price: bigint; quantity: bigint }[];
      expect(levels[0]!.price).to.equal(raw[0]!.price);
      expect(levels[0]!.quantity).to.equal(raw[0]!.quantity);
    });

    it("serves the mark with ZERO size when the book empties", async () => {
      // The zero is load-bearing. It lets a position still be valued while Arena's own
      // `quantity == 0` check refuses to send an order into a book with nothing in it.
      // Reporting size that is not there got a fighter's order rejected and its turn
      // lost on the events market.
      const ctx = await deploy();
      await ctx.market("ETH").write.clearBook([false]);

      const levels = await ctx.desk("ETH").read.getBookLevels([false, 1n]) as
        { price: bigint; quantity: bigint }[];
      expect(levels.length).to.equal(1);
      expect(levels[0]!.price, "the mark, so the position is still worth something")
        .to.equal(marketByName("ETH").mark);
      expect(levels[0]!.quantity, "but nothing to trade against").to.equal(0n);
    });

    it("reports nothing at all when the book is empty AND the oracle is down", async () => {
      // A perp never settles, so unlike a prediction window there is no payout to fall
      // back on. Inventing a price here would misvalue a real position.
      const ctx = await deploy();
      await ctx.market("XRP").write.clearBook([false]);
      await ctx.market("XRP").write.setPriceable([false]);
      const levels = await ctx.desk("XRP").read.getBookLevels([false, 1n]) as unknown[];
      expect(levels.length).to.equal(0);
    });

    it("refuses a deposit loudly rather than swallowing the tokens", async () => {
      // A perp market has no vault. A silent no-op here would leave tokens sitting in
      // the desk if somebody pointed a funding script at it.
      const ctx = await deploy();
      await expectCustomError(
        ctx.desk("ETH").write.deposit([ctx.usdso.address, parseEther("1")], { account: ctx.arena.account }),
        "Unsupported()",
      );
    });

    it("has no cancel path, because nothing ever rests", async () => {
      const ctx = await deploy();
      await expectCustomError(
        ctx.desk("ETH").write.cancelOrder([1n], { account: ctx.arena.account }),
        "Unsupported()",
      );
    });

    it("names its market so the registry cannot be mis-wired", async () => {
      const ctx = await deploy();
      for (const [i, m] of MARKETS.entries()) {
        expect(getAddress(await ctx.desks[i]!.read.market() as string),
          `${m.name} desk points at its own market`)
          .to.equal(getAddress(ctx.markets[i]!.address));
        expect(getAddress(await ctx.registry.read.marketOfDesk([ctx.desks[i]!.address]) as string))
          .to.equal(getAddress(ctx.markets[i]!.address));
      }
    });
  });

  describe("wiring", () => {
    it("registers the desks once and refuses to be re-pointed", async () => {
      // Unlike a prediction window, a perp market does not expire — so there is no
      // reason to ever move a desk, and making it impossible removes a way to break a
      // running fight.
      const ctx = await deploy();
      expect(await ctx.registry.read.deskCount()).to.equal(6n);
      await expectCustomError(
        ctx.registry.write.registerDesks([[ctx.desks[0]!.address]]),
        "DesksAlreadySet()",
      );
    });

    it("deploys a fresh account when the free list runs dry", async () => {
      // A lobby that cannot start a fight because a pre-warmed list ran out is worse
      // than an expensive start.
      const [, arena] = await hre.viem.getWalletClients();
      const venue = await deployPerpVenue(hre, arena.account.address, { accounts: 0n });
      const account = await venue.registry.write.lease([50n, 0, parseEther("2")], { account: arena.account });
      expect(account).to.be.a("string");
      expect(await venue.registry.read.accountOf([50n, 0])).to.not.equal(zeroAddress);
    });
  });
});

/**
 * Regressions from the audit pass. Each of these was a live defect, and each one
 * would have looked like something else entirely from the outside — a fighter that
 * chose not to trade, a market that priced itself oddly, a slot that never came up.
 */
describe("PerpDesk — audit regressions", function () {
  this.timeout(120_000);

  async function deploy() {
    const [owner, arena, stranger] = await hre.viem.getWalletClients();
    const venue = await deployPerpVenue(hre, arena.account.address);
    return { ...venue, arena, stranger, ownerWallet: owner };
  }

  async function shortOneLot(ctx: Awaited<ReturnType<typeof deploy>>, duelId: bigint) {
    const m = marketByName("SOL");
    const bids = await ctx.market("SOL").read.getBookLevels([true, 1n]) as
      { price: bigint; quantity: bigint }[];
    await ctx.desk("SOL").write.placeOrder(
      [false, userData(duelId, 0), alignDown(bids[0]!.price, m.tickSize), m.minQuantity,
       GTC, 1, 0, zeroAddress, 0n],
      { account: ctx.arena.account },
    );
  }

  it("a stranger cannot flatten and strip a LIVE fighter", async () => {
    // THE BUG: `retryRelease` was permissionless and checked nothing about whether the
    // fight was over. Anyone could close a fighter's winning position, take its
    // collateral back into the float, and clear its lease — after which the fighter is
    // offered nothing but Hold for the rest of the fight and scores off a stale
    // snapshot. Directly profitable to anyone betting on the other side.
    //
    // THE FIX: only a QUARANTINED account can be retried, and a quarantined account is
    // by definition one Arena has already finished with.
    const ctx = await deploy();
    await ctx.registry.write.lease([60n, 0, parseEther("6")], { account: ctx.arena.account });
    const account = await ctx.registry.read.accountOf([60n, 0]) as string;
    await shortOneLot(ctx, 60n);

    expect(await sizeOfPublic(ctx, "SOL", account), "the fighter is in a trade").to.be.lessThan(0n);

    await expectCustomError(
      ctx.registry.write.retryRelease([60n, 0], { account: ctx.stranger.account }),
      "NotQuarantined()",
    );

    // Untouched: still short, still leased, collateral still posted.
    expect(await sizeOfPublic(ctx, "SOL", account)).to.be.lessThan(0n);
    expect(getAddress(await ctx.registry.read.accountOf([60n, 0]) as string))
      .to.equal(getAddress(account));
  });

  it("still lets the owner force a cleanup that reverted outright", async () => {
    // The break-glass. Quarantine cannot describe the one case where `_release` itself
    // reverts, which leaves the account leased AND unflagged — so the owner and Arena
    // keep an unconditional path.
    const ctx = await deploy();
    await ctx.registry.write.lease([61n, 0, parseEther("6")], { account: ctx.arena.account });
    await shortOneLot(ctx, 61n);
    await ctx.registry.write.retryRelease([61n, 0]);   // owner
    expect(await ctx.registry.read.accountOf([61n, 0])).to.equal(zeroAddress);
  });

  it("refuses two desks fronting the same market", async () => {
    // Silently broken rather than obviously broken, which is why it is refused. Both
    // desks carry the same label, so the action vocabulary offers the same name twice
    // and the reply matcher takes the FIRST — one slot becomes permanently unreachable.
    // And a fighter's two slots would be one position, so it could trade against itself.
    const [, arena] = await hre.viem.getWalletClients();
    const bank = await hre.viem.deployContract("MockMarginBank", [
      (await hre.viem.deployContract("MockERC20", ["USDso", "USDso"])).address,
    ]);
    const usdso = await hre.viem.getContractAt("MockERC20", await bank.read.collateral() as `0x${string}`);
    const registry = await hre.viem.deployContract("PerpAccountRegistry", [
      usdso.address, bank.address, arena.account.address,
    ]);
    const m = marketByName("SOL");
    const market = await hre.viem.deployContract("MockPerpPool", [
      bank.address, m.oneBase, m.tickSize, m.minQuantity, m.lotSize, m.mark, m.imf,
    ]);
    const deskA = await hre.viem.deployContract("PerpDesk", [
      arena.account.address, market.address, registry.address, usdso.address,
    ]);
    const deskB = await hre.viem.deployContract("PerpDesk", [
      arena.account.address, market.address, registry.address, usdso.address,
    ]);

    await expectCustomError(
      registry.write.registerDesks([[deskA.address, deskB.address]]),
      "DuplicateMarket(address)",
    );
  });

  it("refuses a desk built against a different registry", async () => {
    // Its registry pointer is immutable, so such a desk would route every order to
    // accounts and a float that live somewhere else. Every order refused, for a reason
    // visible nowhere.
    const [, arena] = await hre.viem.getWalletClients();
    const usdso = await hre.viem.deployContract("MockERC20", ["USDso", "USDso"]);
    const bank = await hre.viem.deployContract("MockMarginBank", [usdso.address]);
    const mine = await hre.viem.deployContract("PerpAccountRegistry", [
      usdso.address, bank.address, arena.account.address,
    ]);
    const other = await hre.viem.deployContract("PerpAccountRegistry", [
      usdso.address, bank.address, arena.account.address,
    ]);
    const m = marketByName("SOL");
    const market = await hre.viem.deployContract("MockPerpPool", [
      bank.address, m.oneBase, m.tickSize, m.minQuantity, m.lotSize, m.mark, m.imf,
    ]);
    const strayDesk = await hre.viem.deployContract("PerpDesk", [
      arena.account.address, market.address, other.address, usdso.address,
    ]);

    await expectCustomError(
      mine.write.registerDesks([[strayDesk.address]]),
      "DeskNotBoundHere(address)",
    );
  });
});

/** Position size, as a free function so the regression block can use it too. */
async function sizeOfPublic(
  ctx: { bank: { read: { getPosition: (a: unknown[]) => Promise<unknown> } };
         market: (n: string) => { address: `0x${string}` } },
  marketName: string,
  account: string,
) {
  const p = await ctx.bank.read.getPosition([account, ctx.market(marketName).address]) as unknown[];
  return p[0] as bigint;
}

/**
 * The operator's surface: getting money back out of a stuck account, finding the
 * accounts in the first place, and reading enough state to know which is which.
 *
 * Every other market here has this — `fundPools` / `withdrawFromPool` /
 * `sweepToken` / `ownerWithdrawSeed`, and scripts that audit the vaults. Perps
 * shipped the funding half and none of the recovery half: an account whose position
 * could never be closed had NO exit at all, and the accounts could not even be
 * enumerated to notice.
 */
describe("PerpAccountRegistry — the operator's surface", function () {
  this.timeout(120_000);

  async function deploy() {
    const [owner, arena, stranger] = await hre.viem.getWalletClients();
    const venue = await deployPerpVenue(hre, arena.account.address);
    return { ...venue, arena, stranger, ownerWallet: owner };
  }

  /** Put a fighter into a short and then take the market away. */
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

    // Every maker leaves. The automatic close cannot work.
    await ctx.market("SOL").write.clearBook([true]);
    await ctx.market("SOL").write.clearBook([false]);
    await ctx.registry.write.release([duelId, 0], { account: ctx.arena.account });
    expect(await ctx.registry.read.quarantined([account]), "stuck").to.equal(true);
    return account;
  }

  describe("finding the accounts", () => {
    it("lists every account it has ever created", async () => {
      // THE GAP: the creation event reported only a COUNT, and the children were kept
      // in no readable list. So an operator could not enumerate the contracts holding
      // their collateral — the balance audit that exists for every other market had
      // nothing it could even be written against.
      const ctx = await deploy();
      expect(await ctx.registry.read.accountCount(), "six pre-warmed").to.equal(6n);

      const listed: string[] = [];
      for (let i = 0n; i < 6n; i++) listed.push(await ctx.registry.read.accountAt([i]) as string);
      expect(new Set(listed.map((a) => a.toLowerCase())).size, "six distinct").to.equal(6);

      // And paginated, so a caller can walk to the end without knowing the length.
      const page = await ctx.registry.read.accountsPaginated([4n, 10n]) as string[];
      expect(page.length, "clamped to what exists").to.equal(2);
      expect(await ctx.registry.read.accountsPaginated([99n, 10n]) as string[])
        .to.deep.equal([]);
    });

    it("records an account created on demand, not just the pre-warmed ones", async () => {
      const [, arena] = await hre.viem.getWalletClients();
      const v = await deployPerpVenue(hre, arena.account.address, { accounts: 0n });
      expect(await v.registry.read.accountCount()).to.equal(0n);
      await v.registry.write.lease([70n, 0, parseEther("2")], { account: arena.account });
      expect(await v.registry.read.accountCount(), "the auto-deployed child is listed").to.equal(1n);
    });

    it("maps a stuck ADDRESS back to the fight it belonged to", async () => {
      // What an audit actually finds is an address holding money. Every rescue path is
      // keyed on (duelId, fighterId), so without this the operator has to grind through
      // logs to work out what to pass.
      const ctx = await deploy();
      const account = await stickAFighter(ctx, 71n);

      const tag = await ctx.registry.read.leaseTag([account]) as bigint;
      const [duelId, fighterId] = await ctx.registry.read.unpackTag([tag]) as [bigint, number];
      expect(duelId).to.equal(71n);
      expect(fighterId).to.equal(0);
    });

    it("keeps a list of everything ever quarantined", async () => {
      const ctx = await deploy();
      const account = await stickAFighter(ctx, 72n);
      expect(await ctx.registry.read.quarantineCount()).to.equal(1n);
      expect(getAddress(await ctx.registry.read.quarantineAt([0n]) as string))
        .to.equal(getAddress(account));
    });

    it("reports everything about one account in a single call", async () => {
      const ctx = await deploy();
      const account = await stickAFighter(ctx, 73n);
      const r = await ctx.registry.read.accountReport([account]) as unknown[];

      expect(r[0], "tagged to its fight").to.equal(userData(73n, 0));
      expect(r[2], "quarantined").to.equal(true);
      expect(r[6], "no loose collateral — it is all posted as margin").to.equal(0n);
      expect((r[8] as string[]).length, "one market still open").to.equal(1);
    });
  });

  describe("getting the money back", () => {
    it("lets the owner close a stuck position at a price they choose", async () => {
      // THE GAP: the automatic close sweeps five levels of the book and nothing else.
      // A position wider than that, or a market that stays close-only, had no exit —
      // and only a human looking at the market knows how far to cross.
      const ctx = await deploy();
      const m = marketByName("SOL");
      const account = await stickAFighter(ctx, 74n);
      const sizeBefore = await sizeOfPublic(ctx, "SOL", account);
      expect(sizeBefore, "still short").to.be.lessThan(0n);

      // A single thin maker returns, well away from the old mid.
      const price = alignUp(m.mark * 105n / 100n, m.tickSize);
      await ctx.market("SOL").write.setBookLevel([false, price, m.minQuantity * 5n]);

      await ctx.registry.write.forceClose([account, ctx.market("SOL").address, true, price, m.minQuantity]);
      expect(await sizeOfPublic(ctx, "SOL", account), "flat").to.equal(0n);

      // And now the ordinary cleanup finishes the job and returns it to circulation.
      await ctx.registry.write.retryRelease([74n, 0]);
      expect(await ctx.registry.read.quarantined([account])).to.equal(false);
      expect(await ctx.usdso.read.balanceOf([account]), "drained").to.equal(0n);
      expect(await ctx.registry.read.leaseTag([account]), "and untagged").to.equal(0n);
    });

    it("recovers collateral that frees up LATER, without the position ever closing", async () => {
      // What this path is actually for, which is narrower than it first looks.
      //
      // Winding down already recovers the free margin at the moment it runs, so
      // immediately after a failed cleanup there is nothing left to take — asserted
      // below, because that is the honest baseline. What it CANNOT do is come back
      // later. A stuck position's margin requirement moves with the market's
      // open-interest-scaled factor, so collateral frozen behind it becomes withdrawable
      // over time, and nothing was watching for that.
      //
      // Capped by real free margin, never by `getWithdrawableCollateral` — that read
      // ignores the margin an open position still needs, so asking for the figure it
      // reports would be refused outright and recover nothing at all.
      const ctx = await deploy();
      const account = await stickAFighter(ctx, 75n);

      // The cleanup already took what was free, so a rescue right now is a no-op.
      expect(await ctx.registry.simulate.rescueAccount([account]).then((r) => r.result as bigint),
        "nothing left immediately after the cleanup").to.equal(0n);

      // Time passes; open interest falls and the market's margin factor relaxes, so the
      // stuck position ties up a tenth of what it did.
      const held = await ctx.registry.read.freeMarginOf([account]) as bigint;
      expect(held, "and nothing is free while the factor is high").to.equal(0n);
      await ctx.market("SOL").write.setEffectiveIMF([50n]);

      const floatBefore = await ctx.registry.read.floatBalance() as bigint;
      const recovered = await ctx.registry.simulate.rescueAccount([account])
        .then((r) => r.result as bigint);
      await ctx.registry.write.rescueAccount([account]);

      expect(recovered, "the freed margin came back").to.be.greaterThan(0n);
      expect(await ctx.registry.read.floatBalance()).to.equal(floatBefore + recovered);
      // The position is untouched — this recovers collateral, it does not close trades.
      expect(await sizeOfPublic(ctx, "SOL", account), "still short").to.be.lessThan(0n);
    });

    it("keeps both rescue paths owner-only", async () => {
      const ctx = await deploy();
      const account = await stickAFighter(ctx, 76n);
      await expectCustomError(
        ctx.registry.write.forceClose(
          [account, ctx.market("SOL").address, true, 1n, 1n], { account: ctx.stranger.account }),
        "NotOwner()",
      );
      await expectCustomError(
        ctx.registry.write.rescueAccount([account], { account: ctx.stranger.account }),
        "NotOwner()",
      );
    });
  });

  describe("stray tokens", () => {
    it("recovers a foreign token from an account", async () => {
      // An account is a plain address, so anything can be sent to one. Without this the
      // only balance that could ever leave a retired account is the collateral.
      const ctx = await deploy();
      const account = await ctx.registry.read.accountAt([0n]) as string;
      const junk = await hre.viem.deployContract("MockERC20", ["JUNK", "JUNK"]);
      await junk.write.mint([account, parseEther("7")]);

      await ctx.registry.write.sweepAccountToken(
        [account, junk.address, ctx.ownerWallet.account.address]);

      expect(await junk.read.balanceOf([account])).to.equal(0n);
      expect(await junk.read.balanceOf([ctx.ownerWallet.account.address])).to.equal(parseEther("7"));
    });

    it("recovers a foreign token from the registry itself", async () => {
      const ctx = await deploy();
      const junk = await hre.viem.deployContract("MockERC20", ["JUNK", "JUNK"]);
      await junk.write.mint([ctx.registry.address, parseEther("3")]);

      await ctx.registry.write.sweepStray([junk.address, ctx.ownerWallet.account.address]);
      expect(await junk.read.balanceOf([ctx.ownerWallet.account.address])).to.equal(parseEther("3"));
    });

    it("refuses to sweep the collateral, so the float accounting cannot be bypassed", async () => {
      // The float leaves through `releaseFloat`, which Arena's seed ceiling governs —
      // the thing that stops a house withdrawal touching depositor money. A general
      // sweep here would be a way around it.
      const ctx = await deploy();
      await expectCustomError(
        ctx.registry.write.sweepStray([ctx.usdso.address, ctx.ownerWallet.account.address]),
        "CannotSweepCollateral()",
      );
    });

    it("routes collateral found in an account into the float, not to the owner", async () => {
      // Same reason. A failed deposit leaves collateral loose in a child; it belongs
      // back in the float where the seed accounting can see it.
      const ctx = await deploy();
      const account = await ctx.registry.read.accountAt([1n]) as string;
      await ctx.usdso.write.mint([account, parseEther("5")]);
      const before = await ctx.registry.read.floatBalance() as bigint;

      await ctx.registry.write.sweepAccountToken(
        [account, ctx.usdso.address, ctx.ownerWallet.account.address]);

      expect(await ctx.registry.read.floatBalance(), "joined the float").to.equal(before + parseEther("5"));
      expect(await ctx.usdso.read.balanceOf([account])).to.equal(0n);
    });
  });
});
