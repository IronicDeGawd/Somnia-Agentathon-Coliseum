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

  describe("capability 6 — settlement turns a held asset back into cash", function () {
    it("sells the whole held asset, leaving it at zero and cash increased", async () => {
      const { owner, container, quote, base, pool } = await deploy();

      await base.write.mint([container.address, parseEther("3")]);
      await quote.write.mint([pool.address, parseEther("6000")]);
      await pool.write.setNextFill([parseEther("3"), parseEther("6000")]);

      const hash = await container.write.settle(
        [pool.address, base.address, parseEther("2000"), GTC, 1],
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
        [pool.address, zeroAddress, parseEther("2000"), GTC, 1],
        { account: owner.account },
      );
      await publicClient.waitForTransactionReceipt({ hash });

      expect(await publicClient.getBalance({ address: container.address })).to.equal(0n);
      expect(await quote.read.balanceOf([container.address])).to.equal(parseEther("4000"));
    });

    it("does nothing and does not revert when the held asset is already zero", async () => {
      const { owner, container, base, pool } = await deploy();
      const hash = await container.write.settle(
        [pool.address, base.address, parseEther("2000"), GTC, 1],
        { account: owner.account },
      );
      const publicClient = await hre.viem.getPublicClient();
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      expect(receipt.status).to.equal("success");
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
          [pool.address, base.address, 1n, GTC, 1],
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
        ["fundMargin", "owner", "recoverNative", "recoverToken", "settle", "trade"].sort(),
      );
    });
  });
});
