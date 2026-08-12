import { expect } from "chai";
import hre from "hardhat";
import { parseEther, getAddress, maxUint256, keccak256, toBytes } from "viem";

const HANDLE_SELECTOR = "0xc4e34fdd" as `0x${string}`;

// keccak256("DuelResolved(uint256,uint8,uint256,uint256)")
const DUEL_RESOLVED_SIG = keccak256(toBytes("DuelResolved(uint256,uint8,uint256,uint256)"));
const DUEL_DRAWN_SIG    = keccak256(toBytes("DuelDrawn(uint256,uint256,uint256)"));

// DuelStatus: Active=1, Finalizing=2, Resolved=3 (None removed, Pending removed)
const DuelStatus = {
  Active:     1,
  Finalizing: 2,
  Resolved:   3,
} as const;

// duels() tuple field indices (new struct order)
const D = {
  fighterA:               0,
  fighterB:               1,
  creator:                2,
  startBlock:             3,
  lastTurnBlock:          4,
  completedCallbacks:     5,
  turns:                  6,
  poolMask:               7,
  status:                 8,
  initialUsdsoPerFighter: 9,
} as const;

async function mineBlock() {
  await hre.network.provider.send("evm_mine", []);
}

/**
 * @param tradableSomi configure SOMI with pool params and a book BEFORE Arena
 *        deploys, so buys are executable. Arena caches pool metadata in its
 *        constructor, so this cannot be done afterwards. SOMI specifically,
 *        because the 3-turn tier's pool mask covers SOMI alone. Off by default:
 *        with no book, the only executable action is Hold, which is what most of
 *        these tests want.
 */
async function deploy(tradableSomi = false) {
  const [owner] = await hre.viem.getWalletClients();
  const registry    = await hre.viem.deployContract("FighterRegistry");
  const usdso       = await hre.viem.deployContract("MockERC20", ["USDso", "USDso"]);
  const poolWeth    = await hre.viem.deployContract("MockSpotPool");
  const poolWbtc    = await hre.viem.deployContract("MockSpotPool");
  const poolSomi    = await hre.viem.deployContract("MockSpotPool");
  const mockPlatform = await hre.viem.deployContract("MockPlatform");

  if (tradableSomi) {
    const ONE = 10n ** 18n;
    // baseToken, quoteToken, tickSize, minQuantity, lotSize
    await poolSomi.write.setPoolParams([usdso.address, usdso.address, 1n, ONE / 100n, 1n]);
    await poolSomi.write.setMarkPrice([100n * ONE]);
    // An ask to buy into, and a bid so a mid price exists.
    await poolSomi.write.setBookLevel([false, 100n * ONE, ONE]);
    await poolSomi.write.setBookLevel([true, 100n * ONE, ONE]);
  }

  // Arena exceeds the 24576-byte contract limit unless the prompt builders live
  // in a linked library, so ArenaUtils has to be deployed alongside it.
  const arenaUtils = await hre.viem.deployContract("ArenaUtils");
  const arena = await hre.viem.deployContract("Arena", [
    registry.address,
    usdso.address,
    poolWeth.address,
    poolWbtc.address,
    poolSomi.address,
    mockPlatform.address,
    1n,
    [18, 18, 18],
  ], { value: parseEther("33"), libraries: { ArenaUtils: arenaUtils.address } });

  // Fund arena with enough STT for 30 requests (each = 0.03 + 0.07*3 = 0.24)
  await hre.network.provider.send("hardhat_setBalance", [
    arena.address,
    "0x" + parseEther("43").toString(16),
  ]);

  // Mint USDso to owner and approve arena for large amount (covers any test)
  await usdso.write.mint([owner.account.address, parseEther("100000")]);
  await usdso.write.approve([arena.address, maxUint256]);

  return { arena, mockPlatform, poolWeth, poolWbtc, poolSomi, usdso, owner };
}

// Helper: run one full turn
async function runOneTurn(
  arena: Awaited<ReturnType<typeof deploy>>["arena"],
  mockPlatform: Awaited<ReturnType<typeof deploy>>["mockPlatform"],
  nextExpectedReqIdA: bigint,
): Promise<{ reqIdA: bigint; reqIdB: bigint }> {
  const activeId = (await arena.read.activeDuelId()) as bigint;
  return runOneTurnFor(arena, mockPlatform, activeId, nextExpectedReqIdA);
}

// Helper: run one full turn of a NAMED duel, so concurrent duels can be advanced
// one at a time and checked against each other.
async function runOneTurnFor(
  arena: Awaited<ReturnType<typeof deploy>>["arena"],
  mockPlatform: Awaited<ReturnType<typeof deploy>>["mockPlatform"],
  duelId: bigint,
  _nextExpectedReqIdA?: bigint,
): Promise<{ reqIdA: bigint; reqIdB: bigint }> {
  const publicClient = await hre.viem.getPublicClient();

  const tx = await arena.write.turn([duelId]);
  const receipt = await publicClient.getTransactionReceipt({ hash: tx });

  const requestIds: bigint[] = [];
  for (const log of receipt.logs) {
    if (log.topics.length === 4) {
      requestIds.push(BigInt(log.topics[3]!));
    }
  }
  expect(requestIds.length, "expected 2 FighterMoveRequested events").to.equal(2);

  const [reqIdA, reqIdB] = requestIds;
  await mineBlock();

  await mockPlatform.write.dispatchSuccess([arena.address, reqIdA, HANDLE_SELECTOR, 0n]);
  await mockPlatform.write.dispatchSuccess([arena.address, reqIdB, HANDLE_SELECTOR, 0n]);

  return { reqIdA, reqIdB };
}

describe("Arena — Duel lifecycle", function () {
  this.timeout(60_000);

  const FIGHTER_A = 0;
  const FIGHTER_B = 1;
  const TURNS_3   = 3;
  const TURNS_15  = 15;

  it("startDuel → 15 turns → finalizeDuel → winner determined", async function () {
    const { arena, mockPlatform, poolWeth } = await deploy();
    const publicClient = await hre.viem.getPublicClient();

    const startTx = await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_15, false]);
    const startReceipt = await publicClient.getTransactionReceipt({ hash: startTx });
    expect(startReceipt.status).to.equal("success");

    const duelId = await arena.read.activeDuelId() as bigint;
    expect(duelId).to.equal(1n);

    await mineBlock();

    let nextReqId = 1n;
    for (let i = 0; i < 15; i++) {
      await runOneTurn(arena, mockPlatform, nextReqId);
      nextReqId += 2n;
    }

    const duelState = await arena.read.duels([duelId]) as unknown[];
    expect(duelState[D.completedCallbacks]).to.equal(30, "expected 30 completed callbacks");
    expect(duelState[D.status]).to.equal(DuelStatus.Active, "should still be Active before finalize");

    await poolWeth.write.setMarkPrice([2000n * 10n ** 18n]);

    const finalizeTx = await arena.write.finalizeDuel([duelId]);
    const finalizeReceipt = await publicClient.getTransactionReceipt({ hash: finalizeTx });
    expect(finalizeReceipt.status).to.equal("success");

    const resolvedLog = finalizeReceipt.logs.find((l) => l.topics[0] === DUEL_RESOLVED_SIG);
    expect(resolvedLog, "expected DuelResolved log").to.not.be.undefined;

    // Both fighters held every turn, so they end on identical balances. That used
    // to be awarded to fighterA by `valueA >= valueB`; it is a draw.
    const winnerId = parseInt(resolvedLog!.topics[2]!, 16);
    expect(winnerId).to.equal(255, "a level duel has no winner");

    const drawn = finalizeReceipt.logs.find((l) => l.topics[0] === DUEL_DRAWN_SIG);
    expect(drawn, "expected DuelDrawn log alongside DuelResolved").to.not.be.undefined;

    const activeAfter = await arena.read.activeDuelId() as bigint;
    expect(activeAfter).to.equal(0n, "activeDuelId should be 0 after finalize");

    const finalState = await arena.read.duels([duelId]) as unknown[];
    expect(finalState[D.status]).to.equal(DuelStatus.Resolved);
  });

  // The duel-21 regression, in contract form.
  //
  // Every duel begins with both fighters holding only cash and zero base tokens,
  // so a Sell is impossible on turn one by definition. The deployed contract
  // still listed "6=SellSOMI" as valid, and the agent's extract-then-clamp rule
  // turned an echoed price into exactly that 6. The fighter sold a token it did
  // not hold, the order was rejected, the turn was burned, and the player lost.
  it("a fighter holding no base is never offered a Sell it cannot execute", async function () {
    const { arena } = await deploy();
    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_3, false]);
    const duelId = await arena.read.activeDuelId() as bigint;

    for (const fighter of [FIGHTER_A, FIGHTER_B]) {
      const [prompt, allowed] = await arena.read.previewTurnPrompt([duelId, fighter]) as [string, string[]];

      expect(allowed).to.include("Hold", "Hold is always executable");
      expect(allowed.filter((a) => a.startsWith("Sell"))).to.have.length(
        0,
        `fighter ${fighter} holds no base on turn one, so no Sell may be offered — got ${allowed.join(", ")}`,
      );
      // The prompt must not smuggle a number back in either: a digit anywhere is
      // something the model can echo and the agent can extract.
      expect(prompt).to.not.match(/\d/, `prompt must carry no numerals, got: ${prompt}`);
    }
  });

  it("records the resolved duel in DuelHistory when the sink is set", async function () {
    const { arena, mockPlatform, poolSomi } = await deploy();
    const history = await hre.viem.deployContract("DuelHistory", [arena.address]);
    await arena.write.setDuelHistory([history.address]);

    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_3, false]);
    const duelId = await arena.read.activeDuelId() as bigint;
    await mineBlock();

    let nextReqId = 1n;
    for (let i = 0; i < 3; i++) {
      await runOneTurn(arena, mockPlatform, nextReqId);
      nextReqId += 2n;
    }

    await poolSomi.write.setMarkPrice([2000n * 10n ** 18n]);
    await arena.write.finalizeDuel([duelId]);

    expect(Number(await history.read.totalDuels()), "history should record the duel").to.equal(1);
    expect(await history.read.recorded([duelId])).to.equal(true);
    // Neither fighter traded, so the duel is level: a draw on both records,
    // rather than a win handed to whoever happened to occupy slot A.
    const ra = await history.read.getFighterRecord([FIGHTER_A]) as { wins: bigint; draws: bigint };
    const rb = await history.read.getFighterRecord([FIGHTER_B]) as { losses: bigint; draws: bigint };
    expect(Number(ra.wins)).to.equal(0, "a draw is not a win");
    expect(Number(rb.losses)).to.equal(0, "a draw is not a loss");
    expect(Number(ra.draws)).to.equal(1);
    expect(Number(rb.draws)).to.equal(1);
  });

  it("runs maxActiveDuels duels at once and rejects the next with ArenaFull", async function () {
    const { arena } = await deploy();
    expect(await arena.read.maxActiveDuels()).to.equal(3);

    for (let i = 0; i < 3; i++) {
      await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_3, false]);
    }
    const ids = await arena.read.getActiveDuelIds() as bigint[];
    expect(ids).to.deep.equal([1n, 2n, 3n]);
    expect(await arena.read.hasCapacity()).to.equal(false);

    let caught: unknown = undefined;
    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_3, false]).catch((e: unknown) => { caught = e; });
    expect(caught, "expected ArenaFull revert").to.not.be.undefined;
    expect(String(caught)).to.include("ArenaFull");
  });

  it("setMaxActiveDuels is owner-only and bounded by MAX_ACTIVE_CEILING", async function () {
    const { arena } = await deploy();
    const [, stranger] = await hre.viem.getWalletClients();

    await arena.write.setMaxActiveDuels([5]);
    expect(await arena.read.maxActiveDuels()).to.equal(5);

    // Zero would wedge the arena shut; above the ceiling would let the owner
    // start more duels than one STT balance can pay inference for.
    for (const bad of [0, 9]) {
      let caught: unknown = undefined;
      await arena.write.setMaxActiveDuels([bad]).catch((e: unknown) => { caught = e; });
      expect(caught, `expected ${bad} to revert`).to.not.be.undefined;
      expect(String(caught)).to.include("BadMaxActiveDuels");
    }

    let caught: unknown = undefined;
    await arena.write.setMaxActiveDuels([2], { account: stranger.account })
      .catch((e: unknown) => { caught = e; });
    expect(caught, "expected a non-owner to revert").to.not.be.undefined;
  });

  it("resolving the middle of three duels leaves the other two running", async function () {
    const { arena, mockPlatform } = await deploy();

    for (let i = 0; i < 3; i++) {
      await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_3, false]);
    }
    await mineBlock();

    // Duel 2 alone plays out its three turns and finalizes.
    let nextReqId = 1n;
    for (let i = 0; i < 3; i++) {
      await runOneTurnFor(arena, mockPlatform, 2n, nextReqId);
      nextReqId += 2n;
    }
    await arena.write.finalizeDuel([2n]);

    // Swap-and-pop moves the tail into the hole, so order changes but membership
    // must not: 1 and 3 are still running, 2 is gone.
    const ids = (await arena.read.getActiveDuelIds() as bigint[]).slice().sort();
    expect(ids).to.deep.equal([1n, 3n]);
    expect(await arena.read.hasCapacity()).to.equal(true);

    const d1 = await arena.read.duels([1n]) as unknown[];
    const d3 = await arena.read.duels([3n]) as unknown[];
    expect(Number(d1[D.status])).to.equal(DuelStatus.Active);
    expect(Number(d3[D.status])).to.equal(DuelStatus.Active);
    expect(Number(d1[D.completedCallbacks])).to.equal(0, "duel 1 never advanced");
  });

  it("two duels advance independently via turn(id)", async function () {
    const { arena, mockPlatform } = await deploy();

    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_3, false]);
    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_3, false]);
    await mineBlock();

    await runOneTurnFor(arena, mockPlatform, 1n, 1n);
    const a1 = await arena.read.duels([1n]) as unknown[];
    const b1 = await arena.read.duels([2n]) as unknown[];
    expect(Number(a1[D.completedCallbacks])).to.equal(2);
    expect(Number(b1[D.completedCallbacks])).to.equal(0, "duel 2 must not move");

    await runOneTurnFor(arena, mockPlatform, 2n, 3n);
    const b2 = await arena.read.duels([2n]) as unknown[];
    expect(Number(b2[D.completedCallbacks])).to.equal(2);

    // duelsReadyForTurn reports both once their intervals reopen.
    await mineBlock();
    const ready = (await arena.read.duelsReadyForTurn() as bigint[]).slice().sort();
    expect(ready).to.deep.equal([1n, 2n]);
  });

  it("DuelNotReadyToFinalize reverts when finalizing with 0 callbacks", async function () {
    const { arena } = await deploy();

    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_3, false]);
    const duelId = await arena.read.activeDuelId() as bigint;

    let caught: unknown = undefined;
    await arena.write.finalizeDuel([duelId]).catch((e: unknown) => { caught = e; });

    expect(caught, "expected DuelNotReadyToFinalize revert").to.not.be.undefined;
    expect(String(caught)).to.include("DuelNotReadyToFinalize");
  });

  it("turn() is idempotent — calling twice in the same block does not double-fire", async function () {
    const { arena } = await deploy();
    const publicClient = await hre.viem.getPublicClient();

    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_3, false]);
    await mineBlock();

    await hre.network.provider.send("evm_setAutomine", [false]);
    try {
      const tx1 = await arena.write.turn([1n]);
      const tx2 = await arena.write.turn([1n]);
      await hre.network.provider.send("evm_mine", []);

      const r1 = await publicClient.getTransactionReceipt({ hash: tx1 });
      const r2 = await publicClient.getTransactionReceipt({ hash: tx2 });

      const reqEvents1 = r1.logs.filter((l) => l.topics.length === 4);
      const reqEvents2 = r2.logs.filter((l) => l.topics.length === 4);
      expect(reqEvents1.length).to.equal(2, "first turn should emit 2 FighterMoveRequested");
      expect(reqEvents2.length).to.equal(0, "second turn in same block should emit nothing");
    } finally {
      await hre.network.provider.send("evm_setAutomine", [true]);
    }
  });

  it("fighterA == fighterB reverts InvalidFighterPair", async function () {
    const { arena } = await deploy();

    let caught: unknown = undefined;
    await arena.write.startDuel([FIGHTER_A, FIGHTER_A, TURNS_3, false]).catch((e: unknown) => { caught = e; });

    expect(caught, "expected InvalidFighterPair revert").to.not.be.undefined;
    expect(String(caught)).to.include("InvalidFighterPair");
  });

  it("invalid turn count reverts InvalidTurnCount", async function () {
    const { arena } = await deploy();

    let caught: unknown = undefined;
    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, 7, false]).catch((e: unknown) => { caught = e; });

    expect(caught, "expected InvalidTurnCount revert").to.not.be.undefined;
    expect(String(caught)).to.include("InvalidTurnCount");
  });

  it("expireTurn unblocks finalize after a missed callback", async function () {
    const { arena, mockPlatform, poolWeth } = await deploy();
    const publicClient = await hre.viem.getPublicClient();

    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_15, false]);
    const duelId = await arena.read.activeDuelId() as bigint;

    await mineBlock();

    for (let i = 0; i < 14; i++) {
      await runOneTurn(arena, mockPlatform, BigInt(i * 2 + 1));
    }

    const tx15 = await arena.write.turn([duelId]);
    const receipt15 = await publicClient.getTransactionReceipt({ hash: tx15 });
    const requestIds15: bigint[] = [];
    for (const log of receipt15.logs) {
      if (log.topics.length === 4) requestIds15.push(BigInt(log.topics[3]!));
    }
    expect(requestIds15.length).to.equal(2);
    const [reqIdA15, reqIdB15] = requestIds15;

    await mineBlock();

    await mockPlatform.write.dispatchSuccess([arena.address, reqIdA15, HANDLE_SELECTOR, 0n]);

    const stateBeforeExpiry = await arena.read.duels([duelId]) as unknown[];
    expect(stateBeforeExpiry[D.completedCallbacks]).to.equal(29);

    let caught: unknown = undefined;
    await arena.write.finalizeDuel([duelId]).catch((e: unknown) => { caught = e; });
    expect(caught, "expected DuelNotReadyToFinalize").to.not.be.undefined;
    expect(String(caught)).to.include("DuelNotReadyToFinalize");

    const pendingTurn = await arena.read.pendingTurns([reqIdB15]) as unknown[];
    const deadline = pendingTurn[2] as bigint;
    await hre.network.provider.send("evm_setNextBlockTimestamp", [
      "0x" + (deadline + 1n).toString(16),
    ]);
    await mineBlock();

    await arena.write.expireTurn([reqIdB15]);

    const stateAfterExpiry = await arena.read.duels([duelId]) as unknown[];
    expect(stateAfterExpiry[D.completedCallbacks]).to.equal(30);

    await poolWeth.write.setMarkPrice([2000n * 10n ** 18n]);
    const finalizeTx = await arena.write.finalizeDuel([duelId]);
    const finalizeReceipt = await publicClient.getTransactionReceipt({ hash: finalizeTx });
    expect(finalizeReceipt.status).to.equal("success");

    const finalState = await arena.read.duels([duelId]) as unknown[];
    expect(finalState[D.status]).to.equal(DuelStatus.Resolved);
  });

  it("startDuel reverts ZeroAmount when deposit results in zero per-fighter", async function () {
    // minDepositFor returns 0 on local hardhat (no book data) → pot = PLATFORM_FEE only
    // pot / 2 = 0.5 USDso → non-zero, so ZeroAmount won't trigger from that path.
    // We can test InvalidTurnCount as the gate instead.
    const { arena } = await deploy();

    let caught: unknown = undefined;
    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, 0, false]).catch((e: unknown) => { caught = e; });

    expect(caught, "expected InvalidTurnCount revert").to.not.be.undefined;
    expect(String(caught)).to.include("InvalidTurnCount");
  });

  // Previously named "non-tie case", but both fighters played identically, so it
  // was a tie that only looked decisive because `valueA >= valueB` broke it.
  it("two fighters that both sit out end level, not with a slot-A win", async function () {
    const { arena, mockPlatform, poolWeth } = await deploy();
    const publicClient = await hre.viem.getPublicClient();

    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_15, false]);
    const duelId = await arena.read.activeDuelId() as bigint;

    await mineBlock();

    for (let i = 0; i < 15; i++) {
      await runOneTurn(arena, mockPlatform, BigInt(i * 2 + 1));
    }

    await poolWeth.write.setMarkPrice([0n]);

    const tx = await arena.write.finalizeDuel([duelId]);
    const receipt = await publicClient.getTransactionReceipt({ hash: tx });

    const resolvedLog = receipt.logs.find((l) => l.topics[0] === DUEL_RESOLVED_SIG);
    expect(resolvedLog).to.not.be.undefined;
    expect(parseInt(resolvedLog!.topics[2]!, 16)).to.equal(255, "identical play is a draw");

    const state = await arena.read.duels([duelId]) as unknown[];
    expect(Number(state[11])).to.equal(2, "winnerSlot should be the draw sentinel");
  });

  // The draw path must not swallow genuine wins: when one fighter actually gets
  // ahead, that fighter still wins outright.
  it("a fighter that trades into a gain wins outright", async function () {
    const { arena, mockPlatform, poolSomi } = await deploy(true);
    const publicClient = await hre.viem.getPublicClient();

    // A buy is only sized if the Arena's own vault balance in the pool covers one
    // lot, so the pools have to hold seed liquidity before anyone can trade.
    await arena.write.fundPools([parseEther("1000")]);

    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_3, false]);
    const duelId = await arena.read.activeDuelId() as bigint;
    await mineBlock();

    // Turn one: A buys SOMI, B holds. Their balances now differ.
    const tx = await arena.write.turn([duelId]);
    const receipt = await publicClient.getTransactionReceipt({ hash: tx });
    const reqIds = receipt.logs.filter((l) => l.topics.length === 4).map((l) => BigInt(l.topics[3]!));
    expect(reqIds.length).to.equal(2, "expected a request per fighter");
    await mineBlock();

    await mockPlatform.write.dispatchSuccessString([arena.address, reqIds[0], HANDLE_SELECTOR, "BuySOMI"]);
    await mockPlatform.write.dispatchSuccessString([arena.address, reqIds[1], HANDLE_SELECTOR, "Hold"]);

    const [, allowedAfter] = await arena.read.previewTurnPrompt([duelId, FIGHTER_A]) as [string, string[]];
    expect(allowedAfter).to.include("SellSOMI", "holding SOMI, A may now sell it");

    for (let i = 1; i < 3; i++) await runOneTurn(arena, mockPlatform, reqIds[1] + BigInt(i * 2 - 1));

    // SOMI doubles, so A's base is worth more than the cash B never spent.
    await poolSomi.write.setMarkPrice([200n * 10n ** 18n]);
    await poolSomi.write.setBookLevel([true, 200n * 10n ** 18n, 10n ** 18n]);
    await poolSomi.write.setBookLevel([false, 200n * 10n ** 18n, 10n ** 18n]);

    const finTx = await arena.write.finalizeDuel([duelId]);
    const finRc = await publicClient.getTransactionReceipt({ hash: finTx });

    const resolved = finRc.logs.find((l) => l.topics[0] === DUEL_RESOLVED_SIG);
    expect(parseInt(resolved!.topics[2]!, 16)).to.equal(FIGHTER_A, "A traded into a lead and should win");
    expect(finRc.logs.find((l) => l.topics[0] === DUEL_DRAWN_SIG), "not a draw").to.be.undefined;
  });
});
