import { expect } from "chai";
import hre from "hardhat";
import { parseEther } from "viem";

const DUEL_RESOLVED_STATUS = 4;

async function deploy() {
  const [owner, bettor1, bettor2, bettor3, rakeRecipient] =
    await hre.viem.getWalletClients();

  const mockArena = await hre.viem.deployContract("MockArena");
  const usdso = await hre.viem.deployContract("MockERC20", ["USDso", "USDso"]);

  const bookmaker = await hre.viem.deployContract("Bookmaker", [
    mockArena.address,
    usdso.address,
    1n,
  ], { value: parseEther("33") });

  const mintAmount = parseEther("1000");
  for (const acc of [bettor1, bettor2, bettor3]) {
    await usdso.write.mint([acc.account.address, mintAmount]);
    await usdso.write.approve([bookmaker.address, mintAmount], { account: acc.account });
  }

  return { bookmaker, mockArena, usdso, owner, bettor1, bettor2, bettor3, rakeRecipient };
}

describe("Bookmaker", function () {
  describe("initializeOdds", function () {
    it("initializes odds correctly", async function () {
      const { bookmaker } = await deploy();
      await bookmaker.write.initializeOdds([1n, 6000, 4000]);
      const oddsA = await bookmaker.read.currentOdds([1n, 0]);
      const oddsB = await bookmaker.read.currentOdds([1n, 1]);
      expect(Number(oddsA)).to.equal(6000);
      expect(Number(oddsB)).to.equal(4000);
    });

    it("reverts InvalidOdds when called twice on the same duelId", async function () {
      const { bookmaker } = await deploy();
      await bookmaker.write.initializeOdds([1n, 6000, 4000]);
      let caught: unknown;
      await bookmaker.write
        .initializeOdds([1n, 5000, 5000])
        .catch((e: unknown) => { caught = e; });
      expect(caught, "expected revert").to.not.be.undefined;
      expect(String(caught)).to.include("InvalidOdds");
    });

    it("reverts InvalidOdds when odds do not sum to BPS_TOTAL", async function () {
      const { bookmaker } = await deploy();
      let caught: unknown;
      await bookmaker.write
        .initializeOdds([1n, 6000, 3000])
        .catch((e: unknown) => { caught = e; });
      expect(caught, "expected revert").to.not.be.undefined;
      expect(String(caught)).to.include("InvalidOdds");
    });

    it("reverts NotOwner when non-owner calls initializeOdds", async function () {
      const { bookmaker } = await deploy();
      const [, nonOwner] = await hre.viem.getWalletClients();
      let caught: unknown;
      await bookmaker.write
        .initializeOdds([1n, 6000, 4000], { account: nonOwner.account })
        .catch((e: unknown) => { caught = e; });
      expect(caught, "expected revert").to.not.be.undefined;
      // viem 2.37 may encode the selector as hex when it can't decode the custom error name
      const s = String(caught);
      expect(
        s.includes("NotOwner") || s.includes("0x30cd7471"),
        "expected NotOwner revert"
      ).to.be.true;
    });
  });

  describe("placeBet", function () {
    it("locks odds at placement time", async function () {
      const { bookmaker, bettor1 } = await deploy();
      await bookmaker.write.initializeOdds([1n, 6000, 4000]);

      await bookmaker.write.placeBet([1n, 0, parseEther("10")], { account: bettor1.account });

      // bet is a tuple: [bettor, fighterId, stake, oddsAtPlacementBps, settled]
      const bet = (await bookmaker.read.bets([1n, 0n])) as unknown[];
      const oddsAtPlacement = bet[3];
      expect(Number(oddsAtPlacement)).to.equal(6000);
    });

    it("reverts DuelAlreadySettled when placing bet on settled duel", async function () {
      const { bookmaker, mockArena, bettor1 } = await deploy();
      await bookmaker.write.initializeOdds([1n, 6000, 4000]);

      // Settle the duel (with no bets) to flip duelSettled[1] = true
      await mockArena.write.setDuelStatus([1n, DUEL_RESOLVED_STATUS]);
      await bookmaker.write.settleBets([1n, 0]);

      let caught: unknown;
      await bookmaker.write
        .placeBet([1n, 0, parseEther("10")], { account: bettor1.account })
        .catch((e: unknown) => { caught = e; });
      expect(caught, "expected revert").to.not.be.undefined;
      expect(String(caught)).to.include("DuelAlreadySettled");
    });

    it("reverts ZeroStake when stake is zero", async function () {
      const { bookmaker, bettor1 } = await deploy();
      await bookmaker.write.initializeOdds([1n, 6000, 4000]);
      let caught: unknown;
      await bookmaker.write
        .placeBet([1n, 0, 0n], { account: bettor1.account })
        .catch((e: unknown) => { caught = e; });
      expect(caught, "expected revert").to.not.be.undefined;
      expect(String(caught)).to.include("ZeroStake");
    });
  });

  describe("settleBets", function () {
    it("pays winning bettors and accrues rake correctly", async function () {
      const { bookmaker, mockArena, usdso, bettor1, bettor2, bettor3 } = await deploy();
      await bookmaker.write.initializeOdds([1n, 6000, 4000]);

      // bettor1 and bettor2 bet on fighter 0 (A) at 6000 bps, bettor3 bets on fighter 1 (B)
      const stake10 = parseEther("10");
      const stake6 = parseEther("6");

      await bookmaker.write.placeBet([1n, 0, stake10], { account: bettor1.account });
      await bookmaker.write.placeBet([1n, 0, stake10], { account: bettor2.account });
      await bookmaker.write.placeBet([1n, 1, stake6], { account: bettor3.account });

      await mockArena.write.setDuelStatus([1n, DUEL_RESOLVED_STATUS]);
      await bookmaker.write.settleBets([1n, 0]);

      // totalLosingStake = 6e18 (bettor3)
      // rake = 6e18 * 500 / 10000 = 3e17
      // losingPoolAfterRake = 6e18 - 3e17 = 5.7e18
      // totalWinningStake = 20e18
      // each winner winnings = 5.7e18 * 10e18 / 20e18 = 2.85e18
      // each winner payout = 10e18 + 2.85e18 = 12.85e18
      const totalLosing = stake6;
      const rake = totalLosing * 500n / 10000n;
      const losingAfterRake = totalLosing - rake;
      const totalWinning = stake10 * 2n;
      const winnings = losingAfterRake * stake10 / totalWinning;
      const expectedPayout = stake10 + winnings;

      const startBal = parseEther("1000");
      const bal1 = await usdso.read.balanceOf([bettor1.account.address]);
      const bal2 = await usdso.read.balanceOf([bettor2.account.address]);
      expect(bal1).to.equal(startBal - stake10 + expectedPayout);
      expect(bal2).to.equal(startBal - stake10 + expectedPayout);

      const accrued = await bookmaker.read.rakeAccrued([1n]);
      expect(accrued).to.equal(rake);
    });

    it("reverts DuelAlreadySettled on second settle call", async function () {
      const { bookmaker, mockArena } = await deploy();
      await bookmaker.write.initializeOdds([1n, 6000, 4000]);
      await mockArena.write.setDuelStatus([1n, DUEL_RESOLVED_STATUS]);
      await bookmaker.write.settleBets([1n, 0]);

      let caught: unknown;
      await bookmaker.write
        .settleBets([1n, 0])
        .catch((e: unknown) => { caught = e; });
      expect(caught, "expected revert").to.not.be.undefined;
      expect(String(caught)).to.include("DuelAlreadySettled");
    });

    it("reverts InvalidWinner when winnerId >= 2", async function () {
      const { bookmaker, mockArena } = await deploy();
      await bookmaker.write.initializeOdds([1n, 6000, 4000]);
      await mockArena.write.setDuelStatus([1n, DUEL_RESOLVED_STATUS]);

      let caught: unknown;
      await bookmaker.write
        .settleBets([1n, 2])
        .catch((e: unknown) => { caught = e; });
      expect(caught, "expected revert").to.not.be.undefined;
      expect(String(caught)).to.include("InvalidWinner");
    });

    it("reverts InsufficientBookmakerBalance when contract underfunded", async function () {
      const { bookmaker, mockArena, usdso, bettor1, bettor2, bettor3 } = await deploy();
      await bookmaker.write.initializeOdds([1n, 6000, 4000]);

      await bookmaker.write.placeBet([1n, 0, parseEther("10")], { account: bettor1.account });
      await bookmaker.write.placeBet([1n, 0, parseEther("10")], { account: bettor2.account });
      await bookmaker.write.placeBet([1n, 1, parseEther("6")], { account: bettor3.account });

      // Drain the bookmaker's balance so it cannot cover payouts
      const bookmakerBalance = await usdso.read.balanceOf([bookmaker.address]);
      await usdso.write.burn([bookmaker.address, bookmakerBalance]);

      await mockArena.write.setDuelStatus([1n, DUEL_RESOLVED_STATUS]);

      let caught: unknown;
      await bookmaker.write
        .settleBets([1n, 0])
        .catch((e: unknown) => { caught = e; });
      expect(caught, "expected revert").to.not.be.undefined;
      expect(String(caught)).to.include("InsufficientBookmakerBalance");
    });
  });

  describe("withdrawRake", function () {
    it("sends accrued rake to designated address", async function () {
      const { bookmaker, mockArena, usdso, bettor3, rakeRecipient } = await deploy();
      await bookmaker.write.initializeOdds([1n, 6000, 4000]);

      // Only a losing bet so there is rake with no winner payout needed
      await bookmaker.write.placeBet([1n, 1, parseEther("10")], { account: bettor3.account });

      await mockArena.write.setDuelStatus([1n, DUEL_RESOLVED_STATUS]);
      await bookmaker.write.settleBets([1n, 0]);

      const expectedRake = parseEther("10") * 500n / 10000n;

      await bookmaker.write.withdrawRake([1n, rakeRecipient.account.address]);

      const recipientBal = await usdso.read.balanceOf([rakeRecipient.account.address]);
      expect(recipientBal).to.equal(expectedRake);

      const remaining = await bookmaker.read.rakeAccrued([1n]);
      expect(remaining).to.equal(0n);
    });

    it("reverts DuelInactive when duel not yet settled", async function () {
      const { bookmaker, rakeRecipient } = await deploy();
      await bookmaker.write.initializeOdds([1n, 6000, 4000]);

      let caught: unknown;
      await bookmaker.write
        .withdrawRake([1n, rakeRecipient.account.address])
        .catch((e: unknown) => { caught = e; });
      expect(caught, "expected revert").to.not.be.undefined;
      expect(String(caught)).to.include("DuelInactive");
    });

    it("reverts NothingToWithdraw on second withdrawRake call", async function () {
      const { bookmaker, mockArena, bettor3, rakeRecipient } = await deploy();
      await bookmaker.write.initializeOdds([1n, 6000, 4000]);

      await bookmaker.write.placeBet([1n, 1, parseEther("10")], { account: bettor3.account });

      await mockArena.write.setDuelStatus([1n, DUEL_RESOLVED_STATUS]);
      await bookmaker.write.settleBets([1n, 0]);

      await bookmaker.write.withdrawRake([1n, rakeRecipient.account.address]);

      let caught: unknown;
      await bookmaker.write
        .withdrawRake([1n, rakeRecipient.account.address])
        .catch((e: unknown) => { caught = e; });
      expect(caught, "expected revert").to.not.be.undefined;
      expect(String(caught)).to.include("NothingToWithdraw");
    });
  });

  describe("resubscribe + withdrawNative", function () {
    it("withdrawNative transfers STT to recipient", async function () {
      const { bookmaker, rakeRecipient } = await deploy();
      const pub = await hre.viem.getPublicClient();

      const before = await pub.getBalance({ address: rakeRecipient.account.address });
      await bookmaker.write.withdrawNative([rakeRecipient.account.address, parseEther("5")]);
      const after = await pub.getBalance({ address: rakeRecipient.account.address });
      expect(after - before).to.equal(parseEther("5"));
    });

    it("withdrawNative reverts NotOwner for non-owner", async function () {
      const { bookmaker, bettor1 } = await deploy();
      let caught: unknown;
      await bookmaker.write
        .withdrawNative([bettor1.account.address, parseEther("1")], { account: bettor1.account })
        .catch((e: unknown) => { caught = e; });
      expect(caught, "expected NotOwner revert").to.not.be.undefined;
      expect(String(caught)).to.satisfy((s: string) => s.includes("NotOwner") || /0x30cd7471/i.test(s));
    });

    it("resubscribe reverts ReactivityUnderfunded when balance < 32 STT", async function () {
      const { bookmaker } = await deploy();
      const [owner] = await hre.viem.getWalletClients();
      await bookmaker.write.withdrawNative([owner.account.address, parseEther("33")]);

      let caught: unknown;
      await bookmaker.write.resubscribe().catch((e: unknown) => { caught = e; });
      expect(caught, "expected ReactivityUnderfunded revert").to.not.be.undefined;
      expect(String(caught)).to.include("ReactivityUnderfunded");
    });

    it("resubscribe succeeds when funded (precompile missing locally → newId 0)", async function () {
      const { bookmaker } = await deploy();
      const pub = await hre.viem.getPublicClient();
      const tx = await bookmaker.write.resubscribe();
      const receipt = await pub.waitForTransactionReceipt({ hash: tx });
      expect(receipt.status).to.equal("success");
      const subId = (await bookmaker.read.subscriptionId()) as bigint;
      expect(subId).to.equal(0n);
    });
  });
});
