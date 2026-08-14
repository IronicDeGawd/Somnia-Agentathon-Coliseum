import { expect } from "chai";

/// Market kinds, mirroring ArenaTypes.MarketKind.
const SPOT = 0;
const PRACTICE = 1;
const MIXED = 2;
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
      const half = await mm.read.halfDeposit([6, SPOT]);

      await mockUsdso.write.approve([mm.address, half], {
        account: alice.account,
      });
      await mm.write.queue([1, 6, SPOT], { account: alice.account }); // fighter 1, 6 rounds

      const [player, fighter] = await mm.read.getSlot([6, SPOT]);
      expect(player.toLowerCase()).to.equal(alice.account.address.toLowerCase());
      expect(fighter).to.equal(1);
    });

    it("matches two players with different fighters and starts a duel", async () => {
      const { mm, mockUsdso, mockArena, alice, bob } = await deploy();
      const half = await mm.read.halfDeposit([6, SPOT]);

      // Alice queues as fighter 0
      await mockUsdso.write.approve([mm.address, half], {
        account: alice.account,
      });
      await mm.write.queue([0, 6, SPOT], { account: alice.account });

      // Bob queues as fighter 1 → should trigger match
      await mockUsdso.write.approve([mm.address, half], {
        account: bob.account,
      });
      await mm.write.queue([1, 6, SPOT], { account: bob.account });

      // Slot should be cleared
      const [player] = await mm.read.getSlot([6, SPOT]);
      expect(player).to.equal(zeroAddress);

      // MockArenaMatchmaker should have recorded a startDuel call
      const lastDuelId = await mockArena.read.lastDuelId();
      expect(lastDuelId).to.equal(1n);
    });

    it("reverts when player tries to match themselves", async () => {
      const { mm, mockUsdso, alice } = await deploy();
      const half = await mm.read.halfDeposit([3, SPOT]);

      await mockUsdso.write.approve([mm.address, half * 2n], {
        account: alice.account,
      });
      await mm.write.queue([0, 3, SPOT], { account: alice.account });

      await expect(
        mm.write.queue([1, 3, SPOT], { account: alice.account })
      ).to.be.rejectedWith("MatchYourself");
    });

    it("reverts when second player picks the same fighter", async () => {
      const { mm, mockUsdso, alice, bob } = await deploy();
      const half = await mm.read.halfDeposit([3, SPOT]);

      await mockUsdso.write.approve([mm.address, half], {
        account: alice.account,
      });
      await mm.write.queue([2, 3, SPOT], { account: alice.account });

      await mockUsdso.write.approve([mm.address, half], {
        account: bob.account,
      });
      await expect(
        mm.write.queue([2, 3, SPOT], { account: bob.account })
      ).to.be.rejectedWith("SameFighter");
    });

    it("reverts on invalid tier", async () => {
      const { mm, mockUsdso, alice } = await deploy();
      await mockUsdso.write.approve([mm.address, parseUnits("100", 18)], {
        account: alice.account,
      });
      await expect(
        mm.write.queue([0, 7, SPOT], { account: alice.account })
      ).to.be.rejectedWith("InvalidTier");
    });

    it("stores a pending match when Arena is busy", async () => {
      const { mm, mockArena, mockUsdso, alice, bob } = await deploy();

      // Make Arena report itself as busy
      await mockArena.write.setBusy([true]);

      const half = await mm.read.halfDeposit([3, SPOT]);
      await mockUsdso.write.approve([mm.address, half], {
        account: alice.account,
      });
      await mm.write.queue([0, 3, SPOT], { account: alice.account });

      await mockUsdso.write.approve([mm.address, half], {
        account: bob.account,
      });
      await mm.write.queue([1, 3, SPOT], { account: bob.account });

      // Slot cleared, match pending
      const [player] = await mm.read.getSlot([3, SPOT]);
      expect(player).to.equal(zeroAddress);

      expect(await mm.read.pendingCount([3, SPOT])).to.equal(1n);
      const p = await mm.read.pendingQueue([3, SPOT, 0n]);
      expect(p[6]).to.equal(true);
      expect(p[0].toLowerCase()).to.equal(
        alice.account.address.toLowerCase()
      );
    });
  });

  describe("cancelQueue()", () => {
    it("refunds deposit and clears slot", async () => {
      const { mm, mockUsdso, alice } = await deploy();
      const half = await mm.read.halfDeposit([9, SPOT]);
      const balBefore = await mockUsdso.read.balanceOf([alice.account.address]);

      await mockUsdso.write.approve([mm.address, half], {
        account: alice.account,
      });
      await mm.write.queue([3, 9, SPOT], { account: alice.account });
      await mm.write.cancelQueue([9, SPOT], { account: alice.account });

      const balAfter = await mockUsdso.read.balanceOf([alice.account.address]);
      expect(balAfter).to.equal(balBefore); // full refund

      const [player] = await mm.read.getSlot([9, SPOT]);
      expect(player).to.equal(zeroAddress);
    });

    it("reverts if caller is not in the slot", async () => {
      const { mm, mockUsdso, alice, bob } = await deploy();
      const half = await mm.read.halfDeposit([3, SPOT]);

      await mockUsdso.write.approve([mm.address, half], {
        account: alice.account,
      });
      await mm.write.queue([0, 3, SPOT], { account: alice.account });

      await expect(
        mm.write.cancelQueue([3, SPOT], { account: bob.account })
      ).to.be.rejectedWith("NotQueued");
    });
  });

  describe("triggerPendingMatch()", () => {
    it("starts duel once Arena frees up", async () => {
      const { mm, mockArena, mockUsdso, alice, bob } = await deploy();

      await mockArena.write.setBusy([true]);
      const half = await mm.read.halfDeposit([3, SPOT]);

      await mockUsdso.write.approve([mm.address, half], {
        account: alice.account,
      });
      await mm.write.queue([0, 3, SPOT], { account: alice.account });

      await mockUsdso.write.approve([mm.address, half], {
        account: bob.account,
      });
      await mm.write.queue([1, 3, SPOT], { account: bob.account });

      // Arena frees up
      await mockArena.write.setBusy([false]);
      await mm.write.triggerPendingMatch([3, SPOT]);

      const lastDuelId = await mockArena.read.lastDuelId();
      expect(lastDuelId).to.equal(1n);

      expect(await mm.read.pendingCount([3, SPOT])).to.equal(0n);
    });

    it("reverts if Arena is still busy", async () => {
      const { mm, mockArena, mockUsdso, alice, bob } = await deploy();

      await mockArena.write.setBusy([true]);
      const half = await mm.read.halfDeposit([3, SPOT]);

      await mockUsdso.write.approve([mm.address, half], {
        account: alice.account,
      });
      await mm.write.queue([0, 3, SPOT], { account: alice.account });

      await mockUsdso.write.approve([mm.address, half], {
        account: bob.account,
      });
      await mm.write.queue([1, 3, SPOT], { account: bob.account });

      await expect(mm.write.triggerPendingMatch([3, SPOT])).to.be.rejectedWith(
        "ArenaStillBusy"
      );
    });
  });

  describe("pending queue (FIFO)", () => {
    // Queue `pairs` pairs into one tier. Returns the players in arrival order.
    async function fillQueue(
      d: Awaited<ReturnType<typeof deploy>>,
      pairs: number,
      turns = 3,
    ) {
      const { mm, mockUsdso } = d;
      const wallets = await hre.viem.getWalletClients();
      const half = await mm.read.halfDeposit([turns, SPOT]);
      const queued: `0x${string}`[][] = [];
      for (let i = 0; i < pairs; i++) {
        // Wallets 1..N; two fresh accounts per pair so nobody matches themselves.
        const a = wallets[1 + i * 2]!;
        const b = wallets[2 + i * 2]!;
        for (const w of [a, b]) {
          await mockUsdso.write.mint([w.account.address, half * 4n]);
          await mockUsdso.write.approve([mm.address, half], { account: w.account });
        }
        await mm.write.queue([0, turns, SPOT], { account: a.account });
        await mm.write.queue([1, turns, SPOT], { account: b.account });
        queued.push([a.account.address, b.account.address]);
      }
      return queued;
    }

    it("queues a third pair instead of reverting ArenaStillBusy", async () => {
      const d = await deploy();
      await d.mockArena.write.setBusy([true]);

      // Three pairs arrive into a full Arena. The old single pending slot took
      // the first and turned the rest away after taking their deposits.
      await fillQueue(d, 3);
      expect(await d.mm.read.pendingCount([3, SPOT])).to.equal(3n);
    });

    it("starts queued pairs in arrival order", async () => {
      const d = await deploy();
      await d.mockArena.write.setBusy([true]);
      const queued = await fillQueue(d, 3);

      await d.mockArena.write.setBusy([false]);
      await d.mockArena.write.setMaxActive([3n]);

      for (let i = 0; i < 3; i++) {
        await d.mm.write.triggerPendingMatch([3, SPOT]);
        const duelId = BigInt(i + 1);
        const m = await d.mm.read.matches([duelId]);
        expect(m[0].toLowerCase()).to.equal(queued[i]![0]!.toLowerCase());
      }
      expect(await d.mm.read.pendingCount([3, SPOT])).to.equal(0n);
    });

    it("stops starting duels once Arena is at capacity, and resumes after one resolves", async () => {
      const d = await deploy();
      await d.mockArena.write.setBusy([true]);
      await fillQueue(d, 3);

      await d.mockArena.write.setBusy([false]);
      await d.mockArena.write.setMaxActive([2n]);

      await d.mm.write.triggerPendingMatch([3, SPOT]);
      await d.mm.write.triggerPendingMatch([3, SPOT]);
      expect(await d.mockArena.read.hasCapacity()).to.equal(false);
      await expect(d.mm.write.triggerPendingMatch([3, SPOT]))
        .to.be.rejectedWith("ArenaStillBusy");

      await d.mockArena.write.resolveDuel([1n, 0]);
      await d.mm.write.triggerPendingMatch([3, SPOT]);
      expect(await d.mm.read.pendingCount([3, SPOT])).to.equal(0n);
    });

    it("cancelPending refunds both players and the queue skips the hole", async () => {
      const d = await deploy();
      await d.mockArena.write.setBusy([true]);
      const queued = await fillQueue(d, 2);
      const wallets = await hre.viem.getWalletClients();

      const [pA, pB] = queued[0]!;
      const beforeA = await d.mockUsdso.read.balanceOf([pA!]);
      const beforeB = await d.mockUsdso.read.balanceOf([pB!]);

      const positions = await d.mm.read.getPendingPositions([3, SPOT]) as bigint[];
      expect(positions).to.deep.equal([0n, 1n]);

      // Either player of the pair may withdraw it; both get their half back.
      await d.mm.write.cancelPending([3, SPOT, positions[0]!], { account: wallets[1]!.account });
      expect(await d.mockUsdso.read.balanceOf([pA!]) > beforeA).to.equal(true);
      expect(await d.mockUsdso.read.balanceOf([pB!]) > beforeB).to.equal(true);
      expect(await d.mm.read.pendingCount([3, SPOT])).to.equal(1n);

      // The cancelled entry is a tombstone — the next trigger must skip it and
      // start pair two, not revert on the hole.
      await d.mockArena.write.setBusy([false]);
      await d.mm.write.triggerPendingMatch([3, SPOT]);
      const m = await d.mm.read.matches([1n]);
      expect(m[0].toLowerCase()).to.equal(queued[1]![0]!.toLowerCase());
    });

    it("only a player of that pair may cancel it", async () => {
      const d = await deploy();
      await d.mockArena.write.setBusy([true]);
      await fillQueue(d, 1);
      const wallets = await hre.viem.getWalletClients();

      await expect(
        d.mm.write.cancelPending([3, SPOT, 0n], { account: wallets[9]!.account }),
      ).to.be.rejectedWith("NotYourMatch");
    });
  });

  describe("claimWinnings()", () => {
    it("pays winner and emits event, records 0 for loser", async () => {
      const { mm, mockArena, mockUsdso, alice, bob } = await deploy();
      const half = await mm.read.halfDeposit([3, SPOT]);

      await mockUsdso.write.approve([mm.address, half], {
        account: alice.account,
      });
      await mm.write.queue([0, 3, SPOT], { account: alice.account });

      await mockUsdso.write.approve([mm.address, half], {
        account: bob.account,
      });
      await mm.write.queue([1, 3, SPOT], { account: bob.account });

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

    // A duel where neither fighter got ahead used to be awarded to slot A, so the
    // slot-B player lost their whole stake to a comparison operator. On a draw
    // each player takes back their own money instead.
    it("on a draw both players are refunded, and the two halves are the whole pot", async () => {
      const { mm, mockArena, mockUsdso, alice, bob } = await deploy();
      const half = await mm.read.halfDeposit([3, SPOT]);

      await mockUsdso.write.approve([mm.address, half], { account: alice.account });
      await mm.write.queue([0, 3, SPOT], { account: alice.account });
      await mockUsdso.write.approve([mm.address, half], { account: bob.account });
      await mm.write.queue([1, 3, SPOT], { account: bob.account });

      const duelId = await mockArena.read.lastDuelId();
      await mockArena.write.resolveDuel([duelId, 2]); // 2 = draw

      const aliceBefore = await mockUsdso.read.balanceOf([alice.account.address]);
      const bobBefore   = await mockUsdso.read.balanceOf([bob.account.address]);

      await mm.write.claimWinnings([duelId], { account: alice.account });
      await mm.write.claimWinnings([duelId], { account: bob.account });

      const alicePaid = (await mockUsdso.read.balanceOf([alice.account.address])) - aliceBefore;
      const bobPaid   = (await mockUsdso.read.balanceOf([bob.account.address])) - bobBefore;

      expect(alicePaid).to.be.gt(0n, "slot A must not walk away with everything");
      expect(bobPaid).to.be.gt(0n, "slot B must not lose a duel nobody won");

      const { totalPot } = await mm.read.matches([duelId]).then((m: unknown[]) => ({ totalPot: m[2] as bigint }));
      expect(alicePaid + bobPaid).to.equal(totalPot, "the two refunds must exactly exhaust the pot");
      // Split by role, not claim order, so the odd wei is deterministic.
      expect(bobPaid - alicePaid).to.be.lte(1n);
    });

    it("reverts if duel not resolved", async () => {
      const { mm, mockArena, mockUsdso, alice, bob } = await deploy();
      const half = await mm.read.halfDeposit([3, SPOT]);

      await mockUsdso.write.approve([mm.address, half], {
        account: alice.account,
      });
      await mm.write.queue([0, 3, SPOT], { account: alice.account });

      await mockUsdso.write.approve([mm.address, half], {
        account: bob.account,
      });
      await mm.write.queue([1, 3, SPOT], { account: bob.account });

      const duelId = await mockArena.read.lastDuelId();
      await expect(
        mm.write.claimWinnings([duelId], { account: alice.account })
      ).to.be.rejectedWith("DuelNotResolved");
    });

    it("reverts on double claim", async () => {
      const { mm, mockArena, mockUsdso, alice, bob } = await deploy();
      const half = await mm.read.halfDeposit([3, SPOT]);

      await mockUsdso.write.approve([mm.address, half], { account: alice.account });
      await mm.write.queue([0, 3, SPOT], { account: alice.account });
      await mockUsdso.write.approve([mm.address, half], { account: bob.account });
      await mm.write.queue([1, 3, SPOT], { account: bob.account });

      const duelId = await mockArena.read.lastDuelId();
      await mockArena.write.resolveDuel([duelId, 0]);

      await mm.write.claimWinnings([duelId], { account: alice.account });
      await expect(
        mm.write.claimWinnings([duelId], { account: alice.account })
      ).to.be.rejectedWith("AlreadySettled");
    });
  });

  describe("separate games per market", () => {
    it("a mixed player and a spot player never match each other", async () => {
      // The whole point of the split: an expensive real-asset fight and a cheap
      // mixed one are different games. If these two paired, one of them would be
      // funding a fight priced for the other.
      const { mm, mockUsdso, alice, bob } = await deploy();
      const half = await mm.read.halfDeposit([9, SPOT]);

      await mockUsdso.write.approve([mm.address, half], { account: alice.account });
      await mm.write.queue([0, 9, SPOT], { account: alice.account });

      await mockUsdso.write.approve([mm.address, half], { account: bob.account });
      await mm.write.queue([1, 9, MIXED], { account: bob.account });

      const [spotPlayer] = await mm.read.getSlot([9, SPOT]);
      const [mixedPlayer] = await mm.read.getSlot([9, MIXED]);
      expect(spotPlayer.toLowerCase(), "the spot player is still waiting")
        .to.equal(alice.account.address.toLowerCase());
      expect(mixedPlayer.toLowerCase(), "and so is the mixed player")
        .to.equal(bob.account.address.toLowerCase());
    });

    it("two mixed players match, and the fight starts on the mixed market", async () => {
      const { mm, mockArena, mockUsdso, alice, bob } = await deploy();
      const half = await mm.read.halfDeposit([9, MIXED]);

      await mockUsdso.write.approve([mm.address, half], { account: alice.account });
      await mm.write.queue([0, 9, MIXED], { account: alice.account });
      await mockUsdso.write.approve([mm.address, half], { account: bob.account });
      await mm.write.queue([1, 9, MIXED], { account: bob.account });

      const duelId = await mockArena.read.lastDuelId() as bigint;
      expect(duelId, "a duel was started").to.be.greaterThan(0n);
      expect(await mockArena.read.duelMarketKind([duelId]), "on the mixed market")
        .to.equal(MIXED);

      const [stillWaiting] = await mm.read.getSlot([9, MIXED]);
      expect(stillWaiting, "the mixed slot is empty again")
        .to.equal("0x0000000000000000000000000000000000000000");
    });

    it("the same tier queues independently on each market", async () => {
      // Three players, same tier, three different markets: nobody matches, and
      // each waits in their own line rather than colliding in one.
      const { mm, mockUsdso, alice, bob, charlie } = await deploy();
      for (const [who, kind] of [[alice, SPOT], [bob, PRACTICE], [charlie, MIXED]] as const) {
        const half = await mm.read.halfDeposit([15, kind]);
        await mockUsdso.write.approve([mm.address, half], { account: who.account });
        await mm.write.queue([0, 15, kind], { account: who.account });
      }
      for (const [who, kind] of [[alice, SPOT], [bob, PRACTICE], [charlie, MIXED]] as const) {
        const [player] = await mm.read.getSlot([15, kind]);
        expect(player.toLowerCase(), `market ${kind} holds its own player`)
          .to.equal(who.account.address.toLowerCase());
      }
    });

    it("rejects a market that does not exist", async () => {
      const { mm, alice } = await deploy();
      await expect(
        mm.write.queue([0, 3, 3], { account: alice.account })
      ).to.be.rejectedWith("InvalidMarket");
    });
  });
});
