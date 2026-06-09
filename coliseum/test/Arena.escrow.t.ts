import { expect } from "chai";
import hre from "hardhat";
import { parseEther, maxUint256 } from "viem";

const HANDLE_SELECTOR = "0xc4e34fdd" as `0x${string}`;

const DuelStatus = { Active: 1, Finalizing: 2, Resolved: 3 } as const;
const D = { completedCallbacks: 5, status: 8, fundsRecovered: 10 } as const;

async function mineBlock() {
  await hre.network.provider.send("evm_mine", []);
}

async function deploy() {
  const [owner] = await hre.viem.getWalletClients();
  const registry     = await hre.viem.deployContract("FighterRegistry");
  const usdso        = await hre.viem.deployContract("MockERC20", ["USDso", "USDso"]);
  const poolWeth     = await hre.viem.deployContract("MockSpotPool");
  const poolWbtc     = await hre.viem.deployContract("MockSpotPool");
  const poolSomi     = await hre.viem.deployContract("MockSpotPool");
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

  // Plenty of STT for LLM request deposits across many turns.
  await hre.network.provider.send("hardhat_setBalance", [
    arena.address,
    "0x" + parseEther("100").toString(16),
  ]);

  await usdso.write.mint([owner.account.address, parseEther("100000")]);
  await usdso.write.approve([arena.address, maxUint256]);

  return { arena, mockPlatform, poolWeth, poolWbtc, poolSomi, usdso, owner };
}

// Drive one full turn: owner turn() → 2 requests → dispatch Hold (action 0) for both.
async function runOneTurn(
  arena: Awaited<ReturnType<typeof deploy>>["arena"],
  mockPlatform: Awaited<ReturnType<typeof deploy>>["mockPlatform"],
) {
  const publicClient = await hre.viem.getPublicClient();
  const tx = await arena.write.turn();
  const receipt = await publicClient.getTransactionReceipt({ hash: tx });
  const requestIds: bigint[] = [];
  for (const log of receipt.logs) {
    if (log.topics.length === 4) requestIds.push(BigInt(log.topics[3]!));
  }
  expect(requestIds.length, "expected 2 FighterMoveRequested events").to.equal(2);
  await mineBlock();
  for (const id of requestIds) {
    await mockPlatform.write.dispatchSuccess([arena.address, id, HANDLE_SELECTOR, 0n]);
  }
}

// Run a complete 3-turn duel and finalize it. Returns the duelId.
async function runDuelToResolved(
  arena: Awaited<ReturnType<typeof deploy>>["arena"],
  mockPlatform: Awaited<ReturnType<typeof deploy>>["mockPlatform"],
  poolWeth: Awaited<ReturnType<typeof deploy>>["poolWeth"],
  fighterA: number,
  fighterB: number,
): Promise<bigint> {
  await arena.write.startDuel([fighterA, fighterB, 3, false]);
  const duelId = await arena.read.activeDuelId() as bigint;
  await mineBlock();
  for (let i = 0; i < 3; i++) await runOneTurn(arena, mockPlatform);
  await poolWeth.write.setMarkPrice([2000n * 10n ** 18n]);
  await arena.write.finalizeDuel([duelId]);
  const state = await arena.read.duels([duelId]) as unknown[];
  expect(state[D.status]).to.equal(DuelStatus.Resolved);
  return duelId;
}

describe("Arena — escrow fund custody (C-2 / H-2 / HIGH-2)", function () {
  this.timeout(120_000);

  // On local hardhat the pool book is empty, so minDepositFor → 0 → floored to
  // 2e18, making the pot exactly 2 USDso for every tier regardless of the fee.
  const POT = parseEther("2");

  it("recoverFunds pays the pot from Arena's own balance and two duels back-to-back both recover (C-2)", async function () {
    const { arena, mockPlatform, poolWeth, usdso, owner } = await deploy();
    const creator = owner.account.address;

    // --- Duel #1 ---
    const duel1 = await runDuelToResolved(arena, mockPlatform, poolWeth, 0, 1);
    const balBefore1 = await usdso.read.balanceOf([creator]) as bigint;
    await arena.write.recoverFunds([duel1]);
    const balAfter1 = await usdso.read.balanceOf([creator]) as bigint;
    expect(balAfter1 - balBefore1, "duel #1 recovers exactly its pot").to.equal(POT);

    const state1 = await arena.read.duels([duel1]) as unknown[];
    expect(state1[D.fundsRecovered]).to.equal(true);

    // --- Duel #2: previously reverted NothingToRecover because duel #1 drained
    //     the shared seed vault. With escrow custody it must recover cleanly. ---
    const duel2 = await runDuelToResolved(arena, mockPlatform, poolWeth, 2, 3);
    const balBefore2 = await usdso.read.balanceOf([creator]) as bigint;
    await arena.write.recoverFunds([duel2]);
    const balAfter2 = await usdso.read.balanceOf([creator]) as bigint;
    expect(balAfter2 - balBefore2, "duel #2 also recovers its full pot").to.equal(POT);

    expect(await arena.read.escrowedPot(), "all escrow released").to.equal(0n);
  });

  it("double recoverFunds reverts AlreadyRecovered", async function () {
    const { arena, mockPlatform, poolWeth } = await deploy();
    const duelId = await runDuelToResolved(arena, mockPlatform, poolWeth, 0, 1);
    await arena.write.recoverFunds([duelId]);

    let caught: unknown;
    await arena.write.recoverFunds([duelId]).catch((e: unknown) => { caught = e; });
    expect(caught, "expected AlreadyRecovered revert").to.not.be.undefined;
    expect(String(caught)).to.include("AlreadyRecovered");
  });

  it("withdrawFees cannot touch escrowed pot principal (HIGH-2)", async function () {
    const { arena, mockPlatform, poolWeth, usdso, owner } = await deploy();
    const to = owner.account.address;

    // Start (don't resolve) a duel so its pot is escrowed in the Arena balance.
    await arena.write.startDuel([0, 1, 3, false]);
    const fee = await arena.read.platformFee([3]) as bigint;
    expect(await arena.read.escrowedPot()).to.equal(POT);

    const balBefore = await usdso.read.balanceOf([to]) as bigint;
    await arena.write.withdrawFees([to]);
    const balAfter = await usdso.read.balanceOf([to]) as bigint;

    // Only the fee leaves the contract — the 2 USDso pot stays escrowed.
    expect(balAfter - balBefore, "only the platform fee is withdrawable").to.equal(fee);
    const arenaBal = await usdso.read.balanceOf([arena.address]) as bigint;
    expect(arenaBal, "pot principal remains in Arena").to.equal(POT);
  });

  it("a duel with fighter indexes >= 2 runs turns and finalizes without array overflow (lastAction slot)", async function () {
    const { arena, mockPlatform, poolWeth } = await deploy();
    // fighters 2 and 4 — both > the uint8[2] lastAction array bound. The old code
    // indexed lastAction by registry fighterId, which would revert here.
    const duelId = await runDuelToResolved(arena, mockPlatform, poolWeth, 2, 4);
    const state = await arena.read.duels([duelId]) as unknown[];
    expect(state[D.completedCallbacks]).to.equal(6);
    expect(state[D.status]).to.equal(DuelStatus.Resolved);
  });

  it("platformFee scales with turns: base 0.5 + 0.1 per turn", async function () {
    const { arena } = await deploy();
    expect(await arena.read.platformFee([3]))  .to.equal(parseEther("0.8"));
    expect(await arena.read.platformFee([6]))  .to.equal(parseEther("1.1"));
    expect(await arena.read.platformFee([9]))  .to.equal(parseEther("1.4"));
    expect(await arena.read.platformFee([15])) .to.equal(parseEther("2.0"));
  });
});
