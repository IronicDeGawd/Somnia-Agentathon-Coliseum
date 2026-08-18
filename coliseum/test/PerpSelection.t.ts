import { expect } from "chai";
import hre from "hardhat";
import { parseEther } from "viem";

import {
  deployPerpVenue, MARKETS, imPerLot, marketByName, setBook, expectCustomError,
} from "./helpers/perps";

/**
 * Which three markets a fight is offered.
 *
 * This is the part of the design that replaced a hard-coded asset list, and it
 * replaced it for a measured reason: Bitcoin's effective margin factor was 3.7x its
 * configured one, which made Bitcoin 90% of a fight's margin and would have shipped
 * as a mispriced tier nobody noticed. Under a computed list that is not a bug at
 * all — Bitcoin simply falls out of the cheap tiers on its own and walks back in
 * when the factor relaxes.
 *
 * So these tests are about the ways the computation can go quietly wrong: offering a
 * market a budget cannot afford, offering one that cannot be traded, or offering the
 * same three every single time.
 */
describe("Perps — market selection", function () {
  this.timeout(120_000);

  async function deploy() {
    const [, arena] = await hre.viem.getWalletClients();
    const venue = await deployPerpVenue(hre, arena.account.address);
    return { ...venue, arena };
  }

  /** Read the picked desks back as market names, which is what the ladder is about. */
  async function pickNames(venue: Awaited<ReturnType<typeof deploy>>, budget: bigint, salt: bigint) {
    const picked = await venue.registry.read.selectMarkets([budget, salt]) as string[];
    return picked.map((addr) => {
      const i = venue.desks.findIndex((d) => d.address.toLowerCase() === addr.toLowerCase());
      return MARKETS[i]!.name;
    });
  }

  describe("the measured cost of one position", () => {
    it("reports each market's margin per lot, and Bitcoin as the outlier", async () => {
      // The numbers the whole ladder is derived from. If this drifts, every tier
      // boundary below is meaningless — which is why it is asserted first.
      const { registry, market } = await deploy();
      for (const m of MARKETS) {
        const [tradable, im] = await registry.read.marketCost([market(m.name).address]) as [boolean, bigint];
        expect(tradable, `${m.name} is tradable`).to.equal(true);
        expect(im, `${m.name} margin per lot`).to.equal(imPerLot(m));
      }

      // Stated explicitly because it is the finding that reshaped the design: one
      // Bitcoin position costs more than twelve dollars, not the three-and-change a
      // configured 500 bps would suggest.
      const [, btc] = await registry.read.marketCost([market("BTC").address]) as [boolean, bigint];
      expect(btc).to.be.greaterThan(parseEther("11.9"));
      expect(btc).to.be.lessThan(parseEther("12.1"));
    });

    it("rides on the effective margin factor, not a cached one", async () => {
      // The factor scales with open interest and moves on its own. A market that
      // fitted a budget an hour ago may not fit it now, and the selection has to see
      // that — otherwise a fighter is handed a market it cannot post margin for.
      const { registry, market } = await deploy();
      const eth = market("ETH");
      const [, before] = await registry.read.marketCost([eth.address]) as [boolean, bigint];

      await eth.write.setEffectiveIMF([2000n]);
      const [, after] = await registry.read.marketCost([eth.address]) as [boolean, bigint];

      expect(after, "quadrupling the factor quadruples the margin").to.equal(before * 4n);
    });
  });

  describe("the budget ladder", () => {
    it("a two-dollar budget excludes Bitcoin and includes Ethereum", async () => {
      // The cheap tier. Ethereum is deliberately a tight fit — two positions on a
      // two-dollar budget — so that choosing it costs the fighter something.
      const venue = await deploy();
      const names = await pickNames(venue, parseEther("2"), 0n);
      expect(names, "Bitcoin costs $12 a lot").to.not.include("BTC");

      const [tradable] = await venue.registry.read.marketCost([venue.market("ETH").address]) as [boolean, bigint];
      expect(tradable).to.equal(true);
      expect(imPerLot(marketByName("ETH"))).to.be.lessThan(parseEther("2"));
    });

    it("an eighteen-dollar budget lets Bitcoin in", async () => {
      // The top tier, and the only one where Bitcoin fits — at exactly one position.
      const venue = await deploy();
      const seen = new Set<string>();
      // Rotation means BTC is not in every pick, so sweep the salts a tier could see.
      for (let salt = 0n; salt < 6n; salt++) {
        for (const n of await pickNames(venue, parseEther("18"), salt)) seen.add(n);
      }
      expect([...seen], "every market qualifies at eighteen dollars").to.include("BTC");
      expect(imPerLot(marketByName("BTC"))).to.be.lessThan(parseEther("18"));
    });

    it("offers only markets the budget can actually post margin for", async () => {
      // The invariant the ladder exists to hold. Anything offered must be affordable,
      // at every rung — a fighter handed an unaffordable market loses its turn to a
      // refused order, and looks like it chose to do nothing.
      const venue = await deploy();
      for (const budget of [parseEther("2"), parseEther("6"), parseEther("12"), parseEther("18")]) {
        for (let salt = 0n; salt < 7n; salt++) {
          for (const name of await pickNames(venue, budget, salt)) {
            expect(imPerLot(marketByName(name)), `${name} at budget ${budget}`)
              .to.be.lessThanOrEqual(budget);
          }
        }
      }
    });
  });

  describe("markets that cannot be traded are skipped, never fatal", () => {
    it("skips an unpriceable market and still returns three", async () => {
      // A stale oracle takes one market away. With six registered there is room to
      // lose one, and losing one must not take the fight down with it.
      const venue = await deploy();
      await venue.market("SOL").write.setPriceable([false]);

      const names = await pickNames(venue, parseEther("18"), 0n);
      expect(names.length).to.equal(3);
      expect(names).to.not.include("SOL");
    });

    it("skips a close-only market", async () => {
      // `isRestricted` means every order except a reducing one reverts. Offering it
      // would let a flat fighter pick a move that cannot succeed.
      const venue = await deploy();
      await venue.market("ADA").write.setRestricted([true]);

      const names = await pickNames(venue, parseEther("18"), 0n);
      expect(names).to.not.include("ADA");
    });

    it("skips a one-sided book", async () => {
      // One direction available is worse than none: the fighter is offered both and
      // one of them can only fail.
      const venue = await deploy();
      await venue.market("XRP").write.clearBook([false]);

      const names = await pickNames(venue, parseEther("18"), 0n);
      expect(names).to.not.include("XRP");
    });

    it("refuses to start a fight when fewer than three qualify", async () => {
      // The honest failure. Three dead slots is not a fight, and taking a player's
      // deposit for one is worse than telling them the market is not available.
      const venue = await deploy();
      for (const name of ["XRP", "ADA", "SOL", "BNB"]) {
        await venue.market(name).write.setPriceable([false]);
      }
      // ETH and BTC left — two.
      await expectCustomError(
        venue.registry.read.selectMarkets([parseEther("18"), 0n]),
        "NotEnoughMarkets(uint256)",
      );
    });

    it("survives a market whose reads revert outright", async () => {
      // Not a stale price — a market that is not a market. A desk pointed at a
      // contract that answers nothing must cost one option, not the whole selection.
      const venue = await deploy();
      const rubbish = await hre.viem.deployContract("MockERC20", ["nope", "nope"]);
      const [tradable, im] = await venue.registry.read.marketCost([rubbish.address]) as [boolean, bigint];
      expect(tradable).to.equal(false);
      expect(im).to.equal(0n);
    });
  });

  describe("rotation", () => {
    it("two consecutive fights at one tier are not the same fight", async () => {
      // Six markets qualify at the top tier and only three are used, so without
      // rotation the other three would never be played and every fight at that tier
      // would look identical.
      const venue = await deploy();
      const a = await pickNames(venue, parseEther("18"), 1n);
      const b = await pickNames(venue, parseEther("18"), 2n);
      expect(a.join(","), "the salt changed the pick").to.not.equal(b.join(","));
    });

    it("never offers the same market twice in one fight", async () => {
      // Three slots holding two markets would give a fighter two names for one
      // position, and its own two slots could then fight each other.
      const venue = await deploy();
      for (const budget of [parseEther("2"), parseEther("18")]) {
        for (let salt = 0n; salt < 8n; salt++) {
          const names = await pickNames(venue, budget, salt);
          expect(new Set(names).size, `budget ${budget} salt ${salt}: ${names}`).to.equal(3);
        }
      }
    });

    it("gives every qualifying market a turn as the salt advances", async () => {
      const venue = await deploy();
      const seen = new Set<string>();
      for (let salt = 0n; salt < 6n; salt++) {
        for (const n of await pickNames(venue, parseEther("18"), salt)) seen.add(n);
      }
      expect(seen.size, "all six get played").to.equal(6);
    });
  });

  describe("a market that recovers comes back", () => {
    it("re-admits a market once its factor relaxes", async () => {
      // The behaviour that turns the original bug into a non-event. Bitcoin at a
      // relaxed factor is affordable at the cheap tier, and nothing has to be
      // redeployed or reconfigured for it to be offered again.
      const venue = await deploy();
      const before = await pickNames(venue, parseEther("2"), 0n);
      expect(before).to.not.include("BTC");

      // Open interest falls; the factor drops back toward its configured 500.
      await venue.market("BTC").write.setEffectiveIMF([20n]);
      await setBook(venue.market("BTC"), marketByName("BTC"));

      const seen = new Set<string>();
      for (let salt = 0n; salt < 7n; salt++) {
        for (const n of await pickNames(venue, parseEther("2"), salt)) seen.add(n);
      }
      expect([...seen]).to.include("BTC");
    });
  });
});
