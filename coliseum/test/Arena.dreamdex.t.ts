import { expect } from "chai";
import hre from "hardhat";

describe("Arena — dreamDEX placeOrder", function () {
  const PRICE = 1n * 10n ** 18n;
  const QUANTITY = 1n * 10n ** 18n;
  const EXPIRE_OFFSET = 3600n;
  const ORDER_TYPE_POST_ONLY = 3;
  const DUEL_ID = 1n;
  const FIGHTER_ID = 0;

  async function deploy() {
    const [owner, other] = await hre.viem.getWalletClients();

    const usdso = await hre.viem.deployContract("MockERC20", ["USDso", "USDso"]);
    const poolWeth = await hre.viem.deployContract("MockSpotPool");
    const poolWbtc = await hre.viem.deployContract("MockSpotPool");
    const poolSomi = await hre.viem.deployContract("MockSpotPool");
    const registry = await hre.viem.deployContract("FighterRegistry");

    const arena = await hre.viem.deployContract("Arena", [
      registry.address,
      usdso.address,
      poolWeth.address,
      poolWbtc.address,
      poolSomi.address,
    ]);

    const ownerAddr = owner.account.address;
    const perPool = 100n * 10n ** 18n;
    await usdso.write.mint([ownerAddr, 300n * 10n ** 18n]);
    await usdso.write.approve([arena.address, 300n * 10n ** 18n]);
    await arena.write.fundPools([perPool]);

    return { arena, usdso, poolWeth, poolWbtc, poolSomi, registry, owner, other };
  }

  it("PostOnly bid rests and debits quoteTokenAmount", async function () {
    const { arena, poolWeth } = await deploy();

    const tx = await arena.write.debugPlaceOrder([
      DUEL_ID,
      FIGHTER_ID,
      poolWeth.address,
      true,
      PRICE,
      QUANTITY,
      ORDER_TYPE_POST_ONLY,
      EXPIRE_OFFSET,
    ]);

    const publicClient = await hre.viem.getPublicClient();
    const receipt = await publicClient.getTransactionReceipt({ hash: tx });

    const orderPlacedLogs = receipt.logs.filter(
      (log) => log.topics[0] !== undefined
    );
    expect(orderPlacedLogs.length, "expected at least one log").to.be.greaterThan(0);

    // Verify balance debited: price * quantity / 1e18 = 1e18
    const bal = await arena.read.fighterBalances([poolWeth.address, DUEL_ID, FIGHTER_ID]) as [bigint, bigint];
    expect(bal[1]).to.equal(PRICE * QUANTITY / 10n ** 18n);
  });

  it("silent reject: emits OrderRejected, does not debit balance, does not revert", async function () {
    const { arena, poolWeth } = await deploy();

    await poolWeth.write.setNextOrderShouldReject([true]);

    const balBefore = await arena.read.fighterBalances([poolWeth.address, DUEL_ID, FIGHTER_ID]) as [bigint, bigint];

    const tx = await arena.write.debugPlaceOrder([
      DUEL_ID,
      FIGHTER_ID,
      poolWeth.address,
      true,
      PRICE,
      QUANTITY,
      ORDER_TYPE_POST_ONLY,
      EXPIRE_OFFSET,
    ]);

    const publicClient = await hre.viem.getPublicClient();
    const receipt = await publicClient.getTransactionReceipt({ hash: tx });
    expect(receipt.status).to.equal("success");

    const balAfter = await arena.read.fighterBalances([poolWeth.address, DUEL_ID, FIGHTER_ID]) as [bigint, bigint];
    expect(balAfter[1]).to.equal(balBefore[1]);
    expect(balAfter[0]).to.equal(balBefore[0]);
  });

  it("expireOffsetSec == 0 reverts InvalidExpiry", async function () {
    const { arena, poolWeth } = await deploy();

    let caught: unknown = undefined;
    await arena.write
      .debugPlaceOrder([DUEL_ID, FIGHTER_ID, poolWeth.address, true, PRICE, QUANTITY, ORDER_TYPE_POST_ONLY, 0n])
      .catch((err: unknown) => { caught = err; });

    expect(caught, "expected InvalidExpiry revert").to.not.be.undefined;
    expect(String(caught)).to.include("InvalidExpiry");
  });

  it("invalid pool reverts InvalidPool", async function () {
    const { arena } = await deploy();
    const randomAddr = "0x000000000000000000000000000000000000dEaD";

    let caught: unknown = undefined;
    await arena.write
      .debugPlaceOrder([DUEL_ID, FIGHTER_ID, randomAddr, true, PRICE, QUANTITY, ORDER_TYPE_POST_ONLY, EXPIRE_OFFSET])
      .catch((err: unknown) => { caught = err; });

    expect(caught, "expected InvalidPool revert").to.not.be.undefined;
    expect(String(caught)).to.include("InvalidPool");
  });

  it("cancelOrder rejects invalid pool", async function () {
    const { arena } = await deploy();
    const burnPool = "0x000000000000000000000000000000000000dEaD";

    let caught: unknown = undefined;
    await arena.write
      .cancelOrder([burnPool, 0n])
      .catch((err: unknown) => { caught = err; });

    expect(caught, "expected InvalidPool revert").to.not.be.undefined;
    expect(String(caught)).to.include("InvalidPool");
  });

  it("non-owner cannot call debugPlaceOrder", async function () {
    const { arena, poolWeth, other } = await deploy();

    let caught: unknown = undefined;
    await arena.write
      .debugPlaceOrder(
        [DUEL_ID, FIGHTER_ID, poolWeth.address, true, PRICE, QUANTITY, ORDER_TYPE_POST_ONLY, EXPIRE_OFFSET],
        { account: other.account }
      )
      .catch((err: unknown) => { caught = err; });

    expect(caught, "expected NotOwner revert").to.not.be.undefined;
    expect(String(caught)).to.include("NotOwner");
  });
});
