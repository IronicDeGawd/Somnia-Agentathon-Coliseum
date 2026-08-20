import hre from "hardhat";
import { expect } from "chai";
import { parseEther, zeroAddress } from "viem";

/**
 * The pot exists because revenue and cost were denominated differently and never
 * met: players pay stablecoin, the fighters' thinking is billed in the chain's own
 * coin, and nothing converted one into the other — so the coin balance was topped up
 * by hand and the entry fee could not reach the thing it was priced for.
 *
 * What these tests are really guarding is the difference between "the pot works" and
 * "the pot cannot be used against the house". `refuel` is callable by anyone on
 * purpose, so the spend cap, the price ceiling and the act-only-below-floor band are
 * the entire defence, and each is asserted rather than assumed.
 */
describe("FuelPot", function () {
  this.timeout(120_000);

  // Bumped per deploy so no two tests share a stand-in Arena address.
  let arenaSeq = 0xa100n;

  async function deploy() {
    const [owner, stranger] = await hre.viem.getWalletClients();
    const publicClient = await hre.viem.getPublicClient();

    const stable = await hre.viem.deployContract("MockERC20", ["USDso", "USDso"]);
    const market = await hre.viem.deployContract("MockSpotPool", []);
    // A native-base market: the base has no token contract, which is what makes a
    // purchase deliver real coin rather than an ERC-20.
    await market.write.setPoolParams([zeroAddress, stable.address, 1n, 0n, 1n]);

    // The Arena stands in as a plain address here — all the pot needs of it is a
    // coin balance to read and somewhere to send coin.
    //
    // A DISTINCT address per test, because a balance sent to a hardcoded one
    // persists across tests in the same chain and silently poisons the next
    // assertion. Caught exactly that way.
    arenaSeq += 1n;
    const arena = `0x${arenaSeq.toString(16).padStart(40, "0")}` as `0x${string}`;

    const pot = await hre.viem.deployContract("FuelPot", [stable.address, market.address, arena]);
    return { owner, stranger, publicClient, stable, market, pot, arena };
  }

  describe("it only acts when there is something to do", function () {
    it("does nothing, and does not revert, when the pot is empty", async () => {
      const { owner, pot, publicClient } = await deploy();
      const hash = await pot.write.refuel({ account: owner.account, gas: 12_000_000n });
      const r = await publicClient.waitForTransactionReceipt({ hash });
      expect(r.status, "a keeper on a timer must not see a stream of failures").to.equal("success");
      const skipped = await pot.getEvents.RefuelSkipped({}, { blockHash: r.blockHash });
      expect(skipped.map((e: any) => e.args.reason)).to.deep.equal(["pot is empty"]);
    });

    it("does nothing when the arena is already above the floor", async () => {
      const { owner, pot, stable, publicClient } = await deploy();
      await stable.write.mint([pot.address, parseEther("100")]);
      // Give the stand-in arena more coin than the floor.
      await owner.sendTransaction({ to: await pot.read.arena() as `0x${string}`, value: parseEther("30") });
      const hash = await pot.write.refuel({ account: owner.account, gas: 12_000_000n });
      const r = await publicClient.waitForTransactionReceipt({ hash });
      const skipped = await pot.getEvents.RefuelSkipped({}, { blockHash: r.blockHash });
      expect(skipped.map((e: any) => e.args.reason)).to.deep.equal(["arena above floor"]);
    });

    it("reports what it would do without being asked to do it", async () => {
      const { pot, stable } = await deploy();
      await stable.write.mint([pot.address, parseEther("100")]);
      const [arenaCoin, potStable, potCoin, wouldAct] =
        await pot.read.status() as [bigint, bigint, bigint, boolean];
      expect(arenaCoin).to.equal(0n);
      expect(potStable).to.equal(parseEther("100"));
      expect(potCoin).to.equal(0n);
      expect(wouldAct, "an empty arena with a funded pot is exactly when it should act").to.equal(true);
    });
  });

  describe("anyone may call it, so the limits are the defence", function () {
    it("a stranger may refuel — that is the point", async () => {
      // A pot only the owner can fill is a pot that runs dry at three in the morning.
      const { stranger, pot, stable, publicClient } = await deploy();
      await stable.write.mint([pot.address, parseEther("100")]);
      const hash = await pot.write.refuel({ account: stranger.account });
      const r = await publicClient.waitForTransactionReceipt({ hash });
      expect(r.status).to.equal("success");
    });

    it("a stranger may NOT withdraw, reconfigure, or migrate", async () => {
      const { stranger, pot, stable } = await deploy();
      await stable.write.mint([pot.address, parseEther("10")]);
      await expect(pot.write.ownerWithdraw([stable.address, stranger.account.address, 1n], { account: stranger.account })).to.be.rejected;
      await expect(pot.write.migrate([stranger.account.address], { account: stranger.account })).to.be.rejected;
      await expect(pot.write.setBand([1n, 2n], { account: stranger.account })).to.be.rejected;
      await expect(pot.write.setLimits([1n, 1n], { account: stranger.account })).to.be.rejected;
      await expect(pot.write.setArena([stranger.account.address], { account: stranger.account })).to.be.rejected;
    });

    it("refuses a floor at or above the target, which would make every call act", async () => {
      const { owner, pot } = await deploy();
      await expect(
        pot.write.setBand([parseEther("40"), parseEther("40")], { account: owner.account }),
        "a floor equal to target removes the band and invites a trade every block",
      ).to.be.rejected;
      await expect(pot.write.setBand([0n, parseEther("40")], { account: owner.account })).to.be.rejected;
    });

    it("refuses an effectively unbounded price premium", async () => {
      const { owner, pot } = await deploy();
      await expect(
        pot.write.setLimits([parseEther("10"), 5_000n], { account: owner.account }),
        "an unbounded cross is a way to make the house pay whatever the book asks",
      ).to.be.rejected;
      // Ten percent is the documented ceiling and must still be allowed.
      await pot.write.setLimits([parseEther("10"), 1_000n], { account: owner.account });
      expect(await pot.read.maxPremiumBps()).to.equal(1_000n);
    });
  });

  describe("it refuses to half-try", function () {
    it("reverts rather than ordering when there is not enough gas to finish", async () => {
      // The failure this guards was silent and self-perpetuating. The first version
      // placed its order inside a catch with no floor: every attempt failed while
      // reporting success, because the nested call ran out of gas and the catch
      // absorbed it — and because the outer call still succeeded, the estimator
      // sized every retry to fail the same way. Measured on chain: 1,075,403 gas
      // spent in total against 1,157,110 needed for the venue's work alone.
      const { owner, pot, stable, market } = await deploy();
      await stable.write.mint([pot.address, parseEther("100")]);
      // A book to cross, so the call actually reaches the point of ordering rather
      // than returning early with "nobody offering".
      await market.write.setBookLevel([false, parseEther("0.1"), parseEther("500")]);
      await expect(
        pot.write.refuel({ account: owner.account, gas: 500_000n }),
        "a call too small to finish must fail loudly, not report a venue refusal",
      ).to.be.rejected;

      // And with room to work, the same call gets past the floor.
      const hash = await pot.write.refuel({ account: owner.account, gas: 12_000_000n });
      const receipt = await (await hre.viem.getPublicClient()).waitForTransactionReceipt({ hash });
      const skipped = await pot.getEvents.RefuelSkipped({}, { blockHash: receipt.blockHash });
      expect(
        skipped.map((e: any) => e.args.reason),
        "with enough gas it must get past the floor and reach the venue",
      ).to.not.include("nobody offering coin");
    });

    it("will not let the floor be set below the venue's measured cost", async () => {
      const { owner, pot } = await deploy();
      // A four-million limit was refused by the real venue, so any floor at or
      // below it would permit the same silent half-try this guard exists to stop.
      await expect(pot.write.setGasFloor([100_000n], { account: owner.account })).to.be.rejected;
      await expect(pot.write.setGasFloor([3_000_000n], { account: owner.account })).to.be.rejected;
      await pot.write.setGasFloor([9_000_000n], { account: owner.account });
      expect(await pot.read.rescueGasFloor()).to.equal(9_000_000n);
    });
  });

  describe("the way out", function () {
    it("lets the owner take the whole balance back, both currencies", async () => {
      // Uncapped on purpose: this pot holds no player money, so a cap could only
      // ever strand the house's own funds. The Arena's cap exists because ITS
      // balance contains players' stakes — a distinction about what is held, not
      // about who is asking.
      const { owner, pot, stable, publicClient } = await deploy();
      await stable.write.mint([pot.address, parseEther("50")]);
      await owner.sendTransaction({ to: pot.address, value: parseEther("2") });

      await pot.write.ownerWithdraw([stable.address, owner.account.address, parseEther("50")], { account: owner.account });
      await pot.write.ownerWithdraw([zeroAddress, owner.account.address, parseEther("2")], { account: owner.account });

      expect(await stable.read.balanceOf([pot.address])).to.equal(0n);
      expect(await publicClient.getBalance({ address: pot.address })).to.equal(0n);
    });

    it("migrates everything to a successor in one call", async () => {
      // Two amounts are stranded in superseded contracts in this project already,
      // both because moving money out was a manual sequence rather than one call.
      const { owner, pot, stable, market, publicClient, arena } = await deploy();
      const successor = await hre.viem.deployContract("FuelPot", [stable.address, market.address, arena]);
      await stable.write.mint([pot.address, parseEther("72.2")]);
      await owner.sendTransaction({ to: pot.address, value: parseEther("1") });

      await pot.write.migrate([successor.address], { account: owner.account });

      expect(await stable.read.balanceOf([pot.address]), "predecessor must read empty").to.equal(0n);
      expect(await publicClient.getBalance({ address: pot.address })).to.equal(0n);
      expect(await stable.read.balanceOf([successor.address])).to.equal(parseEther("72.2"));
      expect(await publicClient.getBalance({ address: successor.address })).to.equal(parseEther("1"));
    });
  });

  describe("handover is two-step", function () {
    it("does not move ownership until the successor accepts", async () => {
      // A one-step transfer to a mistyped address hands this contract to someone who
      // cannot act, and everything in it becomes permanently unreachable.
      const { owner, stranger, pot } = await deploy();
      await pot.write.transferOwnership([stranger.account.address], { account: owner.account });
      expect(
        ((await pot.read.owner()) as string).toLowerCase(),
        "still the original owner until accepted",
      ).to.equal(owner.account.address.toLowerCase());
      await pot.write.acceptOwnership({ account: stranger.account });
      expect(((await pot.read.owner()) as string).toLowerCase())
        .to.equal(stranger.account.address.toLowerCase());
      expect(await pot.read.pendingOwner()).to.equal(zeroAddress);
    });

    it("only the named successor may accept", async () => {
      const { owner, stranger, pot } = await deploy();
      await pot.write.transferOwnership([stranger.account.address], { account: owner.account });
      await expect(pot.write.acceptOwnership({ account: owner.account })).to.be.rejected;
    });
  });
});
