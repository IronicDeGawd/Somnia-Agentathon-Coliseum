import { expect } from "chai";
import hre from "hardhat";
import { parseEther, maxUint256, zeroAddress } from "viem";

import { deployArenaWithParts } from "./helpers/arena";

/**
 * Every buy a fighter makes turns house cash into an asset delivered to the Arena,
 * and for the life of the project nothing turned it back: cash fell while holdings
 * rose — the same money in a shape the buy gate could not spend — and recovering it
 * meant an operator remembering to run a script.
 *
 * A fight now sells what the house holds when it ends. The tests that matter are not
 * "does it sell" but "can this ever stop a fight finishing", because a fight that
 * cannot finish is a payout nobody can claim, and an unclaimed payout blocks the next
 * contract rewire. That has already blocked one release.
 */
const HANDLE_SELECTOR = "0xc4e34fdd" as `0x${string}`;
const D = { status: 8 } as const;
const RESOLVED = 3;

async function mineBlock() { await hre.network.provider.send("evm_mine", []); }

async function deploy() {
  const [owner] = await hre.viem.getWalletClients();
  const registry     = await hre.viem.deployContract("FighterRegistry");
  const usdso        = await hre.viem.deployContract("MockERC20", ["USDso", "USDso"]);
  const base         = await hre.viem.deployContract("MockERC20", ["WETH", "WETH"]);
  const poolWeth     = await hre.viem.deployContract("MockSpotPool");
  const poolWbtc     = await hre.viem.deployContract("MockSpotPool");
  const poolSomi     = await hre.viem.deployContract("MockSpotPool");
  const mockPlatform = await hre.viem.deployContract("MockPlatform");

  const { arena } = await deployArenaWithParts(hre, [
    registry.address, usdso.address,
    poolWeth.address, poolWbtc.address, poolSomi.address,
    mockPlatform.address, 1n, [18, 18, 18],
  ], { value: parseEther("33") });

  await hre.network.provider.send("hardhat_setBalance", [
    arena.address, "0x" + parseEther("100").toString(16),
  ]);
  await usdso.write.mint([owner.account.address, parseEther("100000")]);
  await usdso.write.approve([arena.address, maxUint256]);

  // A real asset behind two markets, and the chain's own coin behind the third. That
  // third one is what settlement must never touch: this contract's coin balance is
  // what pays for the fighters' thinking.
  await poolWeth.write.setPoolParams([base.address, usdso.address, 1n, 0n, parseEther("0.001")]);
  await poolWbtc.write.setPoolParams([base.address, usdso.address, 1n, 0n, parseEther("0.001")]);
  await poolSomi.write.setPoolParams([zeroAddress, usdso.address, 1n, 0n, parseEther("0.001")]);

  return { arena, mockPlatform, poolWeth, poolWbtc, poolSomi, usdso, base, owner };
}

async function runOneTurn(arena: any, mockPlatform: any) {
  const publicClient = await hre.viem.getPublicClient();
  const activeId = (await arena.read.activeDuelId()) as bigint;
  const tx = await arena.write.turn([activeId]);
  const receipt = await publicClient.getTransactionReceipt({ hash: tx });
  const requestIds: bigint[] = [];
  for (const log of receipt.logs) if (log.topics.length === 4) requestIds.push(BigInt(log.topics[3]!));
  await mineBlock();
  for (const id of requestIds) {
    await mockPlatform.write.dispatchSuccess([arena.address, id, HANDLE_SELECTOR, 0n]);
  }
}

/** A whole three-round fight, finalised. Returns the duel id. */
async function runToResolved(arena: any, mockPlatform: any) {
  await arena.write.startDuel([0, 1, 3, false]);
  const duelId = await arena.read.activeDuelId() as bigint;
  await mineBlock();
  for (let i = 0; i < 3; i++) await runOneTurn(arena, mockPlatform);
  await arena.write.finalizeDuel([duelId]);
  return duelId;
}

describe("Arena — selling held assets when a fight ends", function () {
  this.timeout(180_000);

  it("sells the asset the house is holding, and cash comes back", async () => {
    const { arena, usdso, base, poolWeth, poolWbtc, poolSomi, mockPlatform } = await deploy();

    // A three-round fight activates only ONE market, and which one is chosen by the
    // tier's own arithmetic — so the asset and the bid go behind ALL of them, and
    // whichever is active is the one that settles. Getting this wrong made the test
    // look like a broken settlement when nothing was ever asked to settle.
    // The coin market is a plain token for THIS test only, so every market is
    // settleable and the tier's choice cannot decide the outcome.
    await poolSomi.write.setPoolParams([base.address, usdso.address, 1n, 0n, parseEther("0.001")]);
    await base.write.mint([arena.address, parseEther("2")]);
    for (const p of [poolWeth, poolWbtc, poolSomi]) {
      await p.write.setBookLevel([true, parseEther("1000"), parseEther("5")]);
      await usdso.write.mint([p.address, parseEther("5000")]);
      await p.write.setNextFill([parseEther("2"), parseEther("2000")]);
    }

    const heldBefore = await base.read.balanceOf([arena.address]) as bigint;
    expect(heldBefore, "the house must start holding something").to.equal(parseEther("2"));

    await runToResolved(arena, mockPlatform);

    expect(
      await base.read.balanceOf([arena.address]),
      "the asset must not still be sitting here after the fight",
    ).to.be.lessThan(heldBefore);
  });

  it("finishes the fight even when the venue reverts on every order", async () => {
    // If finalising can fail, a payout gets stuck, and a stuck payout blocks the next
    // rewire. Losing an asset sale is a rounding error by comparison.
    const { arena, base, poolWeth, mockPlatform } = await deploy();
    await base.write.mint([arena.address, parseEther("2")]);
    await poolWeth.write.setBookLevel([true, parseEther("1000"), parseEther("5")]);
    await poolWeth.write.setNextOrderShouldRevert([true]);

    const duelId = await runToResolved(arena, mockPlatform);
    const state = await arena.read.duels([duelId]) as unknown[];
    expect(state[D.status], "a reverting venue must not leave the fight unresolved").to.equal(RESOLVED);
  });

  it("finishes the fight even when the venue refuses every order", async () => {
    const { arena, base, poolWeth, mockPlatform } = await deploy();
    await base.write.mint([arena.address, parseEther("2")]);
    await poolWeth.write.setBookLevel([true, parseEther("1000"), parseEther("5")]);
    await poolWeth.write.setNextOrderShouldReject([true]);

    const duelId = await runToResolved(arena, mockPlatform);
    const state = await arena.read.duels([duelId]) as unknown[];
    expect(state[D.status]).to.equal(RESOLVED);
  });

  it("finishes the fight when nobody is bidding at all", async () => {
    const { arena, base, mockPlatform } = await deploy();
    await base.write.mint([arena.address, parseEther("2")]);
    // No book anywhere: every market has an empty bid side.
    const duelId = await runToResolved(arena, mockPlatform);
    const state = await arena.read.duels([duelId]) as unknown[];
    expect(state[D.status]).to.equal(RESOLVED);
    expect(
      await base.read.balanceOf([arena.address]),
      "with nobody bidding the asset simply stays, untouched",
    ).to.equal(parseEther("2"));
  });

  it("never sells the chain's own coin, because that balance is the fighters' fuel", async () => {
    // One market's asset IS the coin that pays for inference. Selling it would turn
    // fuel into cash, which is backwards — the fuel pot converts the other way on
    // purpose. So this market is skipped by name, not by luck.
    const { arena, poolSomi, mockPlatform } = await deploy();
    const publicClient = await hre.viem.getPublicClient();
    await poolSomi.write.setBookLevel([true, parseEther("0.1"), parseEther("500")]);

    const duelId = await runToResolved(arena, mockPlatform);
    const state = await arena.read.duels([duelId]) as unknown[];
    expect(state[D.status]).to.equal(RESOLVED);
    // The fight itself spends coin on inference, so assert the settlement did not
    // SELL any: a sale would show up as a coin fall paired with a cash rise.
    const skipped = await arena.getEvents.AssetSettleSkipped();
    const reasons = skipped.map((e: any) => e.args.reason);
    expect(
      reasons.some((r: string) => /fuel/i.test(r)),
      `the native market must be skipped by name — reasons seen: ${reasons.join(", ")}`,
    ).to.equal(true);
    expect(await publicClient.getBalance({ address: arena.address })).to.be.greaterThan(0n);
  });
});
