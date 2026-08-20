import { expect } from "chai";
import hre from "hardhat";
import { parseEther, zeroAddress } from "viem";

import tradingContainerArtifact from "../artifacts/contracts/trading/TradingContainer.sol/TradingContainer.json";

const GTC = 2n ** 64n - 1n;

/**
 * `TradingContainer` is what `contracts/probe/AccountProbe.sol` was written to
 * answer: can one owner-only container buy on a spot venue, sell what it bought,
 * sell a native-base market by sending value with the order, and — with margin
 * lodged first — trade a perp, all without the arbitrary-call escape hatch the
 * probe used to reach the last of those questions. That hatch is the one thing
 * this file exists to prove was never carried over.
 */
describe("TradingContainer", function () {
  this.timeout(120_000);

  async function deploy() {
    const [owner, stranger] = await hre.viem.getWalletClients();
    const publicClient = await hre.viem.getPublicClient();

    const container = await hre.viem.deployContract("TradingContainer", [], {
      client: { wallet: owner },
    });

    const quote = await hre.viem.deployContract("MockERC20", ["USDso", "USDso"]);
    const base  = await hre.viem.deployContract("MockERC20", ["BASE", "BASE"]);
    const pool  = await hre.viem.deployContract("MockSpotPool");
    await pool.write.setPoolParams([base.address, quote.address, 1n, 0n, 1n]);

    return { owner, stranger, publicClient, container, quote, base, pool };
  }

  async function deployPerp() {
    const [owner, stranger] = await hre.viem.getWalletClients();

    const container = await hre.viem.deployContract("TradingContainer", [], {
      client: { wallet: owner },
    });
    const collateral = await hre.viem.deployContract("MockERC20", ["USDso", "USDso"]);
    const bank = await hre.viem.deployContract("MockMarginBank", [collateral.address]);
    const perpPool = await hre.viem.deployContract("MockPerpPool", [
      bank.address, parseEther("1"), parseEther("0.001"), 0n, 1n, parseEther("2000"), 500n,
    ]);
    await bank.write.registerMarket([perpPool.address, true]);

    return { owner, stranger, container, collateral, bank, perpPool };
  }

  describe("capability 1 — buy on a spot venue, fill lands in its own balance", function () {
    it("pulls quote and receives base into the container's own balance", async () => {
      const { owner, container, quote, base, pool } = await deploy();

      await quote.write.mint([container.address, parseEther("2000")]);
      await base.write.mint([pool.address, parseEther("1")]);
      await pool.write.setNextFill([parseEther("1"), parseEther("2000")]);

      const hash = await container.write.trade(
        [pool.address, quote.address, parseEther("2000"), true, 0n, parseEther("2000"), parseEther("1"), GTC, 1, 0n],
        { account: owner.account },
      );
      const publicClient = await hre.viem.getPublicClient();
      await publicClient.waitForTransactionReceipt({ hash });

      expect(await base.read.balanceOf([container.address])).to.equal(parseEther("1"));
      expect(await quote.read.balanceOf([container.address])).to.equal(0n);
      expect(await quote.read.allowance([container.address, pool.address])).to.equal(0n);
    });
  });

  describe("per-order approval hygiene", function () {
    it("resets the allowance to zero even when the venue refuses the order", async () => {
      const { owner, container, quote, pool } = await deploy();
      await quote.write.mint([container.address, parseEther("2000")]);
      await pool.write.setNextOrderShouldReject([true]);

      const hash = await container.write.trade(
        [pool.address, quote.address, parseEther("2000"), true, 0n, parseEther("2000"), parseEther("1"), GTC, 1, 0n],
        { account: owner.account },
      );
      const publicClient = await hre.viem.getPublicClient();
      await publicClient.waitForTransactionReceipt({ hash });

      // Refused, so nothing was pulled — but the allowance granted for the
      // attempt must still be gone, or a refused order would leave a standing
      // approval a venue could draw on later, unprompted.
      expect(await quote.read.balanceOf([container.address])).to.equal(parseEther("2000"));
      expect(await quote.read.allowance([container.address, pool.address])).to.equal(0n);
    });

    it("unwinds the whole transaction, leaving no allowance standing, when the venue's call REVERTS", async () => {
      const { owner, container, quote, pool } = await deploy();
      await quote.write.mint([container.address, parseEther("2000")]);
      await pool.write.setNextOrderShouldRevert([true]);

      await expect(
        container.write.trade(
          [pool.address, quote.address, parseEther("2000"), true, 0n, parseEther("2000"), parseEther("1"), GTC, 1, 0n],
          { account: owner.account },
        ),
      ).to.be.rejected;

      // The whole transaction unwound: the mint from setup is untouched, and
      // the approval attempted inside the reverted call never persisted.
      expect(await quote.read.balanceOf([container.address])).to.equal(parseEther("2000"));
      expect(await quote.read.allowance([container.address, pool.address])).to.equal(0n);
    });
  });

  describe("capability 2 — sell from its own balance", function () {
    it("pays out base and receives quote", async () => {
      const { owner, container, quote, base, pool } = await deploy();

      await base.write.mint([container.address, parseEther("1")]);
      await quote.write.mint([pool.address, parseEther("2000")]);
      await pool.write.setNextFill([parseEther("1"), parseEther("2000")]);

      const hash = await container.write.trade(
        [pool.address, base.address, parseEther("1"), false, 0n, parseEther("2000"), parseEther("1"), GTC, 1, 0n],
        { account: owner.account },
      );
      const publicClient = await hre.viem.getPublicClient();
      await publicClient.waitForTransactionReceipt({ hash });

      expect(await base.read.balanceOf([container.address])).to.equal(0n);
      expect(await quote.read.balanceOf([container.address])).to.equal(parseEther("2000"));
      expect(await base.read.allowance([container.address, pool.address])).to.equal(0n);
    });
  });

  describe("capability 3 — sell a NATIVE-base market by sending value with the order", function () {
    it("forwards value to the venue and receives quote back", async () => {
      const { owner, container, quote, pool } = await deploy();
      const publicClient = await hre.viem.getPublicClient();

      // Native-base market: the pool's own base token is address(0).
      await pool.write.setPoolParams([zeroAddress, quote.address, 1n, 0n, 1n]);
      await quote.write.mint([pool.address, parseEther("2000")]);
      await pool.write.setNextFill([0n, parseEther("2000")]);

      // Fund the container with native coin — the asset actually being sold.
      await owner.sendTransaction({ to: container.address, value: parseEther("1") });

      const poolBalanceBefore = await publicClient.getBalance({ address: pool.address });

      const hash = await container.write.trade(
        [pool.address, zeroAddress, 0n, false, 0n, parseEther("2000"), parseEther("1"), GTC, 1, parseEther("1")],
        { account: owner.account },
      );
      await publicClient.waitForTransactionReceipt({ hash });

      const poolBalanceAfter = await publicClient.getBalance({ address: pool.address });
      expect(poolBalanceAfter - poolBalanceBefore).to.equal(parseEther("1"));
      expect(await publicClient.getBalance({ address: container.address })).to.equal(0n);
      expect(await quote.read.balanceOf([container.address])).to.equal(parseEther("2000"));
    });

    it("does NOT lose its coin when the venue gracefully refuses a native-base order with value > 0", async () => {
      // Regression test for the value-stranding bug: coin moves as part of
      // the low-level CALL itself, before the venue's own accept/reject logic
      // runs, so a graceful refusal — success == true, (false, 0) returned,
      // nothing reverted — must not leave the container's coin at the venue.
      const { owner, container, quote, pool } = await deploy();
      const publicClient = await hre.viem.getPublicClient();

      await pool.write.setPoolParams([zeroAddress, quote.address, 1n, 0n, 1n]);
      await pool.write.setNextOrderShouldReject([true]);
      await owner.sendTransaction({ to: container.address, value: parseEther("1") });

      const poolBalanceBefore = await publicClient.getBalance({ address: pool.address });

      await expect(
        container.write.trade(
          [pool.address, zeroAddress, 0n, false, 0n, parseEther("2000"), parseEther("1"), GTC, 1, parseEther("1")],
          { account: owner.account },
        ),
      ).to.be.rejected;

      const poolBalanceAfter = await publicClient.getBalance({ address: pool.address });
      expect(poolBalanceAfter).to.equal(poolBalanceBefore);
      expect(await publicClient.getBalance({ address: container.address })).to.equal(parseEther("1"));
    });
  });

  describe("capability 4 — an events desk trades through the same shape", function () {
    it("places an order against any venue speaking the nine-argument shape, no extra code needed", async () => {
      // An events desk is, from the container's point of view, exactly another
      // address whose placeOrder matches the nine-argument shape — MockSpotPool
      // already stands in for one.
      const { owner, container, quote, pool } = await deploy();
      await quote.write.mint([container.address, parseEther("10")]);

      const hash = await container.write.trade(
        [pool.address, quote.address, parseEther("10"), true, 0n, parseEther("10"), parseEther("1"), GTC, 1, 0n],
        { account: owner.account },
      );
      const publicClient = await hre.viem.getPublicClient();
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      expect(receipt.status).to.equal("success");
      expect(await pool.read.getOrdersCount()).to.equal(1n);
    });
  });

  describe("capability 5 — trade a perpetual after lodging margin with a margin bank", function () {
    it("funds margin, resets the allowance to zero, and opens a position", async () => {
      const { owner, container, collateral, bank, perpPool } = await deployPerp();

      await collateral.write.mint([container.address, parseEther("100")]);
      // Book depth for a long to cross against.
      await perpPool.write.pushBookLevel([false, parseEther("2000"), parseEther("1")]);

      const fundHash = await container.write.fundMargin(
        [collateral.address, bank.address, parseEther("100")],
        { account: owner.account },
      );
      const publicClient = await hre.viem.getPublicClient();
      await publicClient.waitForTransactionReceipt({ hash: fundHash });

      expect(await collateral.read.allowance([container.address, bank.address])).to.equal(0n);
      expect(await bank.read.balances([container.address])).to.equal(parseEther("100"));

      const tradeHash = await container.write.trade(
        [perpPool.address, zeroAddress, 0n, true, 0n, parseEther("2000"), parseEther("0.1"), GTC, 1, 0n],
        { account: owner.account },
      );
      await publicClient.waitForTransactionReceipt({ hash: tradeHash });

      const position = await bank.read.getPosition([container.address, perpPool.address]) as unknown[];
      expect(position[0] as bigint).to.equal(parseEther("0.1"));
    });

    it("never leaves a standing allowance on the bank even when the deposit needs all of it", async () => {
      const { owner, container, collateral, bank } = await deployPerp();
      await collateral.write.mint([container.address, parseEther("50")]);

      const hash = await container.write.fundMargin(
        [collateral.address, bank.address, parseEther("50")],
        { account: owner.account },
      );
      const publicClient = await hre.viem.getPublicClient();
      await publicClient.waitForTransactionReceipt({ hash });

      expect(await collateral.read.allowance([container.address, bank.address])).to.equal(0n);
    });
  });

  describe("capability 5b — margin lodged with a desk can come back out", function () {
    // The container is a FIXED address that is never upgraded, so one leased out
    // without a way back would strand every deposit it ever posted, permanently.
    // These tests are what stop that shipping.

    it("brings the whole lodged balance back to the owner", async () => {
      const { owner, container, collateral, bank } = await deployPerp();
      const publicClient = await hre.viem.getPublicClient();

      await collateral.write.mint([container.address, parseEther("100")]);
      await publicClient.waitForTransactionReceipt({
        hash: await container.write.fundMargin(
          [collateral.address, bank.address, parseEther("100")],
          { account: owner.account },
        ),
      });
      expect(await collateral.read.balanceOf([container.address]), "cash left the container")
        .to.equal(0n);

      const ownerBefore = await collateral.read.balanceOf([owner.account.address]) as bigint;
      await publicClient.waitForTransactionReceipt({
        hash: await container.write.reclaimMargin(
          [collateral.address, bank.address, 0n],
          { account: owner.account },
        ),
      });

      expect(await bank.read.balances([container.address]), "the desk released it")
        .to.equal(0n);
      expect(await collateral.read.balanceOf([container.address]), "and it did not stop here")
        .to.equal(0n);
      expect(
        (await collateral.read.balanceOf([owner.account.address]) as bigint) - ownerBefore,
        "the whole deposit reached the owner",
      ).to.equal(parseEther("100"));
    });

    it("sweeps a remainder the desk never held, not just what it released", async () => {
      // A settlement rounding remainder can be sitting on the container while the
      // rest is at the desk. Sweeping only the amount asked for would leave it
      // here forever, since nothing looks at this address again after a lease.
      const { owner, container, collateral, bank } = await deployPerp();
      const publicClient = await hre.viem.getPublicClient();

      await collateral.write.mint([container.address, parseEther("100")]);
      await publicClient.waitForTransactionReceipt({
        hash: await container.write.fundMargin(
          [collateral.address, bank.address, parseEther("90")],
          { account: owner.account },
        ),
      });
      // 10 stayed behind, as a remainder would.
      expect(await collateral.read.balanceOf([container.address])).to.equal(parseEther("10"));

      const ownerBefore = await collateral.read.balanceOf([owner.account.address]) as bigint;
      await publicClient.waitForTransactionReceipt({
        hash: await container.write.reclaimMargin(
          [collateral.address, bank.address, 0n],
          { account: owner.account },
        ),
      });

      expect(
        (await collateral.read.balanceOf([owner.account.address]) as bigint) - ownerBefore,
        "the released margin AND the remainder both left",
      ).to.equal(parseEther("100"));
      expect(await collateral.read.balanceOf([container.address])).to.equal(0n);
    });

    it("still rescues what is loose when the desk refuses to release", async () => {
      // The release is the part that can fail. Reverting on it would take the sweep
      // down too and strand cash that had already arrived.
      const { owner, container, collateral, bank } = await deployPerp();
      const publicClient = await hre.viem.getPublicClient();

      await collateral.write.mint([container.address, parseEther("40")]);
      // Nothing was ever lodged, so the desk has nothing to give and free margin
      // reads zero — the same shape as a desk that refuses.
      const ownerBefore = await collateral.read.balanceOf([owner.account.address]) as bigint;
      await publicClient.waitForTransactionReceipt({
        hash: await container.write.reclaimMargin(
          [collateral.address, bank.address, 0n],
          { account: owner.account },
        ),
      });

      expect(
        (await collateral.read.balanceOf([owner.account.address]) as bigint) - ownerBefore,
        "the loose cash came back regardless",
      ).to.equal(parseEther("40"));
    });

    it("asks for free margin, not the deposit, while a position is open", async () => {
      // The desk's own withdrawable figure ignores the margin an open position
      // needs — measured reporting a full deposit with a short open against it.
      // Asking for that is refused outright and recovers NOTHING, so the ceiling
      // has to be equity minus the initial requirement.
      const { owner, container, collateral, bank, perpPool } = await deployPerp();
      const publicClient = await hre.viem.getPublicClient();

      await collateral.write.mint([container.address, parseEther("100")]);
      await perpPool.write.pushBookLevel([false, parseEther("2000"), parseEther("1")]);
      await publicClient.waitForTransactionReceipt({
        hash: await container.write.fundMargin(
          [collateral.address, bank.address, parseEther("100")],
          { account: owner.account },
        ),
      });
      await publicClient.waitForTransactionReceipt({
        hash: await container.write.trade(
          [perpPool.address, zeroAddress, 0n, true, 0n, parseEther("2000"), parseEther("0.1"), GTC, 1, 0n],
          { account: owner.account },
        ),
      });

      const free = await container.read.freeMarginAt([bank.address]) as bigint;
      expect(free, "an open position reserves margin, so this is below the deposit")
        .to.be.lessThan(parseEther("100"));
      expect(free, "but there is still something free to take back").to.be.greaterThan(0n);

      await publicClient.waitForTransactionReceipt({
        hash: await container.write.reclaimMargin(
          [collateral.address, bank.address, 0n],
          { account: owner.account },
        ),
      });
      expect(
        await collateral.read.balanceOf([owner.account.address]),
        "what came back is the free part, and the position is still funded",
      ).to.be.greaterThan(0n);
      expect(await bank.read.balances([container.address]), "the position keeps its margin")
        .to.be.greaterThan(0n);
    });

    it("only the owner may reclaim", async () => {
      // Asserted the way every other stranger test here is: the call must be
      // rejected. Matching on the error TEXT is unreliable — a stranger's call is
      // refused before the revert reason is decodable.
      const { stranger, container, collateral, bank } = await deployPerp();
      await expect(
        container.write.reclaimMargin(
          [collateral.address, bank.address, 0n],
          { account: stranger.account },
        ),
      ).to.be.rejected;
    });
  });

  describe("capability 6 — settlement turns a held asset back into cash", function () {
    it("sells the whole held asset, leaving it at zero and cash increased", async () => {
      const { owner, container, quote, base, pool } = await deploy();

      await base.write.mint([container.address, parseEther("3")]);
      await quote.write.mint([pool.address, parseEther("6000")]);
      await pool.write.setNextFill([parseEther("3"), parseEther("6000")]);

      const hash = await container.write.settle(
        [pool.address, base.address, parseEther("2000"), GTC, 1, 0n],
        { account: owner.account },
      );
      const publicClient = await hre.viem.getPublicClient();
      await publicClient.waitForTransactionReceipt({ hash });

      expect(await base.read.balanceOf([container.address])).to.equal(0n);
      expect(await quote.read.balanceOf([container.address])).to.equal(parseEther("6000"));
      expect(await base.read.allowance([container.address, pool.address])).to.equal(0n);
    });

    it("settling the native coin sends the whole balance with the order", async () => {
      const { owner, container, quote, pool } = await deploy();
      const publicClient = await hre.viem.getPublicClient();

      await pool.write.setPoolParams([zeroAddress, quote.address, 1n, 0n, 1n]);
      await owner.sendTransaction({ to: container.address, value: parseEther("2") });
      await quote.write.mint([pool.address, parseEther("4000")]);
      await pool.write.setNextFill([0n, parseEther("4000")]);

      const hash = await container.write.settle(
        [pool.address, zeroAddress, parseEther("2000"), GTC, 1, 0n],
        { account: owner.account },
      );
      await publicClient.waitForTransactionReceipt({ hash });

      expect(await publicClient.getBalance({ address: container.address })).to.equal(0n);
      expect(await quote.read.balanceOf([container.address])).to.equal(parseEther("4000"));
    });

    it("rounds the sale down to the venue's trading step", async () => {
      // A venue only accepts whole steps, and a raw balance almost never is one.
      // Without this the order is declined, the asset never reaches zero, and the
      // pile-up settlement exists to end simply carries on — with every test still
      // green, because a mock with no matching engine accepts any size at all.
      const { owner, container, quote, base, pool } = await deploy();
      const publicClient = await hre.viem.getPublicClient();

      // Step of 1 whole unit; the container holds two and a half.
      await pool.write.setPoolParams([base.address, quote.address, 1n, 0n, parseEther("1")]);
      await base.write.mint([container.address, parseEther("2.5")]);
      await quote.write.mint([pool.address, parseEther("4000")]);
      await pool.write.setNextFill([parseEther("2"), parseEther("4000")]);

      const hash = await container.write.settle(
        [pool.address, base.address, parseEther("2000"), GTC, 1, 0n],
        { account: owner.account },
      );
      await publicClient.waitForTransactionReceipt({ hash });

      // Assert on the quantity the venue was OFFERED, not on the resulting balance.
      // The mock's staged fill moves a fixed amount whatever it is asked for, so a
      // balance assertion here passes with or without the rounding — which is
      // exactly how a settle that no real venue would accept kept a green suite.
      const [, , offered] = await pool.read.orders([0n]) as [boolean, bigint, bigint, number, boolean];
      expect(offered, "the order must be a whole number of steps").to.equal(parseEther("2"));
    });

    it("honours a ceiling, because an oversized all-or-nothing order cancels entirely", async () => {
      // Measured 2026-08-20 recycling the house's own assets: 0.067 offered against
      // a book holding 0.046 was refused outright, not filled in part. So settling a
      // large holding is several calls sized to the depth, never one big one.
      const { owner, container, quote, base, pool } = await deploy();
      const publicClient = await hre.viem.getPublicClient();

      await base.write.mint([container.address, parseEther("10")]);
      await quote.write.mint([pool.address, parseEther("6000")]);
      await pool.write.setNextFill([parseEther("3"), parseEther("6000")]);

      const hash = await container.write.settle(
        [pool.address, base.address, parseEther("2000"), GTC, 1, parseEther("3")],
        { account: owner.account },
      );
      await publicClient.waitForTransactionReceipt({ hash });

      const [, , capped] = await pool.read.orders([0n]) as [boolean, bigint, bigint, number, boolean];
      expect(capped, "the ceiling must limit what is offered").to.equal(parseEther("3"));
    });

    it("refuses to settle a holding below the venue's smallest order", async () => {
      const { owner, container, base, pool } = await deploy();
      await pool.write.setPoolParams([base.address, base.address, 1n, parseEther("1"), 1n]);
      await base.write.mint([container.address, parseEther("0.25")]);
      await expect(
        container.write.settle(
          [pool.address, base.address, parseEther("2000"), GTC, 1, 0n],
          { account: owner.account },
        ),
      ).to.be.rejected;
    });

    it("does nothing and does not revert when the held asset is already zero", async () => {
      const { owner, container, base, pool } = await deploy();
      const hash = await container.write.settle(
        [pool.address, base.address, parseEther("2000"), GTC, 1, 0n],
        { account: owner.account },
      );
      const publicClient = await hre.viem.getPublicClient();
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      expect(receipt.status).to.equal("success");
    });
  });

  describe("the coin is only ever sent all-or-nothing", function () {
    // The coin moves as part of the call, before the venue decides anything. A
    // PARTIAL fill therefore keeps everything that was pushed and still reports
    // success, so the refusal guard never fires and the unfilled remainder is
    // stranded with no route back. Nothing in the venue's reply says how much
    // actually filled, so this cannot be detected after the fact — only excluded.
    it("refuses a native order that allows a partial fill", async () => {
      const { owner, container, quote, pool } = await deploy();
      await pool.write.setPoolParams([zeroAddress, quote.address, 1n, 0n, 1n]);
      await owner.sendTransaction({ to: container.address, value: parseEther("2") });
      await expect(
        container.write.settle(
          [pool.address, zeroAddress, parseEther("2000"), GTC, 2 /* partial allowed */, 0n],
          { account: owner.account },
        ),
        "a partial-fill order type must be refused when value rides along",
      ).to.be.rejected;
    });

    it("still allows a token order to permit a partial fill", async () => {
      // A token order is pull-based: the venue takes what it needs, so a partial
      // fill costs nothing and the restriction above would be pointless friction.
      const { owner, container, quote, base, pool } = await deploy();
      const publicClient = await hre.viem.getPublicClient();
      await base.write.mint([container.address, parseEther("3")]);
      await quote.write.mint([pool.address, parseEther("6000")]);
      await pool.write.setNextFill([parseEther("3"), parseEther("6000")]);
      const hash = await container.write.settle(
        [pool.address, base.address, parseEther("2000"), GTC, 2, 0n],
        { account: owner.account },
      );
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      expect(receipt.status).to.equal("success");
    });
  });

  describe("a venue that answers the wrong shape is named, not swallowed", function () {
    it("rejects a reply that is not the two values this shape returns", async () => {
      // An address with a fallback SUCCEEDS with data this cannot decode, and a bare
      // decode failure reverts with no reason at all — the same swallowed-cause
      // fault the rest of this change exists to end.
      const { owner, container, quote } = await deploy();
      const odd = await hre.viem.deployContract("MockOddVenue", []);
      await quote.write.mint([container.address, parseEther("10")]);
      await expect(
        container.write.trade(
          [odd.address, quote.address, parseEther("1"),
           true, 0n, parseEther("1"), parseEther("1"), GTC, 1, 0n],
          { account: owner.account },
        ),
        "a venue that answers with the wrong shape must be named, not decoded blindly",
      ).to.be.rejectedWith(/UnexpectedVenueReply/);
    });
  });

  describe("recovery reaches the owner and nowhere else", function () {
    it("recoverToken sends the whole balance to the owner", async () => {
      const { owner, container, quote } = await deploy();
      await quote.write.mint([container.address, parseEther("5")]);

      const ownerBefore = await quote.read.balanceOf([owner.account.address]);
      const hash = await container.write.recoverToken([quote.address], { account: owner.account });
      const publicClient = await hre.viem.getPublicClient();
      await publicClient.waitForTransactionReceipt({ hash });

      expect(await quote.read.balanceOf([container.address])).to.equal(0n);
      expect(await quote.read.balanceOf([owner.account.address])).to.equal(ownerBefore + parseEther("5"));
    });

    it("recoverNative sends the whole native balance to the owner", async () => {
      const { owner, container } = await deploy();
      const publicClient = await hre.viem.getPublicClient();
      await owner.sendTransaction({ to: container.address, value: parseEther("1") });

      const hash = await container.write.recoverNative({ account: owner.account });
      await publicClient.waitForTransactionReceipt({ hash });

      expect(await publicClient.getBalance({ address: container.address })).to.equal(0n);
    });
  });

  describe("owner-gated — every state-changing function rejects a non-owner", function () {
    it("trade rejects a stranger", async () => {
      const { stranger, container, pool, quote } = await deploy();
      await expect(
        container.write.trade(
          [pool.address, quote.address, 0n, true, 0n, 0n, 0n, GTC, 1, 0n],
          { account: stranger.account },
        ),
      ).to.be.rejected;
    });

    it("fundMargin rejects a stranger", async () => {
      const { stranger, container } = await deployPerp();
      await expect(
        container.write.fundMargin(
          [zeroAddress, zeroAddress, 1n],
          { account: stranger.account },
        ),
      ).to.be.rejected;
    });

    it("settle rejects a stranger", async () => {
      const { stranger, container, pool, base } = await deploy();
      await expect(
        container.write.settle(
          [pool.address, base.address, 1n, GTC, 1, 0n],
          { account: stranger.account },
        ),
      ).to.be.rejected;
    });

    it("recoverToken rejects a stranger", async () => {
      const { stranger, container, quote } = await deploy();
      await expect(
        container.write.recoverToken([quote.address], { account: stranger.account }),
      ).to.be.rejected;
    });

    it("recoverNative rejects a stranger", async () => {
      const { stranger, container } = await deploy();
      await expect(
        container.write.recoverNative({ account: stranger.account }),
      ).to.be.rejected;
    });
  });

  // `contracts/probe/AccountProbe.sol` — the throwaway probe this container replaces
  // — carried exactly this hatch: `exec(address target, bytes data, uint256 value)`,
  // an owner-gated arbitrary call into anything. That is fine on a probe nobody
  // deploys against a live fight and never acceptable on a container that does,
  // because it turns "owner-only" into "owner can make this contract do literally
  // anything" — including draining every other asset it holds through a venue it
  // was never meant to touch. This guard asserts that shape is categorically
  // absent, not just unused today, so it fails loudly the moment anyone adds one
  // back — whatever they choose to call it.
  describe("no arbitrary-call escape hatch", function () {
    it("no function in the compiled ABI takes a raw bytes calldata argument alongside an address target", () => {
      const functions = (tradingContainerArtifact.abi as any[]).filter((entry) => entry.type === "function");
      expect(functions.length).to.be.greaterThan(0);

      for (const fn of functions) {
        const inputTypes: string[] = fn.inputs.map((input: any) => input.type as string);
        const hasTarget = inputTypes.includes("address");
        const hasRawCalldata = inputTypes.includes("bytes");
        expect(
          hasTarget && hasRawCalldata,
          `function "${fn.name}" takes both an address and raw bytes — this is exactly the arbitrary-call shape that must never exist here`,
        ).to.equal(false);
      }

      // Belt and braces: the probe's own escape hatch by name, and the usual
      // spellings an equivalent one would take.
      const forbiddenNames = ["exec", "execute", "call", "multicall"];
      const names = functions.map((fn) => fn.name as string);
      for (const forbidden of forbiddenNames) {
        expect(names).to.not.include(forbidden);
      }
    });

    it("exposes exactly the expected function set — no new function can appear unnoticed", () => {
      const functions = (tradingContainerArtifact.abi as any[]).filter((entry) => entry.type === "function");
      const names = functions.map((fn) => fn.name as string).sort();
      expect(names).to.deep.equal(
        // reclaimMargin and freeMarginAt are the way OUT of a margin desk. They
        // belong here deliberately: without them a container is a one-way door,
        // and it is a fixed address that never gets a second chance.
        ["freeMarginAt", "fundMargin", "owner", "reclaimMargin",
         "recoverNative", "recoverToken", "settle", "trade"].sort(),
      );
    });
  });
});
