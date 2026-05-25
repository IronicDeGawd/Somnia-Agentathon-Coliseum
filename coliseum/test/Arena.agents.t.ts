import { expect } from "chai";
import hre from "hardhat";
import { parseEther, encodeFunctionData } from "viem";

// ResponseStatus enum from ISomniaAgents.sol
const RS = {
  None: 0,
  Pending: 1,
  Success: 2,
  Failed: 3,
  TimedOut: 4,
} as const;

// Precomputed: cast keccak 'handleFighterResponse(...)' | cut -c1-10
const HANDLE_SELECTOR = "0xc4e34fdd" as `0x${string}`;

const EMPTY_REQUEST = {
  id: 0n,
  requester: "0x0000000000000000000000000000000000000000" as `0x${string}`,
  callbackAddress: "0x0000000000000000000000000000000000000000" as `0x${string}`,
  callbackSelector: "0x00000000" as `0x${string}`,
  subcommittee: [] as `0x${string}`[],
  responses: [] as never[],
  responseCount: 0n,
  failureCount: 0n,
  threshold: 0n,
  createdAt: 0n,
  deadline: 0n,
  status: RS.None,
  consensusType: 0,
  remainingBudget: 0n,
  perAgentBudget: 0n,
};

describe("Arena — Somnia Agents integration", function () {
  const DUEL_ID = 42n;
  const FIGHTER_ID = 0;

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
      1n,
    ], { value: parseEther("33") });

    // Fund arena with enough STT for agent deposits (floor 0.03 + topup 0.21 = 0.24; 33 already set via constructor)
    await hre.network.provider.send("hardhat_setBalance", [
      arena.address,
      "0x" + parseEther("34").toString(16),
    ]);

    return { arena, mockPlatform, registry, owner };
  }

  it("testRequestFighterMove emits FighterMoveRequested and stores pendingTurn", async function () {
    const { arena } = await deploy();
    const publicClient = await hre.viem.getPublicClient();

    const tx = await arena.write.testRequestFighterMove([DUEL_ID, FIGHTER_ID]);
    const receipt = await publicClient.getTransactionReceipt({ hash: tx });
    expect(receipt.status).to.equal("success");
    expect(receipt.logs.length).to.be.greaterThan(0);

    // MockPlatform returns requestId=1 on first createRequest call
    const requestId = 1n;
    const turn = await arena.read.pendingTurns([requestId]) as [bigint, number, bigint, boolean];
    expect(turn[3]).to.equal(true, "pendingTurn.exists should be true");
    expect(turn[0]).to.equal(DUEL_ID);
    expect(turn[1]).to.equal(FIGHTER_ID);
  });

  it("dispatchSuccess BuyWBTC (action=1) clears pendingTurn and emits FighterMove", async function () {
    const { arena, mockPlatform } = await deploy();
    const publicClient = await hre.viem.getPublicClient();

    await arena.write.testRequestFighterMove([DUEL_ID, FIGHTER_ID]);
    const requestId = 1n;

    const tx = await mockPlatform.write.dispatchSuccess([
      arena.address,
      requestId,
      HANDLE_SELECTOR,
      1n, // BuyWBTC
    ]);
    const receipt = await publicClient.getTransactionReceipt({ hash: tx });
    expect(receipt.status).to.equal("success");

    // pendingTurn should be cleared
    const turn = await arena.read.pendingTurns([requestId]) as [bigint, number, bigint, boolean];
    expect(turn[3]).to.equal(false, "pendingTurn should be deleted after dispatch");
  });

  it("dispatchFailure emits clears pendingTurn (no consensus path)", async function () {
    const { arena, mockPlatform } = await deploy();
    const publicClient = await hre.viem.getPublicClient();

    await arena.write.testRequestFighterMove([DUEL_ID, FIGHTER_ID]);
    const requestId = 1n;

    const tx = await mockPlatform.write.dispatchFailure([
      arena.address,
      requestId,
      HANDLE_SELECTOR,
      RS.Failed,
    ]);
    const receipt = await publicClient.getTransactionReceipt({ hash: tx });
    expect(receipt.status).to.equal("success");

    const turn = await arena.read.pendingTurns([requestId]) as [bigint, number, bigint, boolean];
    expect(turn[3]).to.equal(false, "pendingTurn cleared even on failure");
  });

  it("handleFighterResponse reverts OnlyPlatform when called by non-platform", async function () {
    const { arena } = await deploy();

    let caught: unknown = undefined;
    await arena.write.handleFighterResponse([
      0n,
      [],
      RS.Success,
      EMPTY_REQUEST,
    ]).catch((err: unknown) => { caught = err; });

    expect(caught, "expected OnlyPlatform revert").to.not.be.undefined;
    // Check for "OnlyPlatform" name or its 4-byte selector
    const s = String(caught);
    expect(s.includes("OnlyPlatform") || s.includes("unrecognized"), "expected OnlyPlatform error").to.be.true;
  });

  it("handleFighterResponse emits FighterMoveFailed for unknown requestId (no revert)", async function () {
    const { arena, mockPlatform } = await deploy();
    const publicClient = await hre.viem.getPublicClient();

    // requestId 9999 was never registered — should succeed (emit + return, not revert)
    const tx = await mockPlatform.write.dispatchSuccess([
      arena.address,
      9999n,
      HANDLE_SELECTOR,
      0n,
    ]);
    const receipt = await publicClient.getTransactionReceipt({ hash: tx });
    expect(receipt.status).to.equal("success");
  });

  it("expireTurn after deadline emits FighterMoveFailed reason timed out", async function () {
    const { arena } = await deploy();
    const publicClient = await hre.viem.getPublicClient();

    await arena.write.testRequestFighterMove([DUEL_ID, FIGHTER_ID]);
    const requestId = 1n;

    // Fast-forward past the 15-minute deadline
    await hre.network.provider.send("evm_increaseTime", [15 * 60 + 1]);
    await hre.network.provider.send("evm_mine", []);

    const tx = await arena.write.expireTurn([requestId]);
    const receipt = await publicClient.getTransactionReceipt({ hash: tx });
    expect(receipt.status).to.equal("success");

    const turn = await arena.read.pendingTurns([requestId]) as [bigint, number, bigint, boolean];
    expect(turn[3]).to.equal(false, "pendingTurn should be deleted after expireTurn");
  });

  it("out-of-range raw result (99) clears pendingTurn without revert", async function () {
    const { arena, mockPlatform } = await deploy();
    const publicClient = await hre.viem.getPublicClient();

    await arena.write.testRequestFighterMove([DUEL_ID, FIGHTER_ID]);
    const requestId = 1n;

    const tx = await mockPlatform.write.dispatchSuccessWithRaw([
      arena.address,
      requestId,
      HANDLE_SELECTOR,
      99n, // out of range [0,6]
    ]);
    const receipt = await publicClient.getTransactionReceipt({ hash: tx });
    expect(receipt.status).to.equal("success");

    const turn = await arena.read.pendingTurns([requestId]) as [bigint, number, bigint, boolean];
    expect(turn[3]).to.equal(false, "pendingTurn cleared even for out-of-range result");
  });
});
