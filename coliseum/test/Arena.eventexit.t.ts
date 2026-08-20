import { expect } from "chai";
import hre from "hardhat";
import { parseEther, maxUint256 } from "viem";

import { deployArenaWithParts } from "./helpers/arena";

const HANDLE_SELECTOR = "0xc4e34fdd" as `0x${string}`;
const ONE = 10n ** 18n;
const label = (s: string) =>
  ("0x" + Buffer.from(s, "ascii").toString("hex").padEnd(16, "0")) as `0x${string}`;

/**
 * Getting OUT of a prediction.
 *
 * Every other event test uses a spot-pool stand-in for a desk, and a spot pool
 * hands Arena a real token it can weigh. A live prediction desk does not: it keeps
 * the position on its own books and advertises a token address that is an
 * uninitialised proxy, answering nothing. Arena's deliverability check read that
 * refusal as "I hold none" and withheld the exit, so for the life of the market no
 * fighter was ever offered a way out of a question it had backed.
 *
 * Measured on duel 70, a fifteen-round fight: a fighter whose own prompt line read
 * "You hold this position" was offered Hold and three ways to back MORE, every
 * single turn. The market's order count therefore could not grow with fight
 * length — 4, 5, 7 and 6 orders across the four tiers.
 *
 * These tests use `MockPositionDesk`, which reproduces both halves of that shape:
 * a mute position token, and the venue's own answer to what it can deliver.
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
  await hre.network.provider.send("hardhat_setBalance", [
    arena.address, "0x" + parseEther("100").toString(16),
  ]);

  // One desk in all three slots, so a single question carries the whole test and
  // the position it holds is unambiguous.
  const desk = await hre.viem.deployContract("MockPositionDesk", [usdso.address]);
  await desk.write.setPoolParams([1n, ONE / 100n, 1n]);
  await desk.write.setBookLevel([false, (ONE * 41n) / 100n, ONE]);   // someone selling
  await desk.write.setBookLevel([true,  (ONE * 39n) / 100n, ONE]);   // someone buying
  await desk.write.creditVault([arena.address, usdso.address, parseEther("1000")]);

  await arena.write.setEventDesks([
    [desk.address, desk.address, desk.address],
    [18, 18, 18],
    [label("ETHUP"), label("BTCUP"), label("SOMIUP")],
  ]);

  return { arena, usdso, desk, mockPlatform, owner };
}

/** Start a fight and answer one turn with `answer` for fighter 0. */
async function answerOneTurn(
  arena: Awaited<ReturnType<typeof deploy>>["arena"],
  mockPlatform: Awaited<ReturnType<typeof deploy>>["mockPlatform"],
  duelId: bigint,
  answer: string,
) {
  const publicClient = await hre.viem.getPublicClient();
  const tx = await arena.write.turn([duelId]);
  const receipt = await publicClient.getTransactionReceipt({ hash: tx });
  const requestIds = receipt.logs
    .filter((l) => l.topics.length === 4)
    .map((l) => BigInt(l.topics[3]!));
  await hre.network.provider.send("evm_mine", []);
  await mockPlatform.write.dispatchSuccessString([
    arena.address, requestIds[0], HANDLE_SELECTOR, answer,
  ]);
  return requestIds;
}

describe("Arena — getting out of a prediction", function () {
  this.timeout(120_000);

  it("a fighter holding a position is offered a way out of it", async function () {
    const { arena, desk, mockPlatform } = await deploy();

    await arena.write.startEventDuel([0, 1, 15]);
    const duelId = await arena.read.activeDuelId() as bigint;
    await hre.network.provider.send("evm_mine", []);

    const [, opening] = await arena.read.previewTurnPrompt([duelId, 0]) as [string, string[]];
    expect(opening, "holding nothing, there is nothing to drop").to.not.include("DropSOMIUP");
    expect(opening, "but a question can be backed").to.include("BackSOMIUP");

    await answerOneTurn(arena, mockPlatform, duelId, "BackSOMIUP");

    const held = (await arena.read.fighterBalances([desk.address, duelId, 0]) as unknown[])[0] as bigint;
    expect(held, "the back opened a position").to.be.greaterThan(0n);
    expect(await desk.read.yesBalance18(), "and the desk is holding it").to.be.greaterThan(0n);

    const [prompt, allowed] = await arena.read.previewTurnPrompt([duelId, 0]) as [string, string[]];
    expect(prompt, "the fighter is told it holds the position").to.include("hold this position");
    expect(
      allowed,
      `holding a position, an exit must be on the table: ${allowed}`,
    ).to.include("DropSOMIUP");
  });

  it("the exit is refused when the venue cannot say what it can deliver", async function () {
    // The fix must not hand out an exit nothing can honour. A venue that answers
    // neither question is refused exactly as before — otherwise a fighter is
    // offered a move whose order reverts, and it pays for that with its turn,
    // which is strictly worse than never being offered it.
    const { arena, desk, mockPlatform } = await deploy();

    await arena.write.startEventDuel([0, 1, 15]);
    const duelId = await arena.read.activeDuelId() as bigint;
    await hre.network.provider.send("evm_mine", []);
    await answerOneTurn(arena, mockPlatform, duelId, "BackSOMIUP");

    const [, withVenue] = await arena.read.previewTurnPrompt([duelId, 0]) as [string, string[]];
    expect(withVenue, "answerable venue: the exit is offered").to.include("DropSOMIUP");

    await desk.write.setMuteVenue([true]);
    const [, muted] = await arena.read.previewTurnPrompt([duelId, 0]) as [string, string[]];
    expect(muted, "a venue that cannot answer is refused").to.not.include("DropSOMIUP");
    expect(muted, "and backing is unaffected — that side never depended on this")
      .to.include("BackSOMIUP");
  });

  it("the exit is refused when the desk holds less than the fighter is selling", async function () {
    // The ledger and the desk can disagree. The ledger says what the fighter is
    // owed; only the desk says what can actually be handed over, and it is the
    // smaller of the two that decides. Getting this backwards is how the spot
    // market offered a sell every turn and had every one refused by the venue.
    const { arena, desk, mockPlatform } = await deploy();

    await arena.write.startEventDuel([0, 1, 15]);
    const duelId = await arena.read.activeDuelId() as bigint;
    await hre.network.provider.send("evm_mine", []);
    await answerOneTurn(arena, mockPlatform, duelId, "BackSOMIUP");

    // Asserted as a CONTRAST, not just an absence. On its own, "not offered" is
    // what the broken code did for every desk in every state, so a one-sided
    // assertion here passes whether the fix is present or not — it has to show the
    // offer appearing and disappearing with the desk's holding.
    const [, whenHeld] = await arena.read.previewTurnPrompt([duelId, 0]) as [string, string[]];
    expect(whenHeld, "the desk holds the position, so the exit is open").to.include("DropSOMIUP");

    await desk.write.setYesBalance18([0n]);
    const [, whenEmpty] = await arena.read.previewTurnPrompt([duelId, 0]) as [string, string[]];
    expect(whenEmpty, "a desk holding nothing cannot deliver a sale").to.not.include("DropSOMIUP");
  });

  it("dropping actually executes and gives the position back", async function () {
    // An offer that cannot be acted on is worse than no offer, so the whole round
    // trip is asserted: back, then drop, and the position and the cash both move
    // the other way.
    const { arena, usdso, desk, mockPlatform } = await deploy();

    await arena.write.startEventDuel([0, 1, 15]);
    const duelId = await arena.read.activeDuelId() as bigint;
    await hre.network.provider.send("evm_mine", []);
    await answerOneTurn(arena, mockPlatform, duelId, "BackSOMIUP");

    const afterBack = await arena.read.fighterBalances([desk.address, duelId, 0]) as unknown[];
    const heldAfterBack  = afterBack[0] as bigint;
    const quoteAfterBack = afterBack[1] as bigint;
    const ordersAfterBack = await desk.read.ordersPlaced() as bigint;

    await answerOneTurn(arena, mockPlatform, duelId, "DropSOMIUP");

    const afterDrop = await arena.read.fighterBalances([desk.address, duelId, 0]) as unknown[];
    expect(await desk.read.ordersPlaced(), "the drop reached the venue")
      .to.be.greaterThan(ordersAfterBack);
    expect(await desk.read.lastOrderWasBid(), "and reached it as a sale").to.equal(false);
    expect(afterDrop[0] as bigint, "the position came back down").to.be.lessThan(heldAfterBack);
    expect(afterDrop[1] as bigint, "and the fighter was paid for it")
      .to.be.greaterThan(quoteAfterBack);
    expect(usdso.address).to.be.a("string");
  });
});
