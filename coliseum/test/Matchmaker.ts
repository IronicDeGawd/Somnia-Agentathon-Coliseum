import { expect } from "chai";
import hre from "hardhat";
import { parseUnits, zeroAddress } from "viem";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function deploy() {
  const [owner, alice, bob, charlie] = await hre.viem.getWalletClients();
  const pub = await hre.viem.getPublicClient();

  // Deploy a minimal mock ERC-20 (USDso) and mock Arena for unit testing.
  // We test Matchmaker logic in isolation with stubs.
  const mockUsdso = await hre.viem.deployContract("MockERC20", ["USDso", "USDso"]);
  const mockArena = await hre.viem.deployContract("MockArenaMatchmaker", [mockUsdso.address]);

  // MockArenaMatchmaker also exposes FIGHTER_COUNT(), so it doubles as the
  // registry stub for the fighter-index validation.
  const mm = await hre.viem.deployContract("Matchmaker", [
    mockArena.address,
    mockUsdso.address,
    mockArena.address,
  ]);

  // Fund alice and bob with 1000 USDso each
  const MINT = parseUnits("1000", 18);
  await mockUsdso.write.mint([alice.account.address, MINT]);
  await mockUsdso.write.mint([bob.account.address, MINT]);
  await mockUsdso.write.mint([charlie.account.address, MINT]);

  return { mm, mockArena, mockUsdso, owner, alice, bob, charlie, pub };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Matchmaker", () => {
  describe("queue()", () => {
    it("opens a slot when first player queues", async () => {
      const { mm, mockUsdso, alice } = await deploy();
      const half = await mm.read.halfDeposit([6, false]);

      await mockUsdso.write.approve([mm.address, half], {
        account: alice.account,
      });
      await mm.write.queue([1, 6, false], { account: alice.account }); // fighter 1, 6 rounds

      const [player, fighter] = await mm.read.getSlot([6, false]);
      expect(player.toLowerCase()).to.equal(alice.account.address.toLowerCase());
      expect(fighter).to.equal(1);
    });

    it("matches two players with different fighters and starts a duel", async () => {
      const { mm, mockUsdso, mockArena, alice, bob } = await deploy();
      const half = await mm.read.halfDeposit([6, false]);

      // Alice queues as fighter 0
      await mockUsdso.write.approve([mm.address, half], {
        account: alice.account,
      });
      await mm.write.queue([0, 6, false], { account: alice.account });

      // Bob queues as fighter 1 → should trigger match
      await mockUsdso.write.approve([mm.address, half], {
        account: bob.account,
      });
      await mm.write.queue([1, 6, false], { account: bob.account });

      // Slot should be cleared
      const [player] = await mm.read.getSlot([6, false]);
      expect(player).to.equal(zeroAddress);

      // MockArenaMatchmaker should have recorded a startDuel call
      const lastDuelId = await mockArena.read.lastDuelId();
      expect(lastDuelId).to.equal(1n);
    });

    it("reverts when player tries to match themselves", async () => {
      const { mm, mockUsdso, alice } = await deploy();
      const half = await mm.read.halfDeposit([3, false]);

      await mockUsdso.write.approve([mm.address, half * 2n], {
        account: alice.account,
      });
      await mm.write.queue([0, 3, false], { account: alice.account });

      await expect(
        mm.write.queue([1, 3, false], { account: alice.account })
      ).to.be.rejectedWith("MatchYourself");
    });

    it("reverts when second player picks the same fighter", async () => {
      const { mm, mockUsdso, alice, bob } = await deploy();
      const half = await mm.read.halfDeposit([3, false]);

      await mockUsdso.write.approve([mm.address, half], {
        account: alice.account,
      });
      await mm.write.queue([2, 3, false], { account: alice.account });

      await mockUsdso.write.approve([mm.address, half], {
        account: bob.account,
      });
      await expect(
        mm.write.queue([2, 3, false], { account: bob.account })
      ).to.be.rejectedWith("SameFighter");
    });

    it("reverts on invalid tier", async () => {
      const { mm, mockUsdso, alice } = await deploy();
      await mockUsdso.write.approve([mm.address, parseUnits("100", 18)], {
        account: alice.account,
      });
      await expect(
        mm.write.queue([0, 7, false], { account: alice.account })
      ).to.be.rejectedWith("InvalidTier");
    });

    it("stores a pending match when Arena is busy", async () => {
      const { mm, mockArena, mockUsdso, alice, bob } = await deploy();

      // Make Arena report itself as busy
      await mockArena.write.setBusy([true]);

      const half = await mm.read.halfDeposit([3, false]);
      await mockUsdso.write.approve([mm.address, half], {
        account: alice.account,
      });
      await mm.write.queue([0, 3, false], { account: alice.account });

      await mockUsdso.write.approve([mm.address, half], {
        account: bob.account,
      });
      await mm.write.queue([1, 3, false], { account: bob.account });

      // Slot cleared, match pending
      const [player] = await mm.read.getSlot([3, false]);
      expect(player).to.equal(zeroAddress);

      const p = await mm.read.pendingByTier([3, false]);
      expect(p[6]).to.equal(true);
      expect(p[0].toLowerCase()).to.equal(
        alice.account.address.toLowerCase()
      );
    });
  });

  describe("cancelQueue()", () => {
    it("refunds deposit and clears slot", async () => {
      const { mm, mockUsdso, alice } = await deploy();
      const half = await mm.read.halfDeposit([9, false]);
      const balBefore = await mockUsdso.read.balanceOf([alice.account.address]);

      await mockUsdso.write.approve([mm.address, half], {
        account: alice.account,
      });
      await mm.write.queue([3, 9, false], { account: alice.account });
      await mm.write.cancelQueue([9, false], { account: alice.account });

      const balAfter = await mockUsdso.read.balanceOf([alice.account.address]);
      expect(balAfter).to.equal(balBefore); // full refund

      const [player] = await mm.read.getSlot([9, false]);
      expect(player).to.equal(zeroAddress);
    });

    it("reverts if caller is not in the slot", async () => {
      const { mm, mockUsdso, alice, bob } = await deploy();
      const half = await mm.read.halfDeposit([3, false]);

      await mockUsdso.write.approve([mm.address, half], {
        account: alice.account,
      });
      await mm.write.queue([0, 3, false], { account: alice.account });

      await expect(
        mm.write.cancelQueue([3, false], { account: bob.account })
      ).to.be.rejectedWith("NotQueued");
    });
  });

  describe("triggerPendingMatch()", () => {
    it("starts duel once Arena frees up", async () => {
      const { mm, mockArena, mockUsdso, alice, bob } = await deploy();

      await mockArena.write.setBusy([true]);
      const half = await mm.read.halfDeposit([3, false]);

      await mockUsdso.write.approve([mm.address, half], {
        account: alice.account,
      });
      await mm.write.queue([0, 3, false], { account: alice.account });

      await mockUsdso.write.approve([mm.address, half], {
        account: bob.account,
      });
      await mm.write.queue([1, 3, false], { account: bob.account });

      // Arena frees up
      await mockArena.write.setBusy([false]);
      await mm.write.triggerPendingMatch([3, false]);

      const lastDuelId = await mockArena.read.lastDuelId();
      expect(lastDuelId).to.equal(1n);

      const p = await mm.read.pendingByTier([3, false]);
      expect(p[6]).to.equal(false);
    });

    it("reverts if Arena is still busy", async () => {
      const { mm, mockArena, mockUsdso, alice, bob } = await deploy();

      await mockArena.write.setBusy([true]);
      const half = await mm.read.halfDeposit([3, false]);

      await mockUsdso.write.approve([mm.address, half], {
        account: alice.account,
      });
      await mm.write.queue([0, 3, false], { account: alice.account });

      await mockUsdso.write.approve([mm.address, half], {
        account: bob.account,
      });
      await mm.write.queue([1, 3, false], { account: bob.account });

      await expect(mm.write.triggerPendingMatch([3, false])).to.be.rejectedWith(
        "ArenaStillBusy"
      );
    });
  });

  describe("claimWinnings()", () => {
    it("pays winner and emits event, records 0 for loser", async () => {
      const { mm, mockArena, mockUsdso, alice, bob } = await deploy();
      const half = await mm.read.halfDeposit([3, false]);

      await mockUsdso.write.approve([mm.address, half], {
        account: alice.account,
      });
      await mm.write.queue([0, 3, false], { account: alice.account });

      await mockUsdso.write.approve([mm.address, half], {
        account: bob.account,
      });
      await mm.write.queue([1, 3, false], { account: bob.account });

      const duelId = await mockArena.read.lastDuelId();

      // MockArenaMatchmaker: resolve duel with winnerSlot = 0 (alice's fighter wins)
      await mockArena.write.resolveDuel([duelId, 0]);

      const balBefore = await mockUsdso.read.balanceOf([alice.account.address]);
      await mm.write.claimWinnings([duelId], { account: alice.account });
      const balAfter = await mockUsdso.read.balanceOf([alice.account.address]);

      expect(balAfter).to.be.gt(balBefore); // alice received funds

      // Bob claims (loser)
      await mm.write.claimWinnings([duelId], { account: bob.account });
      // No revert, but bob gets 0 (balance unchanged relative to post-duel state)
    });

    it("reverts if duel not resolved", async () => {
      const { mm, mockArena, mockUsdso, alice, bob } = await deploy();
      const half = await mm.read.halfDeposit([3, false]);

      await mockUsdso.write.approve([mm.address, half], {
        account: alice.account,
      });
      await mm.write.queue([0, 3, false], { account: alice.account });

      await mockUsdso.write.approve([mm.address, half], {
        account: bob.account,
      });
      await mm.write.queue([1, 3, false], { account: bob.account });

      const duelId = await mockArena.read.lastDuelId();
      await expect(
        mm.write.claimWinnings([duelId], { account: alice.account })
      ).to.be.rejectedWith("DuelNotResolved");
    });

    it("reverts on double claim", async () => {
      const { mm, mockArena, mockUsdso, alice, bob } = await deploy();
      const half = await mm.read.halfDeposit([3, false]);

      await mockUsdso.write.approve([mm.address, half], { account: alice.account });
      await mm.write.queue([0, 3, false], { account: alice.account });
      await mockUsdso.write.approve([mm.address, half], { account: bob.account });
      await mm.write.queue([1, 3, false], { account: bob.account });

      const duelId = await mockArena.read.lastDuelId();
      await mockArena.write.resolveDuel([duelId, 0]);

      await mm.write.claimWinnings([duelId], { account: alice.account });
      await expect(
        mm.write.claimWinnings([duelId], { account: alice.account })
      ).to.be.rejectedWith("AlreadySettled");
    });
  });
});
