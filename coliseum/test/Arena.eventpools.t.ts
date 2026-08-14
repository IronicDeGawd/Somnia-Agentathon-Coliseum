import { expect } from "chai";
import hre from "hardhat";
import { parseEther, maxUint256, toFunctionSelector } from "viem";

import { deployArenaWithParts } from "./helpers/arena";

const HANDLE_SELECTOR = "0xc4e34fdd" as `0x${string}`;

/// A slot with an empty label is an ordinary asset; a labelled one is a question.
const NO_LABEL = "0x0000000000000000" as `0x${string}`;
const NO_LABELS = [NO_LABEL, NO_LABEL, NO_LABEL] as [`0x${string}`, `0x${string}`, `0x${string}`];
const label = (s: string) =>
  ("0x" + Buffer.from(s, "ascii").toString("hex").padEnd(16, "0")) as `0x${string}`;

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
      NO_LABELS,
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
    expect(await arena.read.poolQuestion([deskWbtc.address]), "an unlabelled slot asks nothing")
      .to.equal(NO_LABEL);
  });

  it("rejects a zero address in any slot", async function () {
    const { arena, deskWeth, deskWbtc } = await deploy();
    const ZERO = "0x0000000000000000000000000000000000000000";

    for (const slot of [0, 1, 2]) {
      const set = [deskWeth.address, deskWbtc.address, deskWeth.address];
      set[slot] = ZERO;
      let caught: unknown;
      await arena.write.setEventDesks([set, [18, 18, 18], NO_LABELS])
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
      [[deskWeth.address, deskWbtc.address, deskSomi.address], [18, 18, 18], NO_LABELS],
      { account: stranger.account },
    ).catch((e: unknown) => { caught = e; });
    expect(caught).to.not.be.undefined;
    expect(String(caught)).to.include(toFunctionSelector("NotOwner()"));
  });

  it("re-pointing the set does not disturb a duel already running", async function () {
    const { arena, deskWeth, deskWbtc, deskSomi, poolWeth } = await deploy();

    await arena.write.setEventDesks([
      [deskWeth.address, deskWbtc.address, deskSomi.address], [18, 18, 18], NO_LABELS,
    ]);

    // A duel on the REAL set. It recorded its own pools when it started.
    await arena.write.startDuel([0, 1, 3, false]);
    const duelId = await arena.read.activeDuelId() as bigint;

    // The window "expires" and the bot points the set at fresh desks mid-duel.
    const nextWeth = await hre.viem.deployContract("MockSpotPool");
    const nextWbtc = await hre.viem.deployContract("MockSpotPool");
    const nextSomi = await hre.viem.deployContract("MockSpotPool");
    await arena.write.setEventDesks([
      [nextWeth.address, nextWbtc.address, nextSomi.address], [18, 18, 18], NO_LABELS,
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
      [deskWeth.address, deskWbtc.address, deskSomi.address], [18, 18, 18], NO_LABELS,
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
      [deskWeth.address, deskWbtc.address, deskSomi.address], [18, 18, 18], NO_LABELS,
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
      [deskWeth.address, deskWbtc.address, deskSomi.address], [18, 18, 18], NO_LABELS,
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

  it("a fighter can actually trade on an event desk", async function () {
    // Regression: the tier check used to recognise a market by looking its
    // address up in the sets Arena was deployed or configured with. An event
    // desk is registered per prediction window and changes every few minutes, so
    // it came back as "not a market at all" and EVERY trade in an event duel was
    // rejected with "pool not in tier". Both fighters would sit on their opening
    // cash for the whole fight and every event duel would end a draw — with no
    // error anywhere, because a rejected move is a normal outcome.
    const { arena, usdso, deskSomi } = await deploy();
    const mockPlatform = await hre.viem.getContractAt(
      "MockPlatform",
      (await arena.read.PLATFORM_ADDR()) as `0x${string}`,
    );
    const publicClient = await hre.viem.getPublicClient();
    const ONE = 10n ** 18n;

    // Give the desk a working book so a buy has something to hit.
    await deskSomi.write.setPoolParams([usdso.address, usdso.address, 1n, ONE / 100n, 1n]);
    await deskSomi.write.setMarkPrice([100n * ONE]);
    await deskSomi.write.setBookLevel([false, 100n * ONE, ONE]);
    await deskSomi.write.setBookLevel([true, 100n * ONE, ONE]);
    // A real desk is funded by its own treasury, so Arena sees quote liquidity
    // at the desk that it never deposited itself.
    await deskSomi.write.creditVault([arena.address, usdso.address, parseEther("1000")]);

    await arena.write.setEventDesks([
      [deskSomi.address, deskSomi.address, deskSomi.address], [18, 18, 18], NO_LABELS,
    ]);
    await hre.network.provider.send("hardhat_setBalance", [
      arena.address, "0x" + parseEther("100").toString(16),
    ]);

    await arena.write.startEventDuel([0, 1, 3]);
    const duelId = await arena.read.activeDuelId() as bigint;
    await hre.network.provider.send("evm_mine", []);

    const openingQuote = (await arena.read.fighterBalances(
      [deskSomi.address, duelId, 0],
    ) as unknown[])[1];

    const tx = await arena.write.turn([duelId]);
    const receipt = await publicClient.getTransactionReceipt({ hash: tx });
    const requestIds = receipt.logs
      .filter((l) => l.topics.length === 4)
      .map((l) => BigInt(l.topics[3]!));
    expect(requestIds.length, "both fighters were asked for a move").to.equal(2);

    // Fighters answer by name, never by number — a digit in the prompt was once
    // read back as a move index and executed as the wrong trade.
    await hre.network.provider.send("evm_mine", []);
    await mockPlatform.write.dispatchSuccessString([
      arena.address, requestIds[0], HANDLE_SELECTOR, "BuySOMI",
    ]);

    const bal = await arena.read.fighterBalances([deskSomi.address, duelId, 0]) as unknown[];
    expect(bal[0], "the fighter now holds base tokens bought on the desk").to.be.greaterThan(0n);
    expect(bal[1], "and spent quote to get them").to.be.lessThan(openingQuote as bigint);
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

  it("a labelled slot is marked as an event and keeps its label when refreshed", async function () {
    const { arena, usdso, deskWeth, deskWbtc, deskSomi } = await deploy();

    await arena.write.setEventDesks([
      [deskWeth.address, deskWbtc.address, deskSomi.address],
      [18, 18, 18],
      [label("ETHUP"), label("BTCUP"), NO_LABEL],
    ]);

    expect(await arena.read.poolQuestion([deskWeth.address]), "the slot carries its question")
      .to.equal(label("ETHUP"));
    expect(await arena.read.poolQuestion([deskSomi.address]), "the unlabelled slot stays an asset")
      .to.equal(NO_LABEL);

    // Refreshing trading rules must not quietly turn a question back into an
    // asset — the fighter would start reading odds as a price.
    await deskWeth.write.setPoolParams([usdso.address, usdso.address, 42n, 5n, 3n]);
    await arena.write.refreshPoolMeta([[deskWeth.address], [18]]);

    const after = await arena.read.poolMeta([deskWeth.address]) as unknown[];
    expect(after[3], "new tick picked up").to.equal(42n);
    expect(await arena.read.poolQuestion([deskWeth.address]), "question survived the refresh")
      .to.equal(label("ETHUP"));
  });

  it("an event slot is described as odds, with no digit anywhere in the prompt", async function () {
    const { arena, usdso, deskSomi } = await deploy();
    const ONE = 10n ** 18n;

    // A prediction's mark lives between zero and one: this is 30% likely.
    await deskSomi.write.setPoolParams([usdso.address, usdso.address, 1n, ONE / 100n, 1n]);
    await deskSomi.write.setMarkPrice([(ONE * 30n) / 100n]);
    await deskSomi.write.setBookLevel([false, (ONE * 31n) / 100n, ONE]);
    await deskSomi.write.setBookLevel([true, (ONE * 29n) / 100n, ONE]);
    await deskSomi.write.creditVault([arena.address, usdso.address, parseEther("1000")]);

    await arena.write.setEventDesks([
      [deskSomi.address, deskSomi.address, deskSomi.address],
      [18, 18, 18],
      [label("ETHUP"), label("BTCUP"), label("SOMIUP")],
    ]);
    await arena.write.startEventDuel([0, 1, 3]);
    const duelId = await arena.read.activeDuelId() as bigint;

    const [prompt, allowed] = await arena.read.previewTurnPrompt([duelId, 0]) as [string, string[]];

    // The guarantee the whole prompt layer exists for: the inference agent pulls
    // the first integer out of the model's reply, and a model echoes numbers it
    // was shown. One digit in the prompt is one way to lose a duel.
    expect(/[0-9]/.test(prompt), `no digit may reach the model: ${prompt}`).to.equal(false);

    // A probability is not a price, and it does not "rise".
    expect(prompt).to.include("SOMIUP");
    expect(prompt).to.match(/unlikely|leaning|about even|likely/);
    expect(prompt, "a question is not held like a coin").to.include("hold this position");
    expect(prompt, "no asset name for a slot that holds a question").to.not.include("SOMI ");

    // Actions read as backing or dropping the question.
    expect(allowed).to.include("Hold");
    expect(allowed.some((a) => a.startsWith("Back")), `got ${allowed}`).to.equal(true);
    expect(allowed.some((a) => a.startsWith("Buy")), "no coin-buying words").to.equal(false);
  });

  it("a fighter's answer in question words actually trades", async function () {
    // The asking side and the reply-matching side build the action names
    // independently. If they ever disagree, every answer falls outside the
    // allowed set and becomes a silent Hold — a bug that looks exactly like a
    // fighter choosing not to trade, which is why it is asserted here.
    const { arena, usdso, deskSomi } = await deploy();
    const mockPlatform = await hre.viem.getContractAt(
      "MockPlatform",
      (await arena.read.PLATFORM_ADDR()) as `0x${string}`,
    );
    const publicClient = await hre.viem.getPublicClient();
    const ONE = 10n ** 18n;

    await deskSomi.write.setPoolParams([usdso.address, usdso.address, 1n, ONE / 100n, 1n]);
    await deskSomi.write.setMarkPrice([(ONE * 40n) / 100n]);
    await deskSomi.write.setBookLevel([false, (ONE * 41n) / 100n, ONE]);
    await deskSomi.write.setBookLevel([true, (ONE * 39n) / 100n, ONE]);
    await deskSomi.write.creditVault([arena.address, usdso.address, parseEther("1000")]);

    await arena.write.setEventDesks([
      [deskSomi.address, deskSomi.address, deskSomi.address],
      [18, 18, 18],
      [label("ETHUP"), label("BTCUP"), label("SOMIUP")],
    ]);
    await hre.network.provider.send("hardhat_setBalance", [
      arena.address, "0x" + parseEther("100").toString(16),
    ]);

    await arena.write.startEventDuel([0, 1, 3]);
    const duelId = await arena.read.activeDuelId() as bigint;
    await hre.network.provider.send("evm_mine", []);

    const [, allowed] = await arena.read.previewTurnPrompt([duelId, 0]) as [string, string[]];
    const backing = allowed.find((a) => a.startsWith("Back"));
    expect(backing, `a backable question was offered: ${allowed}`).to.equal("BackSOMIUP");

    const openingQuote = (await arena.read.fighterBalances(
      [deskSomi.address, duelId, 0],
    ) as unknown[])[1];

    const tx = await arena.write.turn([duelId]);
    const receipt = await publicClient.getTransactionReceipt({ hash: tx });
    const requestIds = receipt.logs
      .filter((l) => l.topics.length === 4)
      .map((l) => BigInt(l.topics[3]!));

    await hre.network.provider.send("evm_mine", []);
    await mockPlatform.write.dispatchSuccessString([
      arena.address, requestIds[0], HANDLE_SELECTOR, backing!,
    ]);

    const bal = await arena.read.fighterBalances([deskSomi.address, duelId, 0]) as unknown[];
    expect(bal[0], "the answer was accepted and the position opened").to.be.greaterThan(0n);
    expect(bal[1], "and quote was spent doing it").to.be.lessThan(openingQuote as bigint);
  });

  it("minDepositForEvent prices a tier on the event set", async function () {
    const { arena, usdso, deskWeth, deskWbtc, deskSomi } = await deploy();
    const ONE = 10n ** 18n;

    for (const desk of [deskWeth, deskWbtc, deskSomi]) {
      await desk.write.setPoolParams([usdso.address, usdso.address, 1n, ONE / 100n, 1n]);
      await desk.write.setBookLevel([false, (ONE * 30n) / 100n, ONE]);
      await desk.write.setBookLevel([true, (ONE * 30n) / 100n, ONE]);
    }
    await arena.write.setEventDesks([
      [deskWeth.address, deskWbtc.address, deskSomi.address],
      [18, 18, 18],
      [label("ETHUP"), label("BTCUP"), NO_LABEL],
    ]);

    // A question priced at three tenths, a hundredth of a contract minimum, two
    // fighters: the smallest order is worth a fraction of a cent, which is the
    // whole reason these slots replaced the spot books.
    const three = await arena.read.minDepositForEvent([3]) as bigint;
    const fifteen = await arena.read.minDepositForEvent([15]) as bigint;
    expect(three, "a tier has a real price").to.be.greaterThan(0n);
    expect(fifteen, "more rounds cost more").to.be.greaterThan(three);
    expect(fifteen, "but still trivially small").to.be.lessThan(parseEther("1"));
  });

  it("startDuelOn picks the market, and each kind lands on its own pools", async function () {
    const { arena, deskWeth, deskWbtc, deskSomi, poolSomi } = await deploy();
    await arena.write.setEventDesks([
      [deskWeth.address, deskWbtc.address, deskSomi.address],
      [18, 18, 18],
      [label("ETHUP"), label("BTCUP"), NO_LABEL],
    ]);

    const SPOT = 0, MIXED = 2;

    // A spot fight and a mixed fight, running at the same time. Each records its
    // own three markets, which is what lets an expensive real-asset game and a
    // cheap one coexist instead of one replacing the other.
    await arena.write.startDuelOn([0, 1, 3, SPOT]);
    const spotId = (await arena.read.getActiveDuelIds() as bigint[]).at(-1)!;
    await arena.write.startDuelOn([2, 3, 3, MIXED]);
    const mixedId = (await arena.read.getActiveDuelIds() as bigint[]).at(-1)!;
    expect(mixedId, "both fights are running").to.not.equal(spotId);

    const spotOnReal = await arena.read.fighterBalances([poolSomi.address, spotId, 0]) as unknown[];
    const spotOnDesk = await arena.read.fighterBalances([deskSomi.address, spotId, 0]) as unknown[];
    expect(spotOnReal[1], "the spot fight is funded on the real coin book").to.be.greaterThan(0n);
    expect(spotOnDesk[1], "and not on the desks").to.equal(0n);

    const mixedOnDesk = await arena.read.fighterBalances([deskSomi.address, mixedId, 2]) as unknown[];
    const mixedOnReal = await arena.read.fighterBalances([poolSomi.address, mixedId, 2]) as unknown[];
    expect(mixedOnDesk[1], "the mixed fight is funded on the desks").to.be.greaterThan(0n);
    expect(mixedOnReal[1], "and not on the real book").to.equal(0n);
  });

  it("startDuelOn refuses a market that was never registered", async function () {
    const { arena } = await deploy();
    // No desks registered yet, so the mixed market does not exist.
    let caught: unknown;
    await arena.write.startDuelOn([0, 1, 3, 2]).catch((e: unknown) => { caught = e; });
    expect(caught, "a fight cannot start on three empty addresses").to.not.be.undefined;
    expect(String(caught)).to.include("InvalidPool");
  });

  it("startDuelOn rejects a market kind that is not one of the three", async function () {
    const { arena } = await deploy();
    let caught: unknown;
    await arena.write.startDuelOn([0, 1, 3, 7]).catch((e: unknown) => { caught = e; });
    expect(caught, "an unknown market must not start a fight").to.not.be.undefined;

    // And nothing was created by the attempt.
    expect((await arena.read.getActiveDuelIds() as bigint[]).length).to.equal(0);
  });

  it("minDepositForKind prices every market from one call", async function () {
    const { arena, usdso, poolWeth, poolWbtc, poolSomi, deskWeth, deskWbtc, deskSomi } = await deploy();
    const ONE = 10n ** 18n;

    // The real books priced like real coins: a whole unit costs thousands.
    for (const pool of [poolWeth, poolWbtc, poolSomi]) {
      await pool.write.setPoolParams([usdso.address, usdso.address, 1n, ONE / 1000n, 1n]);
      await pool.write.setBookLevel([false, 2000n * ONE, ONE]);
      await pool.write.setBookLevel([true, 2000n * ONE, ONE]);
    }
    // Arena caches each pool's trading rules, so a pool whose rules changed after
    // deployment is priced from the stale copy until it is told to re-read them.
    await arena.write.refreshPoolMeta([
      [poolWeth.address, poolWbtc.address, poolSomi.address], [18, 18, 18],
    ]);

    // The questions priced as probabilities: a whole contract is worth under one.
    for (const desk of [deskWeth, deskWbtc, deskSomi]) {
      await desk.write.setPoolParams([usdso.address, usdso.address, 1n, ONE / 100n, 1n]);
      await desk.write.setBookLevel([false, (ONE * 30n) / 100n, ONE]);
      await desk.write.setBookLevel([true, (ONE * 30n) / 100n, ONE]);
    }
    await arena.write.setEventDesks([
      [deskWeth.address, deskWbtc.address, deskSomi.address],
      [18, 18, 18],
      [label("ETHUP"), label("BTCUP"), NO_LABEL],
    ]);

    const spot = await arena.read.minDepositForKind([9, 0]) as bigint;
    const mixed = await arena.read.minDepositForKind([9, 2]) as bigint;
    expect(mixed, "the mixed market is the cheap one").to.be.lessThan(spot);
    expect(await arena.read.minDepositForKind([9, 2]), "and agrees with the event view")
      .to.equal(await arena.read.minDepositForEvent([9]));
  });

  it("every mixed tier trades every slot, so even the shortest offers a choice", async function () {
    // The tier ladder narrows on the coin books because a smallest BTC order
    // costs dollars and a smallest SOMI order costs cents, so a cheap short
    // fight used only the cheap slot. On questions that reasoning inverts —
    // every slot costs a fraction of a cent — and narrowing would leave the
    // shortest fight with ONE option per turn, which ends in a tie.
    const { arena, usdso, deskWeth, deskWbtc, deskSomi } = await deploy();
    const ONE = 10n ** 18n;

    for (const desk of [deskWeth, deskWbtc, deskSomi]) {
      await desk.write.setPoolParams([usdso.address, usdso.address, 1n, ONE / 100n, 1n]);
      await desk.write.setMarkPrice([(ONE * 40n) / 100n]);
      await desk.write.setBookLevel([false, (ONE * 41n) / 100n, ONE]);
      await desk.write.setBookLevel([true, (ONE * 39n) / 100n, ONE]);
      await desk.write.creditVault([arena.address, usdso.address, parseEther("1000")]);
    }
    await arena.write.setEventDesks([
      [deskWeth.address, deskWbtc.address, deskSomi.address],
      [18, 18, 18],
      [label("ETHUP"), label("BTCUP"), label("ETHHOUR")],
    ]);

    // Four fights at once, one per tier — above the default concurrency cap.
    await arena.write.setMaxActiveDuels([4]);

    const ALL_SLOTS = 0x07;
    for (const turns of [3, 6, 9, 15]) {
      await arena.write.startDuelOn([0, 1, turns, 2]);
      const duelId = (await arena.read.getActiveDuelIds() as bigint[]).at(-1)!;
      const duel = await arena.read.duels([duelId]) as unknown[];
      expect(Number(duel[7]), `${turns}-round mixed fight trades every slot`).to.equal(ALL_SLOTS);

      const [prompt, allowed] = await arena.read.previewTurnPrompt([duelId, 0]) as [string, string[]];
      expect(/[0-9]/.test(prompt), "still no digit in the prompt").to.equal(false);
      // Hold plus a way into each of the three questions.
      const backs = allowed.filter((a) => a.startsWith("Back"));
      expect(backs.length, `${turns} rounds offers all three questions: ${allowed}`).to.equal(3);
      expect(new Set(backs).size, "and they are three DIFFERENT questions").to.equal(3);
    }
  });

  it("the coin ladder is untouched on the spot market", async function () {
    // Only the mixed market changed. A spot fight must still narrow with its
    // tier, or a three-round spot fight would suddenly demand a BTC order.
    const { arena, usdso, poolWeth, poolWbtc, poolSomi } = await deploy();
    const ONE = 10n ** 18n;
    for (const pool of [poolWeth, poolWbtc, poolSomi]) {
      await pool.write.setPoolParams([usdso.address, usdso.address, 1n, ONE / 1000n, 1n]);
      await pool.write.setBookLevel([false, 2000n * ONE, ONE]);
      await pool.write.setBookLevel([true, 2000n * ONE, ONE]);
    }
    await arena.write.refreshPoolMeta([
      [poolWeth.address, poolWbtc.address, poolSomi.address], [18, 18, 18],
    ]);

    await arena.write.startDuelOn([0, 1, 3, 0]);
    const duelId = (await arena.read.getActiveDuelIds() as bigint[]).at(-1)!;
    const duel = await arena.read.duels([duelId]) as unknown[];
    expect(Number(duel[7]), "a three-round spot fight still trades SOMI alone").to.equal(0x04);
  });
});
