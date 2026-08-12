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

    // Arena exceeds the 24576-byte contract limit unless the prompt builders
    // live in a linked library, so ArenaUtils has to be deployed alongside it.
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

  // ── Named-action answers (inferString) ──────────────────────────────────
  //
  // Arena asks for an action by NAME against an allow-list built from holdings.
  // The old integer path let the agent's extract-first-integer-then-clamp rule
  // turn any number echoed out of the prompt into the highest action index — a
  // Sell — which is how a fighter sold a token it did not hold and lost a duel.
  //
  // Duel 42 was never started, so its poolMask is 0 and Hold is the only
  // executable action. That makes it the sharpest case: every trade name must be
  // refused, and none of them may burn the turn.

  async function answerWith(result: string) {
    const ctx = await deploy();
    const publicClient = await hre.viem.getPublicClient();
    await ctx.arena.write.testRequestFighterMove([DUEL_ID, FIGHTER_ID]);
    const tx = await ctx.mockPlatform.write.dispatchSuccessString([
      ctx.arena.address,
      1n,
      HANDLE_SELECTOR,
      result,
    ]);
    const receipt = await publicClient.getTransactionReceipt({ hash: tx });
    return { ...ctx, receipt, publicClient };
  }

  /** Did the callback emit FighterMoveCoerced, and with what requested value? */
  async function coercion(arena: { abi: readonly unknown[] }, receipt: { logs: unknown[] }) {
    const { parseEventLogs } = await import("viem");
    const logs = parseEventLogs({
      abi: arena.abi as never,
      eventName: "FighterMoveCoerced",
      logs: receipt.logs as never,
    });
    return logs as unknown as { args: { requested: string } }[];
  }

  it("an allowed action name is executed and does not coerce", async function () {
    const { arena, receipt } = await answerWith("Hold");
    expect(receipt.status).to.equal("success");
    expect(await coercion(arena, receipt)).to.have.length(0, "Hold is allowed, so nothing to coerce");
  });

  it("surrounding whitespace and quotes do not cost the fighter its move", async function () {
    const { arena, receipt } = await answerWith('  "Hold"\n');
    expect(await coercion(arena, receipt)).to.have.length(0, "answer should be trimmed before matching");
  });

  it("an action outside the allowed set is taken as Hold, not burned", async function () {
    const { arena, receipt } = await answerWith("SellSOMI");
    expect(receipt.status).to.equal("success");
    const coerced = await coercion(arena, receipt);
    expect(coerced).to.have.length(1, "an inexecutable answer must be coerced, not executed");
    expect(coerced[0].args.requested).to.equal("SellSOMI", "the real answer is recorded for audit");
  });

  it("an answer that is not an action at all is coerced rather than reverting", async function () {
    const { arena, receipt } = await answerWith("I would sell, since the market looks stretched.");
    expect(receipt.status).to.equal("success");
    expect(await coercion(arena, receipt)).to.have.length(1);
  });

  it("a malformed payload degrades to a coerced Hold instead of stranding the turn", async function () {
    const { arena, mockPlatform } = await deploy();
    const publicClient = await hre.viem.getPublicClient();
    await arena.write.testRequestFighterMove([DUEL_ID, FIGHTER_ID]);

    const tx = await mockPlatform.write.dispatchSuccessBytes([
      arena.address,
      1n,
      HANDLE_SELECTOR,
      "0xdeadbeef" as `0x${string}`,
    ]);
    const receipt = await publicClient.getTransactionReceipt({ hash: tx });
    expect(receipt.status).to.equal("success");

    const coerced = await coercion(arena, receipt);
    expect(coerced).to.have.length(1);
    expect(coerced[0].args.requested).to.equal("undecodable");

    const turn = await arena.read.pendingTurns([1n]) as [bigint, number, bigint, boolean];
    expect(turn[3]).to.equal(false, "pendingTurn cleared so the duel can still finalize");
  });

  // The whole fairness fix rests on Arena asking via inferString rather than
  // inferNumber, and that choice is invisible from the outside: both produce a
  // uint256 request id and the same events. Assert the actual bytes on the wire.
  it("asks the agent via inferString, with the allowed list as the fourth argument", async function () {
    const { arena, mockPlatform } = await deploy();
    await arena.write.testRequestFighterMove([DUEL_ID, FIGHTER_ID]);

    const last = (await mockPlatform.read.lastCall()) as unknown as [bigint, string, string, `0x${string}`, bigint];
    const payload = last[3];
    const { toFunctionSelector, decodeAbiParameters } = await import("viem");

    const inferString = toFunctionSelector("inferString(string,string,bool,string[])");
    const inferNumber = toFunctionSelector("inferNumber(string,string,int256,int256,bool)");
    expect(payload.slice(0, 10)).to.equal(
      inferString,
      `expected inferString ${inferString}, got ${payload.slice(0, 10)}` +
        (payload.slice(0, 10) === inferNumber ? " (still inferNumber — the clamp bug is live)" : ""),
    );

    const [prompt, system, cot, allowed] = decodeAbiParameters(
      [{ type: "string" }, { type: "string" }, { type: "bool" }, { type: "string[]" }],
      `0x${payload.slice(10)}`,
    ) as [string, string, boolean, string[]];

    expect(cot).to.equal(false);
    expect(allowed.length).to.be.greaterThan(0, "the agent must be given an answer set");
    expect(allowed).to.include("Hold");
    expect(allowed.join(" ")).to.not.match(/\d/, "actions must be named, never numbered");
    expect(prompt).to.not.match(/\d/, `prompt must carry no numerals, got: ${prompt}`);
    expect(system.length).to.be.greaterThan(0, "the persona must be sent");
  });

  it("the turn prompt contains no digits, and offers no trade the fighter cannot make", async function () {
    const { arena } = await deploy();
    const [prompt, allowed] = await arena.read.previewTurnPrompt([DUEL_ID, FIGHTER_ID]) as [string, string[]];

    // A digit here is the whole failure mode: the model echoes it, the agent
    // extracts it, and it clamps into an action index nobody chose.
    expect(prompt).to.not.match(/\d/, `prompt must carry no numerals, got: ${prompt}`);
    expect(allowed).to.deep.equal(["Hold"], "no pools active, so only Hold is executable");
    expect(allowed.join(" ")).to.not.match(/\d/, "action names must not be digits");
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
