import { expect } from "chai";
import hre from "hardhat";
import { parseEther, maxUint256, zeroAddress, getAddress } from "viem";

import { deployArenaWithParts } from "./helpers/arena";
import {
  deployPerpVenue, MARKETS, marketByName, imPerLot, label, expectCustomError,
} from "./helpers/perps";

const HANDLE_SELECTOR = "0xc4e34fdd" as `0x${string}`;
/** Market kinds, as `ArenaTypes.MarketKind` numbers them. Never reordered. */
const SPOT = 0, PERPS = 3;

const mineBlock = () => hre.network.provider.send("evm_mine", []);

/**
 * Perps as Arena sees it: a fourth market with a fixed entry price, a self-adjusting
 * asset list, and fighters that can bet a market DOWN.
 *
 * Three things here are different in kind from the other markets, and each has its
 * own way of going wrong silently:
 *
 *   THE SCORE IS EQUITY, not cash plus holdings, and it is a live oracle read. So a
 *   stale feed at the moment of finalize could turn a decided fight into a draw.
 *
 *   THE VOCABULARY IS DIRECTIONS. The list offered to the model and the matcher that
 *   reads its reply are built independently. If they disagree, every trade becomes a
 *   Hold — which looks exactly like a fighter choosing not to trade.
 *
 *   THE PLAYERS' POT IS NOT THE TRADING CAPITAL. Fighters risk Arena's own seed, so a
 *   liquidation must cost the house and the pot must come back whole.
 */
describe("Arena — perpetual futures market", function () {
  this.timeout(180_000);

  async function deploy(opts: { float?: bigint } = {}) {
    const [owner] = await hre.viem.getWalletClients();
    const registry = await hre.viem.deployContract("FighterRegistry");
    const usdso    = await hre.viem.deployContract("MockERC20", ["USDso", "USDso"]);
    const poolWeth = await hre.viem.deployContract("MockSpotPool");
    const poolWbtc = await hre.viem.deployContract("MockSpotPool");
    const poolSomi = await hre.viem.deployContract("MockSpotPool");
    const mockPlatform = await hre.viem.deployContract("MockPlatform");

    const { arena } = await deployArenaWithParts(hre, [
      registry.address, usdso.address,
      poolWeth.address, poolWbtc.address, poolSomi.address,
      mockPlatform.address, 1n, [18, 18, 18],
    ], { value: parseEther("33") });

    await usdso.write.mint([owner.account.address, parseEther("1000000")]);
    await usdso.write.approve([arena.address, maxUint256]);

    // The perps venue, with the real router as the only address allowed to lease,
    // trade and release. Float left at zero so it is funded through Arena's own
    // seed-tracked path below.
    const venue = await deployPerpVenue(hre, arena.address, {
      usdso: usdso.address, float: 0n,
    });

    await hre.network.provider.send("hardhat_setBalance", [
      arena.address, "0x" + parseEther("500").toString(16),
    ]);

    // `venue` already carries `usdso` and `owner` — the same token and the same
    // wallet, since both were passed in — so they are not repeated here.
    return { arena, poolWeth, poolWbtc, poolSomi, mockPlatform, ...venue };
  }

  /** Register every desk with Arena and lend the registry a working float. */
  async function wirePerps(ctx: Awaited<ReturnType<typeof deploy>>, float = parseEther("400")) {
    await ctx.arena.write.setPerpDesks([
      ctx.registry.address,
      ctx.desks.map((d) => d.address),
      MARKETS.map((m) => m.baseDecimals),
      MARKETS.map((m) => label(m.name)),
    ]);
    await ctx.arena.write.fundPerpFloat([float]);
  }

  /** Which market a duel's slot is bound to, by name. */
  function nameOfDesk(ctx: Awaited<ReturnType<typeof deploy>>, addr: string) {
    const i = ctx.desks.findIndex((d) => d.address.toLowerCase() === addr.toLowerCase());
    return i < 0 ? null : MARKETS[i]!.name;
  }

  async function requestIdsFrom(hash: `0x${string}`) {
    const publicClient = await hre.viem.getPublicClient();
    const receipt = await publicClient.getTransactionReceipt({ hash });
    return receipt.logs.filter((l) => l.topics.length === 4).map((l) => BigInt(l.topics[3]!));
  }

  /** Advance one turn, answering for both fighters with the named action (or Hold). */
  async function runTurn(
    ctx: Awaited<ReturnType<typeof deploy>>,
    duelId: bigint,
    answerA = "Hold",
    answerB = "Hold",
  ) {
    const tx = await ctx.arena.write.turn([duelId]);
    const [a, b] = await requestIdsFrom(tx);
    await mineBlock();
    await ctx.mockPlatform.write.dispatchSuccessString([ctx.arena.address, a!, HANDLE_SELECTOR, answerA]);
    await ctx.mockPlatform.write.dispatchSuccessString([ctx.arena.address, b!, HANDLE_SELECTOR, answerB]);
  }

  // ─────────────────────────────────────────────────────────────────────────────

  describe("wiring", () => {
    it("registers the desks and their trading rules", async () => {
      const ctx = await deploy();
      let [ready, reg] = await ctx.arena.read.perpStatus() as [boolean, string];
      expect(ready, "not usable before wiring").to.equal(false);
      expect(reg).to.equal(zeroAddress);

      await wirePerps(ctx);

      [ready, reg] = await ctx.arena.read.perpStatus() as [boolean, string];
      expect(ready).to.equal(true);
      expect(getAddress(reg)).to.equal(getAddress(ctx.registry.address));

      // The rules were read off the desk, not assumed. Bitcoin's are the distinctive
      // ones: eight base decimals where Ethereum has eighteen.
      const btc = marketByName("BTC");
      const meta = await ctx.arena.read.poolMeta([ctx.desk("BTC").address]) as unknown[];
      expect(meta[0], "base decimals").to.equal(8);
      expect(meta[1], "minimum size").to.equal(btc.minQuantity);
      expect(meta[3], "tick").to.equal(btc.tickSize);

      for (const d of ctx.desks) {
        expect(await ctx.arena.read.isPerpPool([d.address])).to.equal(true);
      }
      expect(await ctx.arena.read.isPerpPool([ctx.poolWeth.address])).to.equal(false);
    });

    it("refuses a perps fight before the desks are wired", async () => {
      // Better than starting one on three zero addresses that can never be traded.
      const ctx = await deploy();
      await expectCustomError(
        ctx.arena.write.startDuelOn([0, 1, 3, PERPS]),
        "PerpRegistryUnset()",
      );
    });

    it("still rejects a market kind that does not exist", async () => {
      const ctx = await deploy();
      await wirePerps(ctx);
      await expectCustomError(
        ctx.arena.write.startDuelOn([0, 1, 3, 4]),
        "InvalidMarketKind()",
      );
    });

    it("tracks the lent float as owner seed, not depositor money", async () => {
      // The float is the house's stake. It has to come back out through the same
      // ceiling-checked path as every other owner seed, so it can never be confused
      // with a player's escrowed pot.
      const ctx = await deploy();
      const before = await ctx.arena.read.seedLiquidity() as bigint;
      await wirePerps(ctx, parseEther("300"));

      expect(await ctx.arena.read.seedLiquidity()).to.equal(before + parseEther("300"));
      expect(await ctx.registry.read.floatBalance()).to.equal(parseEther("300"));

      // And it can be pulled back.
      await ctx.arena.write.withdrawPerpFloat([parseEther("100")]);
      expect(await ctx.registry.read.floatBalance()).to.equal(parseEther("200"));
      await ctx.arena.write.ownerWithdrawSeed([ctx.owner.account.address, parseEther("100")]);
    });

    it("refuses to swap the registry while a fight is running", async () => {
      // A desk is bound to its registry for good, but Arena's pointer is not — and a
      // running perps fight reads it twice more, to score each fighter and to close
      // their positions. Swapping it mid-fight would send both reads to a registry
      // that has never heard of that duel: the fighters would score off stale
      // snapshots and their collateral would sit in the old registry with nothing
      // pointing at it.
      const ctx = await deploy();
      await wirePerps(ctx);
      await ctx.arena.write.startDuelOn([0, 1, 3, PERPS]);

      const other = await hre.viem.deployContract("PerpAccountRegistry", [
        ctx.usdso.address, ctx.bank.address, ctx.arena.address,
      ]);
      await expectCustomError(
        ctx.arena.write.setPerpDesks([
          other.address,
          ctx.desks.map((d) => d.address),
          MARKETS.map((m) => m.baseDecimals),
          MARKETS.map((m) => label(m.name)),
        ]),
        "ArenaNotEmpty()",
      );

      // Re-registering the SAME registry is always allowed — that is how a desk's
      // cached trading rules get refreshed, and it disturbs nothing.
      await ctx.arena.write.setPerpDesks([
        ctx.registry.address,
        ctx.desks.map((d) => d.address),
        MARKETS.map((m) => m.baseDecimals),
        MARKETS.map((m) => label(m.name)),
      ]);
    });

    it("has no money path through a desk — the float moves through Arena only", async () => {
      // A perp market has no vault. Routing the float through a desk as well would
      // mean a second address authorised to move it, for no gain.
      const ctx = await deploy();
      await wirePerps(ctx);
      await expectCustomError(
        ctx.arena.write.withdrawFromPool([ctx.desk("ETH").address, ctx.usdso.address, parseEther("1")]),
        "Unsupported()",
      );
    });
  });

  describe("the fixed entry price", () => {
    it("quotes the ladder and reads no book doing it", async () => {
      // The whole point of the perps tier: the price is advertised, not derived. A
      // nine-round spot fight costs $95.64 and the figure moves between the moment a
      // lobby quotes it and the moment a player pays. This one cannot move.
      const ctx = await deploy();
      await wirePerps(ctx);

      const ladder: [number, string][] = [[3, "2"], [6, "6"], [9, "12"], [15, "18"]];
      for (const [turns, budget] of ladder) {
        expect(await ctx.arena.read.perpBudgetFor([turns]), `${turns} rounds`)
          .to.equal(parseEther(budget));
        expect(await ctx.arena.read.minDepositForKind([turns, PERPS]), `${turns} rounds, both fighters`)
          .to.equal(parseEther(budget) * 2n);
      }

      // Now take every market away. A price that depends on a book would collapse;
      // this one is unchanged, which is what makes the tier honest.
      for (const m of ctx.markets) await m.write.setPriceable([false]);
      expect(await ctx.arena.read.minDepositForKind([9, PERPS])).to.equal(parseEther("24"));
    });

    it("shows a lobby what a tier currently offers", async () => {
      const ctx = await deploy();
      await wirePerps(ctx);

      const cheap = (await ctx.arena.read.perpMarketsFor([3]) as string[]).map((a) => nameOfDesk(ctx, a));
      expect(cheap.length).to.equal(3);
      expect(cheap, "Bitcoin costs $12 a lot").to.not.include("BTC");

      const rich = new Set<string | null>();
      for (let i = 0; i < 6; i++) {
        await mineBlock();
        for (const a of await ctx.arena.read.perpMarketsFor([15]) as string[]) rich.add(nameOfDesk(ctx, a));
      }
      // The salt is the next duel id, which does not move between reads, so sweeping
      // is done in the registry-level tests. Here it is enough that the top tier can
      // name markets the cheap tier cannot afford.
      expect(rich.size).to.be.greaterThan(0);
    });
  });

  describe("starting a fight", () => {
    it("gives each fighter its own funded address", async () => {
      const ctx = await deploy();
      await wirePerps(ctx);

      const floatBefore = await ctx.registry.read.floatBalance() as bigint;
      await ctx.arena.write.startDuelOn([0, 1, 6, PERPS]);
      const duelId = await ctx.arena.read.activeDuelId() as bigint;

      const [, , , accA] = await ctx.arena.read.perpPositionOf([duelId, 0]) as
        [boolean, bigint, bigint, string, number];
      const [, , , accB] = await ctx.arena.read.perpPositionOf([duelId, 1]) as
        [boolean, bigint, bigint, string, number];

      expect(accA).to.not.equal(zeroAddress);
      expect(getAddress(accA), "separate addresses, so cross margin cannot cross fighters")
        .to.not.equal(getAddress(accB));

      // Six USDso each, lent out of the float.
      expect(await ctx.registry.read.floatBalance())
        .to.equal(floatBefore - parseEther("12"));
    });

    it("binds the fight to three affordable markets and records them", async () => {
      const ctx = await deploy();
      await wirePerps(ctx);
      await ctx.arena.write.startDuelOn([0, 1, 3, PERPS]);
      const duelId = await ctx.arena.read.activeDuelId() as bigint;

      const bound = (await ctx.arena.read.duelPoolsOf([duelId]) as string[]).map((a) => nameOfDesk(ctx, a));
      expect(new Set(bound).size, "three distinct markets").to.equal(3);
      for (const name of bound) {
        expect(imPerLot(marketByName(name!)), `${name} fits a two-dollar budget`)
          .to.be.lessThanOrEqual(parseEther("2"));
      }
    });

    it("keeps the markets it started on even as the venue changes", async () => {
      // Same guarantee spot and events already have. A fight's slots are frozen at the
      // start, so a market going close-only mid-fight cannot re-point a live duel.
      const ctx = await deploy();
      await wirePerps(ctx);
      await ctx.arena.write.startDuelOn([0, 1, 3, PERPS]);
      const duelId = await ctx.arena.read.activeDuelId() as bigint;
      const before = await ctx.arena.read.duelPoolsOf([duelId]) as string[];

      for (const m of ctx.markets) await m.write.setRestricted([true]);
      const after = await ctx.arena.read.duelPoolsOf([duelId]) as string[];
      expect(after.join(",")).to.equal(before.join(","));
    });

    it("refuses to start a fight the float cannot fund", async () => {
      const ctx = await deploy();
      await wirePerps(ctx, parseEther("10"));   // less than 2 x 18
      await expectCustomError(
        ctx.arena.write.startDuelOn([0, 1, 15, PERPS]),
        "FloatTooSmall(uint256,uint256)",
      );
    });
  });

  describe("the action vocabulary", () => {
    it("offers directions on a perps slot", async () => {
      // The list offered to the model and the matcher that reads its reply are built
      // from the same vocabulary. If they ever disagree every trade becomes a silent
      // Hold, which is indistinguishable from a fighter choosing not to trade — so the
      // names are asserted rather than assumed.
      const ctx = await deploy();
      await wirePerps(ctx);
      await ctx.arena.write.startDuelOn([0, 1, 3, PERPS]);
      const duelId = await ctx.arena.read.activeDuelId() as bigint;
      await mineBlock();

      const [prompt, allowed] = await ctx.arena.read.previewTurnPrompt([duelId, 0]) as [string, string[]];

      expect(allowed, "Hold is always available").to.include("Hold");
      expect(allowed.some((a) => a.startsWith("Long")), `got: ${allowed}`).to.equal(true);
      expect(allowed.some((a) => a.startsWith("Short")), "a flat fighter may still sell").to.equal(true);
      expect(allowed.some((a) => a.startsWith("Buy") || a.startsWith("Sell")),
        "no spot words on a perps slot").to.equal(false);
      expect(allowed.some((a) => a.startsWith("Back") || a.startsWith("Drop")),
        "no prediction words either").to.equal(false);

      // A perps position is a direction, not a holding, so the prompt says so.
      expect(prompt).to.match(/not in this market/);
      // And still no digits anywhere in the decision path: an echoed number was once
      // extracted as a move index and executed as the wrong trade.
      expect(prompt, `prompt must carry no numerals, got: ${prompt}`).to.not.match(/\d/);
    });

    it("leaves the other markets' vocabulary untouched", async () => {
      const ctx = await deploy();
      await wirePerps(ctx);

      // A spot fight: still Buy and Sell.
      const ONE = 10n ** 18n;
      for (const p of [ctx.poolWeth, ctx.poolWbtc, ctx.poolSomi]) {
        await p.write.setPoolParams([ctx.usdso.address, ctx.usdso.address, 1n, ONE / 100n, 1n]);
        await p.write.setBookLevel([true, ONE, ONE * 100n]);
        await p.write.setBookLevel([false, ONE, ONE * 100n]);
        await p.write.creditVault([ctx.arena.address, ctx.usdso.address, parseEther("1000")]);
      }
      // The rules were cached when Arena was constructed, before those pool params
      // existed — a pool cached with a zero minimum size is UNTRADABLE, not
      // unrestricted, so without this refresh the only allowed action is Hold.
      await ctx.arena.write.refreshPoolMeta([
        [ctx.poolWeth.address, ctx.poolWbtc.address, ctx.poolSomi.address], [18, 18, 18],
      ]);
      await ctx.arena.write.startDuelOn([0, 1, 3, SPOT]);
      const spotId = await ctx.arena.read.activeDuelId() as bigint;
      await mineBlock();
      const [, spotAllowed] = await ctx.arena.read.previewTurnPrompt([spotId, 0]) as [string, string[]];
      expect(spotAllowed.some((a) => a.startsWith("Buy")), `got: ${spotAllowed}`).to.equal(true);
      expect(spotAllowed.some((a) => a.startsWith("Long")), "no perps words on a spot slot").to.equal(false);

      // And an events fight: still Back and Drop.
      await ctx.arena.write.setEventDesks([
        [ctx.poolWeth.address, ctx.poolWbtc.address, ctx.poolSomi.address],
        [18, 18, 18],
        [label("ETHUP"), label("BTCUP"), label("SOMIUP")],
      ]);
      await ctx.arena.write.startEventDuel([2, 3, 3]);
      const eventIds = await ctx.arena.read.getActiveDuelIds() as bigint[];
      const eventId = eventIds[eventIds.length - 1]!;
      await mineBlock();
      const [, evAllowed] = await ctx.arena.read.previewTurnPrompt([eventId, 2]) as [string, string[]];
      expect(evAllowed.some((a) => a.startsWith("Back")), `got: ${evAllowed}`).to.equal(true);
      expect(evAllowed.some((a) => a.startsWith("Long")), "no perps words on an events slot").to.equal(false);
    });
  });

  describe("trading", () => {
    it("a fighter's Short answer opens a NEGATIVE position", async () => {
      // The move that no other Coliseum market can make.
      const ctx = await deploy();
      await wirePerps(ctx);
      await ctx.arena.write.startDuelOn([0, 1, 6, PERPS]);
      const duelId = await ctx.arena.read.activeDuelId() as bigint;
      await mineBlock();

      const [, allowed] = await ctx.arena.read.previewTurnPrompt([duelId, 0]) as [string, string[]];
      const short = allowed.find((a) => a.startsWith("Short"))!;
      const marketName = short.slice("Short".length);

      await runTurn(ctx, duelId, short, "Hold");

      const desk = ctx.desk(marketName);
      expect(await desk.read.fighterSide([duelId, 0]), `${short} opened a short`).to.equal(-1);
      expect(await desk.read.fighterSide([duelId, 1]), "the other fighter held").to.equal(0);
    });

    it("a Long answer opens a positive one", async () => {
      const ctx = await deploy();
      await wirePerps(ctx);
      await ctx.arena.write.startDuelOn([0, 1, 6, PERPS]);
      const duelId = await ctx.arena.read.activeDuelId() as bigint;
      await mineBlock();

      const [, allowed] = await ctx.arena.read.previewTurnPrompt([duelId, 0]) as [string, string[]];
      const long = allowed.find((a) => a.startsWith("Long"))!;
      await runTurn(ctx, duelId, long, "Hold");
      expect(await ctx.desk(long.slice("Long".length)).read.fighterSide([duelId, 0])).to.equal(1);
    });

    it("leaves the virtual ledger alone, so the pot still comes back whole", async () => {
      // A perps position is held by the protocol against the fighter's own address.
      // Mirroring it into Arena's virtual ledger would be a second set of books that
      // can only disagree with the first — and the quote side of that ledger is what
      // `recoverFunds` pays the creator from, so writing to it would quietly change
      // what the players get back.
      const ctx = await deploy();
      await wirePerps(ctx);
      await ctx.arena.write.startDuelOn([0, 1, 6, PERPS]);
      const duelId = await ctx.arena.read.activeDuelId() as bigint;
      const pools = await ctx.arena.read.duelPoolsOf([duelId]) as string[];
      await mineBlock();

      const before = await ctx.arena.read.fighterBalances([pools[0]!, duelId, 0]) as unknown[];
      const [, allowed] = await ctx.arena.read.previewTurnPrompt([duelId, 0]) as [string, string[]];
      await runTurn(ctx, duelId, allowed.find((a) => a.startsWith("Short"))!, "Hold");

      const after = await ctx.arena.read.fighterBalances([pools[0]!, duelId, 0]) as unknown[];
      expect(after[0], "no virtual base holding invented").to.equal(before[0]);
      expect(after[1], "and no virtual quote spent").to.equal(before[1]);
    });

    it("refuses a move on a market that went close-only, and the turn continues", async () => {
      const ctx = await deploy();
      await wirePerps(ctx);
      await ctx.arena.write.startDuelOn([0, 1, 6, PERPS]);
      const duelId = await ctx.arena.read.activeDuelId() as bigint;
      await mineBlock();

      const [, allowed] = await ctx.arena.read.previewTurnPrompt([duelId, 0]) as [string, string[]];
      const short = allowed.find((a) => a.startsWith("Short"))!;
      const name = short.slice("Short".length);
      await ctx.market(name).write.setRestricted([true]);

      await runTurn(ctx, duelId, short, "Hold");

      // The turn still completed — both callbacks counted — and no position opened.
      const duel = await ctx.arena.read.duels([duelId]) as unknown[];
      expect(duel[5], "both moves accounted for").to.equal(2);
      expect(await ctx.desk(name).read.fighterSide([duelId, 0])).to.equal(0);
    });
  });

  describe("scoring and resolution", () => {
    /** Run a whole three-round fight, then finalize. */
    async function fightAndFinalize(
      ctx: Awaited<ReturnType<typeof deploy>>,
      duelId: bigint,
      answerA: (turn: number, allowed: string[]) => string,
      answerB: (turn: number, allowed: string[]) => string,
      between?: (turn: number) => Promise<void>,
    ) {
      for (let t = 0; t < 3; t++) {
        const [, allowedA] = await ctx.arena.read.previewTurnPrompt([duelId, 0]) as [string, string[]];
        const [, allowedB] = await ctx.arena.read.previewTurnPrompt([duelId, 1]) as [string, string[]];
        await runTurn(ctx, duelId, answerA(t, allowedA), answerB(t, allowedB));
        if (between) await between(t);
      }
      return ctx.arena.write.finalizeDuel([duelId]);
    }

    it("a short into a falling market beats a fighter that held", async () => {
      // Scoring on equity is what makes shorting work at all: once the score is
      // equity rather than cash-plus-holdings, a negative position is handled by the
      // protocol's own arithmetic.
      const ctx = await deploy();
      await wirePerps(ctx);
      // Three rounds, because `fightAndFinalize` plays three and a duel cannot be
      // finalized until every callback is in.
      await ctx.arena.write.startDuelOn([0, 1, 3, PERPS]);
      const duelId = await ctx.arena.read.activeDuelId() as bigint;
      await mineBlock();

      const [, allowed] = await ctx.arena.read.previewTurnPrompt([duelId, 0]) as [string, string[]];
      const short = allowed.find((a) => a.startsWith("Short"))!;
      const name = short.slice("Short".length);
      const spec = marketByName(name);

      const publicClient = await hre.viem.getPublicClient();
      const hash = await fightAndFinalize(
        ctx, duelId,
        (t) => (t === 0 ? short : "Hold"),
        () => "Hold",
        // The market falls twenty percent after the short is on.
        async (t) => {
          if (t === 0) await ctx.market(name).write.setMark([spec.mark * 80n / 100n]);
        },
      );
      const receipt = await publicClient.getTransactionReceipt({ hash });
      expect(receipt.status).to.equal("success");

      const duel = await ctx.arena.read.duels([duelId]) as unknown[];
      expect(duel[8], "resolved").to.equal(3);
      expect(duel[11], "the short won").to.equal(0);
    });

    it("a long into a falling market loses to a fighter that held", async () => {
      const ctx = await deploy();
      await wirePerps(ctx);
      await ctx.arena.write.startDuelOn([0, 1, 3, PERPS]);
      const duelId = await ctx.arena.read.activeDuelId() as bigint;
      await mineBlock();

      const [, allowed] = await ctx.arena.read.previewTurnPrompt([duelId, 0]) as [string, string[]];
      const long = allowed.find((a) => a.startsWith("Long"))!;
      const name = long.slice("Long".length);
      const spec = marketByName(name);

      await fightAndFinalize(
        ctx, duelId,
        (t) => (t === 0 ? long : "Hold"),
        () => "Hold",
        async (t) => {
          if (t === 0) await ctx.market(name).write.setMark([spec.mark * 80n / 100n]);
        },
      );

      const duel = await ctx.arena.read.duels([duelId]) as unknown[];
      expect(duel[11], "the fighter that held won").to.equal(1);
    });

    it("falls back to the last recorded score when the oracle is stale at finalize", async () => {
      // Nobody chooses the moment of finalize, so an oracle that happens to be stale
      // at that block must not decide the fight. Without the snapshot both fighters
      // would score zero and a decided fight would end in a draw.
      const ctx = await deploy();
      await wirePerps(ctx);
      await ctx.arena.write.startDuelOn([0, 1, 3, PERPS]);
      const duelId = await ctx.arena.read.activeDuelId() as bigint;
      await mineBlock();

      const [, allowed] = await ctx.arena.read.previewTurnPrompt([duelId, 0]) as [string, string[]];
      const short = allowed.find((a) => a.startsWith("Short"))!;
      const name = short.slice("Short".length);
      const spec = marketByName(name);

      await runTurn(ctx, duelId, short, "Hold");
      // The market drops, and the last turn records the profit.
      await ctx.market(name).write.setMark([spec.mark * 80n / 100n]);
      await runTurn(ctx, duelId, "Hold", "Hold");

      const [live, , snapshot] = await ctx.arena.read.perpPositionOf([duelId, 0]) as
        [boolean, bigint, bigint, string, number];
      expect(live).to.equal(true);
      expect(snapshot, "the winning position was recorded").to.be.greaterThan(parseEther("2"));

      // Now the feed dies before the fight can be finalized.
      await runTurn(ctx, duelId, "Hold", "Hold");
      await ctx.market(name).write.setPriceable([false]);

      const [liveNow] = await ctx.arena.read.perpPositionOf([duelId, 0]) as
        [boolean, bigint, bigint, string, number];
      expect(liveNow, "unreadable now").to.equal(false);

      await ctx.arena.write.finalizeDuel([duelId]);
      const duel = await ctx.arena.read.duels([duelId]) as unknown[];
      expect(duel[11], "the snapshot still decided it, and correctly").to.equal(0);
    });

    it("returns the whole pot to the creator — the fighters risked the house's money", async () => {
      // The structural difference from spot. On spot the pot IS the trading capital and
      // what comes back depends on how the fight went. Here the pot stays escrowed and
      // the fighters risk Arena's seed, so nobody loses their stake because a model
      // over-traded.
      const ctx = await deploy();
      await wirePerps(ctx);

      const balBefore = await ctx.usdso.read.balanceOf([ctx.owner.account.address]) as bigint;
      await ctx.arena.write.startDuelOn([0, 1, 3, PERPS]);
      const duelId = await ctx.arena.read.activeDuelId() as bigint;
      const pot = await ctx.arena.read.duelPot([duelId]) as bigint;
      expect(pot, "two fighters at two dollars").to.equal(parseEther("4"));
      await mineBlock();

      const [, allowed] = await ctx.arena.read.previewTurnPrompt([duelId, 0]) as [string, string[]];
      await fightAndFinalize(ctx, duelId, (t) => (t === 0 ? allowed.find((a) => a.startsWith("Long"))! : "Hold"), () => "Hold");

      await ctx.arena.write.recoverFunds([duelId]);
      const balAfter = await ctx.usdso.read.balanceOf([ctx.owner.account.address]) as bigint;

      // Paid the pot back in full; the only cost was the platform fee.
      const fee = await ctx.arena.read.platformFee([3]) as bigint;
      expect(balBefore - balAfter, "only the fee was kept").to.equal(fee);
    });

    it("reclaims the fighters' collateral into the float", async () => {
      const ctx = await deploy();
      await wirePerps(ctx);
      const floatBefore = await ctx.registry.read.floatBalance() as bigint;

      await ctx.arena.write.startDuelOn([0, 1, 3, PERPS]);
      const duelId = await ctx.arena.read.activeDuelId() as bigint;
      await mineBlock();
      const [, allowed] = await ctx.arena.read.previewTurnPrompt([duelId, 0]) as [string, string[]];
      await fightAndFinalize(ctx, duelId, (t) => (t === 0 ? allowed.find((a) => a.startsWith("Short"))! : "Hold"), () => "Hold");

      const floatAfter = await ctx.registry.read.floatBalance() as bigint;
      // Back to within the spread it cost to trade — a rounding error against four
      // dollars, not a hole.
      expect(floatAfter).to.be.greaterThan(floatBefore * 99n / 100n);
    });

    it("resolves the fight even when a position CANNOT be closed", async () => {
      // The one thing that must never happen: a revert on the cleanup path would
      // freeze the fight, and a frozen fight is one where the players cannot recover
      // their stake. Far worse than seed collateral sitting in a quarantined account.
      const ctx = await deploy();
      await wirePerps(ctx);
      await ctx.arena.write.startDuelOn([0, 1, 3, PERPS]);
      const duelId = await ctx.arena.read.activeDuelId() as bigint;
      await mineBlock();

      const [, allowed] = await ctx.arena.read.previewTurnPrompt([duelId, 0]) as [string, string[]];
      const short = allowed.find((a) => a.startsWith("Short"))!;
      const name = short.slice("Short".length);

      await runTurn(ctx, duelId, short, "Hold");
      const [, , , account] = await ctx.arena.read.perpPositionOf([duelId, 0]) as
        [boolean, bigint, bigint, string, number];

      await runTurn(ctx, duelId, "Hold", "Hold");
      await runTurn(ctx, duelId, "Hold", "Hold");

      // Every book on that market goes dark, so the position cannot be closed.
      await ctx.market(name).write.clearBook([true]);
      await ctx.market(name).write.clearBook([false]);

      await ctx.arena.write.finalizeDuel([duelId]);

      const duel = await ctx.arena.read.duels([duelId]) as unknown[];
      expect(duel[8], "resolved anyway").to.equal(3);
      expect(duel[11], "a winner was still declared").to.not.equal(255);
      expect(await ctx.registry.read.quarantined([account]), "the account was quarantined")
        .to.equal(true);

      // And the players still get their money.
      await ctx.arena.write.recoverFunds([duelId]);
      expect((await ctx.arena.read.duels([duelId]) as unknown[])[10]).to.equal(true);
    });

    it("emergencyFinalize scores off the SNAPSHOT, so the owner cannot time it", async () => {
      // THE BUG: `emergencyFinalize` exists so the owner cannot pick the moment a stuck
      // duel is scored — it deliberately uses the per-turn snapshots instead of live
      // prices. The perps scoring path ignored that flag and read live equity, which
      // quietly re-opened exactly the hole the flag was added to close: the owner could
      // wait for a mark that favoured the fighter they wanted to win.
      //
      // THE TEST: put fighter zero into a long, then move the mark hugely in its favour
      // before forcing the finalize. Scored live, fighter zero wins by a mile. Scored
      // off the snapshot — the correct behaviour — it LOSES, because all the snapshot
      // ever saw was the spread it paid to get in.
      const ctx = await deploy();
      await wirePerps(ctx);
      for (const n of ["XRP", "ADA", "BNB"]) await ctx.market(n).write.setPriceable([false]);

      await ctx.arena.write.startDuelOn([0, 1, 15, PERPS]);
      const duelId = await ctx.arena.read.activeDuelId() as bigint;
      await mineBlock();

      // Turn one snapshots the opening position, then fighter zero goes long.
      await runTurn(ctx, duelId, "LongBTC", "Hold");
      // Turn two snapshots the long at an unmoved mark — the spread, and nothing else.
      await runTurn(ctx, duelId, "Hold", "Hold");

      const [, , snapA] = await ctx.arena.read.perpPositionOf([duelId, 0]) as
        [boolean, bigint, bigint, string, number];
      const [, , snapB] = await ctx.arena.read.perpPositionOf([duelId, 1]) as
        [boolean, bigint, bigint, string, number];
      expect(snapA, "the long is behind by the spread it crossed").to.be.lessThan(snapB);

      // Bitcoin doubles. Live, fighter zero is now tens of dollars ahead.
      await ctx.market("BTC").write.setMark([marketByName("BTC").mark * 2n]);
      const [live, liveEquity] = await ctx.arena.read.perpPositionOf([duelId, 0]) as
        [boolean, bigint, bigint, string, number];
      expect(live).to.equal(true);
      expect(liveEquity, "live, the long is far ahead").to.be.greaterThan(parseEther("40"));

      // Force the finalize a thousand blocks later.
      await hre.network.provider.send("hardhat_mine", ["0x3f2"]);
      await ctx.arena.write.emergencyFinalize([duelId]);

      const duel = await ctx.arena.read.duels([duelId]) as unknown[];
      expect(duel[8], "resolved").to.equal(3);
      expect(duel[11], "the snapshot decided it — the doubled mark was ignored").to.equal(1);
    });

    it("scores a wiped-out fighter as zero rather than a negative", async () => {
      // A liquidated fighter's equity can go below zero. A negative score would make
      // the comparison meaningless while telling the winner nothing they do not
      // already know.
      const ctx = await deploy();
      await wirePerps(ctx);

      // Bitcoin is the only market where one position is large against even the top
      // tier's budget — $64.60 of notional on $18 of collateral, which is the whole
      // reason it only appears at that tier. Narrowing the venue to three markets
      // guarantees it is one of them, since selection needs exactly three.
      for (const n of ["XRP", "ADA", "BNB"]) await ctx.market(n).write.setPriceable([false]);

      await ctx.arena.write.startDuelOn([0, 1, 15, PERPS]);
      const duelId = await ctx.arena.read.activeDuelId() as bigint;
      await mineBlock();

      const [, allowed] = await ctx.arena.read.previewTurnPrompt([duelId, 0]) as [string, string[]];
      expect(allowed, `Bitcoin was offered: ${allowed}`).to.include("LongBTC");
      const name = "BTC";
      const spec = marketByName(name);

      await runTurn(ctx, duelId, "LongBTC", "Hold");
      expect(await ctx.desk(name).read.fighterSide([duelId, 0]), "long Bitcoin").to.equal(1);

      // The market halves — far past this position's margin.
      await ctx.market(name).write.setMark([spec.mark / 2n]);

      const [live, equity] = await ctx.arena.read.perpPositionOf([duelId, 0]) as
        [boolean, bigint, bigint, string, number];
      expect(live).to.equal(true);
      expect(equity, "deep under water").to.be.lessThan(0n);

      const status = await ctx.registry.read.marginStatusOf([duelId, 0]) as number;
      expect(status, "and no longer healthy").to.be.greaterThan(0);
    });
  });
});
