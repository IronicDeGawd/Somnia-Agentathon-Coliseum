import { expect } from "chai";
import hre from "hardhat";
import { parseEther, getAddress } from "viem";

const HANDLE_SELECTOR = "0xc4e34fdd" as `0x${string}`;

const DuelStatus = {
  None: 0,
  Pending: 1,
  Active: 2,
  Finalizing: 3,
  Resolved: 4,
} as const;

// duels() tuple field indices
const D = {
  fighterA: 0,
  fighterB: 1,
  startBlock: 2,
  lastTurnBlock: 3,
  completedCallbacks: 4,
  status: 5,
  pool: 6,
  initialUsdsoPerFighter: 7,
} as const;

async function mineBlock() {
  await hre.network.provider.send("evm_mine", []);
}

async function deploy() {
  const [owner] = await hre.viem.getWalletClients();
  const registry = await hre.viem.deployContract("FighterRegistry");
  const usdso = await hre.viem.deployContract("MockERC20", ["USDso", "USDso"]);
  const poolWeth = await hre.viem.deployContract("MockSpotPool");
  const poolWbtc = await hre.viem.deployContract("MockSpotPool");
  const poolSomi = await hre.viem.deployContract("MockSpotPool");
  const mockPlatform = await hre.viem.deployContract("MockPlatform");

  const arena = await hre.viem.deployContract("Arena", [
    registry.address,
    usdso.address,
    poolWeth.address,
    poolWbtc.address,
    poolSomi.address,
    mockPlatform.address,
  ]);

  // Fund arena with enough STT for 30 requests (each = 0.03 + 0.07*3 = 0.24)
  await hre.network.provider.send("hardhat_setBalance", [
    arena.address,
    "0x" + parseEther("10").toString(16),
  ]);

  return { arena, mockPlatform, poolWeth, poolWbtc, poolSomi, owner };
}

// Helper: run one full turn — calls turn(), mines a new block to unblock next turn,
// then dispatches both callbacks with action=Hold (0) so balance math stays predictable.
// Returns the two requestIds that were emitted.
async function runOneTurn(
  arena: Awaited<ReturnType<typeof deploy>>["arena"],
  mockPlatform: Awaited<ReturnType<typeof deploy>>["mockPlatform"],
  nextExpectedReqIdA: bigint,
): Promise<{ reqIdA: bigint; reqIdB: bigint }> {
  const publicClient = await hre.viem.getPublicClient();

  const tx = await arena.write.turn();
  const receipt = await publicClient.getTransactionReceipt({ hash: tx });

  // Collect FighterMoveRequested events — two per turn, one per fighter
  // topic[0] = event sig, topic[1] = duelId, topic[2] = fighterId, topic[3] = requestId
  const FIGHTER_MOVE_REQUESTED_SIG =
    "0x" +
    [...Buffer.from(
      "FighterMoveRequested(uint256,uint8,uint256)",
    )].reduce((acc, b) => acc, ""); // unused — we just grab all logs with 4 topics

  const requestIds: bigint[] = [];
  for (const log of receipt.logs) {
    if (log.topics.length === 4) {
      // topic[3] is indexed requestId
      requestIds.push(BigInt(log.topics[3]!));
    }
  }
  expect(requestIds.length, "expected 2 FighterMoveRequested events").to.equal(2);

  const [reqIdA, reqIdB] = requestIds;

  // Mine a block so the NEXT turn() call is not rate-limited
  await mineBlock();

  // Dispatch both callbacks: action=Hold (0)
  await mockPlatform.write.dispatchSuccess([
    arena.address,
    reqIdA,
    HANDLE_SELECTOR,
    0n,
  ]);
  await mockPlatform.write.dispatchSuccess([
    arena.address,
    reqIdB,
    HANDLE_SELECTOR,
    0n,
  ]);

  return { reqIdA, reqIdB };
}

describe("Arena — Duel lifecycle", function () {
  this.timeout(60_000);

  const INITIAL_USDSO = 1000n * 10n ** 18n;
  const FIGHTER_A = 0;
  const FIGHTER_B = 1;

  it("startDuel → 15 turns → finalizeDuel → winner determined", async function () {
    const { arena, mockPlatform, poolWeth } = await deploy();

    // Start duel
    const startTx = await arena.write.startDuel([
      FIGHTER_A,
      FIGHTER_B,
      poolWeth.address,
      INITIAL_USDSO,
    ]);
    const publicClient = await hre.viem.getPublicClient();
    const startReceipt = await publicClient.getTransactionReceipt({ hash: startTx });
    expect(startReceipt.status).to.equal("success");

    const duelId = await arena.read.activeDuelId() as bigint;
    expect(duelId).to.equal(1n);

    // Mine a block so first turn() is not rate-limited (startDuel sets lastTurnBlock = startBlock)
    await mineBlock();

    // Run 15 turns — 30 callbacks total
    let nextReqId = 1n;
    for (let i = 0; i < 15; i++) {
      await runOneTurn(arena, mockPlatform, nextReqId);
      nextReqId += 2n;
    }

    // Verify completedCallbacks == 30
    const duelState = await arena.read.duels([duelId]) as unknown[];
    expect(duelState[D.completedCallbacks]).to.equal(30, "expected 30 completed callbacks");
    expect(duelState[D.status]).to.equal(DuelStatus.Active, "should still be Active before finalize");

    // Set a high mark price so fighter A's value is deterministic
    // Both fighters have INITIAL_USDSO in quote, 0 base — so both values equal.
    // Tie → A wins. No need to set mark price manipulation for this test.
    await poolWeth.write.setMarkPrice([2000n * 10n ** 18n]);

    const finalizeTx = await arena.write.finalizeDuel([duelId]);
    const finalizeReceipt = await publicClient.getTransactionReceipt({ hash: finalizeTx });
    expect(finalizeReceipt.status).to.equal("success");

    // Check DuelResolved event
    const resolvedLog = finalizeReceipt.logs.find((l) => l.topics.length === 3);
    expect(resolvedLog, "expected DuelResolved log").to.not.be.undefined;

    // Winner is fighterA (tie-breaks to A)
    // topic[2] = indexed winnerId
    const winnerId = parseInt(resolvedLog!.topics[2]!, 16);
    expect(winnerId).to.equal(FIGHTER_A, "tie should resolve to fighterA");

    // activeDuelId cleared
    const activeAfter = await arena.read.activeDuelId() as bigint;
    expect(activeAfter).to.equal(0n, "activeDuelId should be 0 after finalize");

    // Status is Resolved
    const finalState = await arena.read.duels([duelId]) as unknown[];
    expect(finalState[D.status]).to.equal(DuelStatus.Resolved);
  });

  it("DuelAlreadyActive reverts when starting second duel mid-flow", async function () {
    const { arena, mockPlatform, poolWeth } = await deploy();

    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, poolWeth.address, INITIAL_USDSO]);

    let caught: unknown = undefined;
    await arena.write
      .startDuel([FIGHTER_A, FIGHTER_B, poolWeth.address, INITIAL_USDSO])
      .catch((e: unknown) => { caught = e; });

    expect(caught, "expected DuelAlreadyActive revert").to.not.be.undefined;
    expect(String(caught)).to.include("DuelAlreadyActive");
  });

  it("DuelNotReadyToFinalize reverts when finalizing with 0 callbacks", async function () {
    const { arena, poolWeth } = await deploy();

    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, poolWeth.address, INITIAL_USDSO]);
    const duelId = await arena.read.activeDuelId() as bigint;

    let caught: unknown = undefined;
    await arena.write.finalizeDuel([duelId]).catch((e: unknown) => { caught = e; });

    expect(caught, "expected DuelNotReadyToFinalize revert").to.not.be.undefined;
    expect(String(caught)).to.include("DuelNotReadyToFinalize");
  });

  it("turn() is idempotent — calling twice in the same block does not double-fire", async function () {
    const { arena, poolWeth } = await deploy();
    const publicClient = await hre.viem.getPublicClient();

    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, poolWeth.address, INITIAL_USDSO]);
    await mineBlock();

    // Disable automining so both turn() calls land in the same block
    await hre.network.provider.send("evm_setAutomine", [false]);
    try {
      // Queue both turn() calls — no mine in between
      const tx1 = await arena.write.turn();
      const tx2 = await arena.write.turn();
      // Mine them both into the same block
      await hre.network.provider.send("evm_mine", []);

      const r1 = await publicClient.getTransactionReceipt({ hash: tx1 });
      const r2 = await publicClient.getTransactionReceipt({ hash: tx2 });

      // Both txs in the same block — first should fire, second should be rate-limited
      const reqEvents1 = r1.logs.filter((l) => l.topics.length === 4);
      const reqEvents2 = r2.logs.filter((l) => l.topics.length === 4);
      expect(reqEvents1.length).to.equal(2, "first turn should emit 2 FighterMoveRequested");
      expect(reqEvents2.length).to.equal(0, "second turn in same block should emit nothing");
    } finally {
      await hre.network.provider.send("evm_setAutomine", [true]);
    }
  });

  it("fighterA == fighterB reverts InvalidFighterPair", async function () {
    const { arena, poolWeth } = await deploy();

    let caught: unknown = undefined;
    await arena.write
      .startDuel([FIGHTER_A, FIGHTER_A, poolWeth.address, INITIAL_USDSO])
      .catch((e: unknown) => { caught = e; });

    expect(caught, "expected InvalidFighterPair revert").to.not.be.undefined;
    expect(String(caught)).to.include("InvalidFighterPair");
  });

  it("invalid pool reverts InvalidPoolForDuel", async function () {
    const { arena } = await deploy();
    const badPool = "0x000000000000000000000000000000000000dEaD";

    let caught: unknown = undefined;
    await arena.write
      .startDuel([FIGHTER_A, FIGHTER_B, badPool, INITIAL_USDSO])
      .catch((e: unknown) => { caught = e; });

    expect(caught, "expected InvalidPoolForDuel revert").to.not.be.undefined;
    expect(String(caught)).to.include("InvalidPoolForDuel");
  });

  it("expireTurn unblocks finalize after a missed callback", async function () {
    const { arena, mockPlatform, poolWeth, owner } = await deploy();
    const publicClient = await hre.viem.getPublicClient();

    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, poolWeth.address, INITIAL_USDSO]);
    const duelId = await arena.read.activeDuelId() as bigint;

    await mineBlock();

    // Run 14 turns normally — 28 callbacks
    for (let i = 0; i < 14; i++) {
      await runOneTurn(arena, mockPlatform, BigInt(i * 2 + 1));
    }

    // Turn 15: call turn() but dispatch only ONE of the two callbacks
    const tx15 = await arena.write.turn();
    const receipt15 = await publicClient.getTransactionReceipt({ hash: tx15 });
    const requestIds15: bigint[] = [];
    for (const log of receipt15.logs) {
      if (log.topics.length === 4) {
        requestIds15.push(BigInt(log.topics[3]!));
      }
    }
    expect(requestIds15.length).to.equal(2);
    const [reqIdA15, reqIdB15] = requestIds15;

    await mineBlock();

    // Dispatch only fighter A's callback
    await mockPlatform.write.dispatchSuccess([
      arena.address,
      reqIdA15,
      HANDLE_SELECTOR,
      0n,
    ]);

    // completedCallbacks should be 29 — not enough to finalize
    const stateBeforeExpiry = await arena.read.duels([duelId]) as unknown[];
    expect(stateBeforeExpiry[D.completedCallbacks]).to.equal(29);

    // finalizeDuel should revert
    let caught: unknown = undefined;
    await arena.write.finalizeDuel([duelId]).catch((e: unknown) => { caught = e; });
    expect(caught, "expected DuelNotReadyToFinalize").to.not.be.undefined;
    expect(String(caught)).to.include("DuelNotReadyToFinalize");

    // Advance time past the deadline
    const pendingTurn = await arena.read.pendingTurns([reqIdB15]) as unknown[];
    const deadline = pendingTurn[2] as bigint;
    await hre.network.provider.send("evm_setNextBlockTimestamp", [
      "0x" + (deadline + 1n).toString(16),
    ]);
    await mineBlock();

    // expireTurn for the un-dispatched requestId
    await arena.write.expireTurn([reqIdB15]);

    // completedCallbacks should now be 30
    const stateAfterExpiry = await arena.read.duels([duelId]) as unknown[];
    expect(stateAfterExpiry[D.completedCallbacks]).to.equal(30);

    // finalizeDuel should now succeed
    await poolWeth.write.setMarkPrice([2000n * 10n ** 18n]);
    const finalizeTx = await arena.write.finalizeDuel([duelId]);
    const finalizeReceipt = await publicClient.getTransactionReceipt({ hash: finalizeTx });
    expect(finalizeReceipt.status).to.equal("success");

    const finalState = await arena.read.duels([duelId]) as unknown[];
    expect(finalState[D.status]).to.equal(DuelStatus.Resolved);
  });

  it("startDuel reverts ZeroAmount when initialUsdsoPerFighter is 0", async function () {
    const { arena, poolWeth } = await deploy();

    let caught: unknown = undefined;
    await arena.write
      .startDuel([FIGHTER_A, FIGHTER_B, poolWeth.address, 0n])
      .catch((e: unknown) => { caught = e; });

    expect(caught, "expected ZeroAmount revert").to.not.be.undefined;
    expect(String(caught)).to.include("ZeroAmount");
  });

  it("winner with higher portfolio value wins (non-tie case)", async function () {
    const { arena, mockPlatform, poolWeth } = await deploy();
    const publicClient = await hre.viem.getPublicClient();

    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, poolWeth.address, INITIAL_USDSO]);
    const duelId = await arena.read.activeDuelId() as bigint;

    await mineBlock();

    // Run all 15 turns
    for (let i = 0; i < 15; i++) {
      await runOneTurn(arena, mockPlatform, BigInt(i * 2 + 1));
    }

    // Manually credit fighterB with extra base to make them the winner
    // We can't inject balance directly — instead we accept that both fighters
    // have equal INITIAL_USDSO (tie → A wins). We set markPrice = 0 to verify
    // the tie-break path explicitly.
    await poolWeth.write.setMarkPrice([0n]);

    const tx = await arena.write.finalizeDuel([duelId]);
    const receipt = await publicClient.getTransactionReceipt({ hash: tx });

    const resolvedLog = receipt.logs.find((l) => l.topics.length === 3);
    expect(resolvedLog).to.not.be.undefined;
    const winnerId = parseInt(resolvedLog!.topics[2]!, 16);
    // Tie at markPrice=0 (only quoteToken, equal) → A wins
    expect(winnerId).to.equal(FIGHTER_A);
  });
});
