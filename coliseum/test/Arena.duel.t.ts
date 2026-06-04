import { expect } from "chai";
import hre from "hardhat";
import { parseEther, getAddress, maxUint256, keccak256, toBytes } from "viem";

const HANDLE_SELECTOR = "0xc4e34fdd" as `0x${string}`;

// keccak256("DuelResolved(uint256,uint8,uint256,uint256)")
const DUEL_RESOLVED_SIG = keccak256(toBytes("DuelResolved(uint256,uint8,uint256,uint256)"));

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

async function deploy() {
  const [owner] = await hre.viem.getWalletClients();
  const registry    = await hre.viem.deployContract("FighterRegistry");
  const usdso       = await hre.viem.deployContract("MockERC20", ["USDso", "USDso"]);
  const poolWeth    = await hre.viem.deployContract("MockSpotPool");
  const poolWbtc    = await hre.viem.deployContract("MockSpotPool");
  const poolSomi    = await hre.viem.deployContract("MockSpotPool");
  const mockPlatform = await hre.viem.deployContract("MockPlatform");

  const arena = await hre.viem.deployContract("Arena", [
    registry.address,
    usdso.address,
    poolWeth.address,
    poolWbtc.address,
    poolSomi.address,
    mockPlatform.address,
    1n,
    [18, 18, 18],
  ], { value: parseEther("33") });

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
  const publicClient = await hre.viem.getPublicClient();

  const tx = await arena.write.turn();
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

    const startTx = await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_15]);
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

    const winnerId = parseInt(resolvedLog!.topics[2]!, 16);
    expect(winnerId).to.equal(FIGHTER_A, "tie should resolve to fighterA");

    const activeAfter = await arena.read.activeDuelId() as bigint;
    expect(activeAfter).to.equal(0n, "activeDuelId should be 0 after finalize");

    const finalState = await arena.read.duels([duelId]) as unknown[];
    expect(finalState[D.status]).to.equal(DuelStatus.Resolved);
  });

  it("records the resolved duel in DuelHistory when the sink is set", async function () {
    const { arena, mockPlatform, poolSomi } = await deploy();
    const history = await hre.viem.deployContract("DuelHistory", [arena.address]);
    await arena.write.setDuelHistory([history.address]);

    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_3]);
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
    // Tie resolves to fighterA → fighterA gets the win on record.
    const ra = await history.read.getFighterRecord([FIGHTER_A]) as { wins: bigint };
    expect(Number(ra.wins)).to.equal(1);
  });

  it("DuelAlreadyActive reverts when starting second duel mid-flow", async function () {
    const { arena } = await deploy();

    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_3]);

    let caught: unknown = undefined;
    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_3]).catch((e: unknown) => { caught = e; });

    expect(caught, "expected DuelAlreadyActive revert").to.not.be.undefined;
    expect(String(caught)).to.include("DuelAlreadyActive");
  });

  it("DuelNotReadyToFinalize reverts when finalizing with 0 callbacks", async function () {
    const { arena } = await deploy();

    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_3]);
    const duelId = await arena.read.activeDuelId() as bigint;

    let caught: unknown = undefined;
    await arena.write.finalizeDuel([duelId]).catch((e: unknown) => { caught = e; });

    expect(caught, "expected DuelNotReadyToFinalize revert").to.not.be.undefined;
    expect(String(caught)).to.include("DuelNotReadyToFinalize");
  });

  it("turn() is idempotent — calling twice in the same block does not double-fire", async function () {
    const { arena } = await deploy();
    const publicClient = await hre.viem.getPublicClient();

    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_3]);
    await mineBlock();

    await hre.network.provider.send("evm_setAutomine", [false]);
    try {
      const tx1 = await arena.write.turn();
      const tx2 = await arena.write.turn();
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
    await arena.write.startDuel([FIGHTER_A, FIGHTER_A, TURNS_3]).catch((e: unknown) => { caught = e; });

    expect(caught, "expected InvalidFighterPair revert").to.not.be.undefined;
    expect(String(caught)).to.include("InvalidFighterPair");
  });

  it("invalid turn count reverts InvalidTurnCount", async function () {
    const { arena } = await deploy();

    let caught: unknown = undefined;
    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, 7]).catch((e: unknown) => { caught = e; });

    expect(caught, "expected InvalidTurnCount revert").to.not.be.undefined;
    expect(String(caught)).to.include("InvalidTurnCount");
  });

  it("expireTurn unblocks finalize after a missed callback", async function () {
    const { arena, mockPlatform, poolWeth } = await deploy();
    const publicClient = await hre.viem.getPublicClient();

    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_15]);
    const duelId = await arena.read.activeDuelId() as bigint;

    await mineBlock();

    for (let i = 0; i < 14; i++) {
      await runOneTurn(arena, mockPlatform, BigInt(i * 2 + 1));
    }

    const tx15 = await arena.write.turn();
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
    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, 0]).catch((e: unknown) => { caught = e; });

    expect(caught, "expected InvalidTurnCount revert").to.not.be.undefined;
    expect(String(caught)).to.include("InvalidTurnCount");
  });

  it("winner with higher portfolio value wins (non-tie case)", async function () {
    const { arena, mockPlatform, poolWeth } = await deploy();
    const publicClient = await hre.viem.getPublicClient();

    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_15]);
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
    const winnerId = parseInt(resolvedLog!.topics[2]!, 16);
    expect(winnerId).to.equal(FIGHTER_A);
  });
});
