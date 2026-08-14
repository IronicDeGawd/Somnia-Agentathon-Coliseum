import { expect } from "chai";
import hre from "hardhat";
import { parseEther, maxUint256, toFunctionSelector } from "viem";

import { deployArenaWithParts } from "./helpers/arena";

/**
 * Arena can be pointed at a third pool set: the event-contract desks.
 *
 * Unlike the real and simulated sets, this one is expected to move constantly —
 * a prediction window opens at a fresh address every few minutes. These tests
 * cover that churn, and in particular that re-pointing it cannot reach into a
 * fight already underway.
 */
async function deploy() {
  const [owner] = await hre.viem.getWalletClients();
  const registry     = await hre.viem.deployContract("FighterRegistry");
  const usdso        = await hre.viem.deployContract("MockERC20", ["USDso", "USDso"]);
  const poolWeth     = await hre.viem.deployContract("MockSpotPool");
  const poolWbtc     = await hre.viem.deployContract("MockSpotPool");
  const poolSomi     = await hre.viem.deployContract("MockSpotPool");
  const mockPlatform = await hre.viem.deployContract("MockPlatform");

  const { arena } = await deployArenaWithParts(hre, [
    registry.address,
    usdso.address,
    poolWeth.address,
    poolWbtc.address,
    poolSomi.address,
    mockPlatform.address,
    1n,
    [18, 18, 18],
  ], { value: parseEther("33") });

  await usdso.write.mint([owner.account.address, parseEther("100000")]);
  await usdso.write.approve([arena.address, maxUint256]);

  // Three stand-ins for event desks, with trading rules unlike the real pools'.
  const deskWeth = await hre.viem.deployContract("MockSpotPool");
  const deskWbtc = await hre.viem.deployContract("MockSpotPool");
  const deskSomi = await hre.viem.deployContract("MockSpotPool");

  return { arena, usdso, poolWeth, poolWbtc, poolSomi, deskWeth, deskWbtc, deskSomi, owner };
}

describe("Arena — event-contract pool set", function () {
  this.timeout(120_000);

  it("registers three desks and caches their trading rules", async function () {
    const { arena, usdso, deskWeth, deskWbtc, deskSomi } = await deploy();

    // Give one desk a distinctive rule so we can prove it was read, not assumed.
    await deskWbtc.write.setPoolParams([usdso.address, usdso.address, 7n, 9n, 11n]);

    expect(await arena.read.eventPoolsSet()).to.equal(false);

    await arena.write.setEventDesks([
      [deskWeth.address, deskWbtc.address, deskSomi.address],
      [18, 8, 18],
    ]);

    expect(await arena.read.eventPoolsSet()).to.equal(true);
    expect((await arena.read.EVENT_POOL_WETH() as string).toLowerCase())
      .to.equal(deskWeth.address.toLowerCase());
    expect((await arena.read.EVENT_POOL_WBTC() as string).toLowerCase())
      .to.equal(deskWbtc.address.toLowerCase());
    expect((await arena.read.EVENT_POOL_SOMI() as string).toLowerCase())
      .to.equal(deskSomi.address.toLowerCase());

    // baseDecimals, minQuantity, lotSize, tickSize
    const meta = await arena.read.poolMeta([deskWbtc.address]) as unknown[];
    expect(meta[0], "base decimals come from the caller").to.equal(8);
    expect(meta[1], "minimum size read from the desk").to.equal(9n);
    expect(meta[2], "lot size read from the desk").to.equal(11n);
    expect(meta[3], "tick size read from the desk").to.equal(7n);
  });

  it("rejects a zero address in any slot", async function () {
    const { arena, deskWeth, deskWbtc } = await deploy();
    const ZERO = "0x0000000000000000000000000000000000000000";

    for (const slot of [0, 1, 2]) {
      const set = [deskWeth.address, deskWbtc.address, deskWeth.address];
      set[slot] = ZERO;
      let caught: unknown;
      await arena.write.setEventDesks([set, [18, 18, 18]])
        .catch((e: unknown) => { caught = e; });
      expect(caught, `slot ${slot} must reject a zero address`).to.not.be.undefined;
      expect(String(caught)).to.include("InvalidPool");
    }
    expect(await arena.read.eventPoolsSet(), "nothing was registered").to.equal(false);
  });

  it("only the owner may register desks", async function () {
    const { arena, deskWeth, deskWbtc, deskSomi } = await deploy();
    const [, stranger] = await hre.viem.getWalletClients();

    let caught: unknown;
    await arena.write.setEventDesks(
      [[deskWeth.address, deskWbtc.address, deskSomi.address], [18, 18, 18]],
      { account: stranger.account },
    ).catch((e: unknown) => { caught = e; });
    expect(caught).to.not.be.undefined;
    expect(String(caught)).to.include(toFunctionSelector("NotOwner()"));
  });

  it("re-pointing the set does not disturb a duel already running", async function () {
    const { arena, deskWeth, deskWbtc, deskSomi, poolWeth } = await deploy();

    await arena.write.setEventDesks([
      [deskWeth.address, deskWbtc.address, deskSomi.address], [18, 18, 18],
    ]);

    // A duel on the REAL set. It recorded its own pools when it started.
    await arena.write.startDuel([0, 1, 3, false]);
    const duelId = await arena.read.activeDuelId() as bigint;

    // The window "expires" and the bot points the set at fresh desks mid-duel.
    const nextWeth = await hre.viem.deployContract("MockSpotPool");
    const nextWbtc = await hre.viem.deployContract("MockSpotPool");
    const nextSomi = await hre.viem.deployContract("MockSpotPool");
    await arena.write.setEventDesks([
      [nextWeth.address, nextWbtc.address, nextSomi.address], [18, 18, 18],
    ]);

    expect((await arena.read.EVENT_POOL_WETH() as string).toLowerCase())
      .to.equal(nextWeth.address.toLowerCase());

    // The running duel still values itself on the pools it started with. If it
    // read the registry instead, this would now be reading empty books.
    const prompt = await arena.read.previewTurnPrompt([duelId, 0]);
    expect(prompt, "the running duel still builds a prompt").to.not.be.undefined;

    await poolWeth.write.setMarkPrice([2000n * 10n ** 18n]);
    const ids = await arena.read.getActiveDuelIds() as bigint[];
    expect(ids, "duel is untouched by the re-point").to.deep.equal([duelId]);
  });

  it("startEventDuel binds the duel to the desks, not the real pools", async function () {
    const { arena, deskWeth, deskWbtc, deskSomi, poolSomi } = await deploy();
    await arena.write.setEventDesks([
      [deskWeth.address, deskWbtc.address, deskSomi.address], [18, 18, 18],
    ]);

    await arena.write.startEventDuel([0, 1, 3]);
    const duelId = await arena.read.activeDuelId() as bigint;

    // A 3-turn duel trades the SOMI slot only, so that is where each fighter's
    // opening balance is credited. It must land on the DESK, and nothing at all
    // on the real pool the duel would have used before.
    const onDesk = await arena.read.fighterBalances([deskSomi.address, duelId, 0]) as unknown[];
    const onReal = await arena.read.fighterBalances([poolSomi.address, duelId, 0]) as unknown[];
    expect(onDesk[1], "fighter is funded on the event desk").to.be.greaterThan(0n);
    expect(onReal[1], "and not on the real pool").to.equal(0n);

    // Same escrow and payout path as any other duel.
    expect(await arena.read.escrowedPot()).to.be.greaterThan(0n);

    // Not a third kind of fight — it is a real duel that happens to use desks.
    const duel = await arena.read.duels([duelId]) as unknown[];
    expect(duel[12], "recorded as a real, non-simulated duel").to.equal(false);
  });

  it("startEventDuel refuses before any desks are registered", async function () {
    const { arena } = await deploy();
    let caught: unknown;
    await arena.write.startEventDuel([0, 1, 3]).catch((e: unknown) => { caught = e; });
    expect(caught, "no desks registered yet").to.not.be.undefined;
    expect(String(caught)).to.include("InvalidPool");
  });

  it("only the owner may start an event duel", async function () {
    const { arena, deskWeth, deskWbtc, deskSomi } = await deploy();
    const [, stranger] = await hre.viem.getWalletClients();
    await arena.write.setEventDesks([
      [deskWeth.address, deskWbtc.address, deskSomi.address], [18, 18, 18],
    ]);

    let caught: unknown;
    await arena.write.startEventDuel([0, 1, 3], { account: stranger.account })
      .catch((e: unknown) => { caught = e; });
    expect(caught, "players reach duels through the queue, not this door").to.not.be.undefined;
    expect(String(caught)).to.include(toFunctionSelector("NotOwner()"));
  });

  it("an event duel and an ordinary duel run side by side without crossing", async function () {
    const { arena, deskWeth, deskWbtc, deskSomi, poolSomi } = await deploy();
    await arena.write.setEventDesks([
      [deskWeth.address, deskWbtc.address, deskSomi.address], [18, 18, 18],
    ]);

    await arena.write.startDuel([0, 1, 3, false]);
    await arena.write.startEventDuel([2, 3, 3]);

    const ids = await arena.read.getActiveDuelIds() as bigint[];
    expect(ids.length, "both are running").to.equal(2);
    const [plain, event] = ids;

    // Each duel's opening balances sit only on its own market.
    expect((await arena.read.fighterBalances([poolSomi.address, plain, 0]) as unknown[])[1])
      .to.be.greaterThan(0n);
    expect((await arena.read.fighterBalances([deskSomi.address, plain, 0]) as unknown[])[1])
      .to.equal(0n);
    expect((await arena.read.fighterBalances([deskSomi.address, event, 2]) as unknown[])[1])
      .to.be.greaterThan(0n);
    expect((await arena.read.fighterBalances([poolSomi.address, event, 2]) as unknown[])[1])
      .to.equal(0n);
  });

  it("refreshPoolMeta re-reads rules for a pool Arena already knows", async function () {
    const { arena, usdso, poolWbtc } = await deploy();

    const before = await arena.read.poolMeta([poolWbtc.address]) as unknown[];
    expect(before[3], "tick starts at the mock default").to.not.equal(42n);

    // dreamDEX changes the pool's tick size after Arena cached it.
    await poolWbtc.write.setPoolParams([usdso.address, usdso.address, 42n, 5n, 3n]);
    await arena.write.refreshPoolMeta([[poolWbtc.address], [8]]);

    const after = await arena.read.poolMeta([poolWbtc.address]) as unknown[];
    expect(after[0], "decimals updated").to.equal(8);
    expect(after[3], "new tick size picked up without a redeploy").to.equal(42n);
  });

  it("refreshPoolMeta refuses an address Arena does not trade on", async function () {
    const { arena } = await deploy();
    const stray = await hre.viem.deployContract("MockSpotPool");

    let caught: unknown;
    await arena.write.refreshPoolMeta([[stray.address], [18]])
      .catch((e: unknown) => { caught = e; });
    expect(caught, "an unknown pool must be rejected").to.not.be.undefined;
    expect(String(caught)).to.include("InvalidPool");
  });

  it("refreshPoolMeta rejects mismatched list lengths", async function () {
    const { arena, poolWbtc, poolSomi } = await deploy();

    let caught: unknown;
    await arena.write.refreshPoolMeta([[poolWbtc.address, poolSomi.address], [8]])
      .catch((e: unknown) => { caught = e; });
    expect(caught, "one decimals entry per pool").to.not.be.undefined;
  });
});
