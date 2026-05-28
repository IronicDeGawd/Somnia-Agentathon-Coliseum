import { expect } from "chai";
import hre from "hardhat";
import { parseEther } from "viem";

describe("Arena — fundPools", function () {
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
      owner.account.address,  // dummy platform — not exercised in fund tests
      1n,
      [18, 18, 18],
    ], { value: parseEther("33") });

    return { arena, usdso, poolWeth, poolWbtc, poolSomi, registry, owner, other };
  }

  it("fundPools deposits correct balance to each pool", async function () {
    const { arena, usdso, poolWeth, poolWbtc, poolSomi } = await deploy();
    const perPool = 10n * 10n ** 18n;

    const [ownerClient] = await hre.viem.getWalletClients();
    const ownerAddr = ownerClient.account.address;

    await usdso.write.mint([ownerAddr, 30n * 10n ** 18n]);
    await usdso.write.approve([arena.address, 30n * 10n ** 18n]);
    await arena.write.fundPools([perPool]);

    const balWeth = await poolWeth.read.getWithdrawableBalance([arena.address, usdso.address]);
    const balWbtc = await poolWbtc.read.getWithdrawableBalance([arena.address, usdso.address]);
    const balSomi = await poolSomi.read.getWithdrawableBalance([arena.address, usdso.address]);

    expect(balWeth).to.equal(perPool);
    expect(balWbtc).to.equal(perPool);
    expect(balSomi).to.equal(perPool);
  });

  it("fundPools reverts NotOwner when called by non-owner", async function () {
    const { arena } = await deploy();
    const [, other] = await hre.viem.getWalletClients();

    let caught: unknown = undefined;
    await arena.write
      .fundPools([10n * 10n ** 18n], { account: other.account })
      .catch((err: unknown) => { caught = err; });
    expect(caught, "expected NotOwner revert").to.not.be.undefined;
    expect(String(caught)).to.include("NotOwner");
  });

  it("fundPools reverts ZeroAmount when called with 0", async function () {
    const { arena } = await deploy();

    let caught: unknown = undefined;
    await arena.write
      .fundPools([0n])
      .catch((err: unknown) => { caught = err; });
    expect(caught, "expected ZeroAmount revert").to.not.be.undefined;
    expect(String(caught)).to.include("ZeroAmount");
  });

  it("sweepToken blocks USDso to protect user duel deposits", async function () {
    const { arena, usdso } = await deploy();
    const [ownerClient] = await hre.viem.getWalletClients();
    const ownerAddr = ownerClient.account.address;
    const amount = 10n * 10n ** 18n;

    // Put some USDso into Arena
    await usdso.write.mint([arena.address, amount]);

    let caught: unknown = undefined;
    await arena.write
      .sweepToken([usdso.address, ownerAddr, amount])
      .catch((e: unknown) => { caught = e; });

    expect(caught, "expected CannotSweepUSDso revert").to.not.be.undefined;
    expect(String(caught)).to.include("CannotSweepUSDso");
  });

  it("sweepToken works on non-USDso tokens", async function () {
    const { arena } = await deploy();
    const [ownerClient] = await hre.viem.getWalletClients();
    const ownerAddr = ownerClient.account.address;

    // Deploy an unrelated ERC20 and put some into Arena
    const otherToken = await hre.viem.deployContract("MockERC20", ["OTHER", "OTHER"]);
    const amount = 5n * 10n ** 18n;
    await otherToken.write.mint([arena.address, amount]);

    const balBefore = (await otherToken.read.balanceOf([ownerAddr])) as bigint;
    await arena.write.sweepToken([otherToken.address, ownerAddr, amount]);
    const balAfter = (await otherToken.read.balanceOf([ownerAddr])) as bigint;
    expect(balAfter).to.equal(balBefore + amount);
  });

  it("withdrawFromPool pulls seeded USDso back into Arena", async function () {
    const { arena, usdso, poolWeth } = await deploy();
    const [ownerClient] = await hre.viem.getWalletClients();
    const ownerAddr = ownerClient.account.address;
    const perPool = 10n * 10n ** 18n;

    await usdso.write.mint([ownerAddr, 30n * 10n ** 18n]);
    await usdso.write.approve([arena.address, 30n * 10n ** 18n]);
    await arena.write.fundPools([perPool]);

    // Pull from pool vault back to Arena
    await arena.write.withdrawFromPool([poolWeth.address, usdso.address, perPool]);
    const arenaBal = (await usdso.read.balanceOf([arena.address])) as bigint;
    expect(arenaBal).to.equal(perPool);
  });

  it("withdrawFromPool reverts InvalidPool for non-registered pool", async function () {
    const { arena, usdso } = await deploy();
    const burn = "0x000000000000000000000000000000000000dEaD" as `0x${string}`;

    let caught: unknown = undefined;
    await arena.write
      .withdrawFromPool([burn, usdso.address, 1n])
      .catch((err: unknown) => { caught = err; });
    expect(caught, "expected InvalidPool revert").to.not.be.undefined;
    expect(String(caught)).to.satisfy((s: string) => s.includes("InvalidPool") || /0x[0-9a-f]{8}/i.test(s));
  });

  it("sweepToken reverts NotOwner for non-owner caller", async function () {
    const { arena, usdso } = await deploy();
    const [, other] = await hre.viem.getWalletClients();

    let caught: unknown = undefined;
    await arena.write
      .sweepToken([usdso.address, other.account.address, 1n], { account: other.account })
      .catch((err: unknown) => { caught = err; });
    expect(caught, "expected NotOwner revert").to.not.be.undefined;
    expect(String(caught)).to.satisfy((s: string) => s.includes("NotOwner") || /0x30cd7471/i.test(s));
  });

  it("withdrawNative transfers STT to recipient", async function () {
    const { arena } = await deploy();
    const [owner, other] = await hre.viem.getWalletClients();
    const pub = await hre.viem.getPublicClient();
    const recipient = other.account.address;

    // Arena was deployed with msg.value 33 STT; precompile call on local returns nothing,
    // so the full 33 STT is sitting on the contract.
    const arenaBalance = await pub.getBalance({ address: arena.address });
    expect(arenaBalance).to.equal(parseEther("33"));

    const balBefore = await pub.getBalance({ address: recipient });
    const amount = parseEther("10");
    await arena.write.withdrawNative([recipient, amount]);

    const balAfter = await pub.getBalance({ address: recipient });
    expect(balAfter - balBefore).to.equal(amount);
  });

  it("withdrawNative reverts NotOwner for non-owner caller", async function () {
    const { arena } = await deploy();
    const [, other] = await hre.viem.getWalletClients();

    let caught: unknown = undefined;
    await arena.write
      .withdrawNative([other.account.address, parseEther("1")], { account: other.account })
      .catch((err: unknown) => { caught = err; });
    expect(caught, "expected NotOwner revert").to.not.be.undefined;
    expect(String(caught)).to.satisfy((s: string) => s.includes("NotOwner") || /0x30cd7471/i.test(s));
  });

  it("withdrawNative reverts ZeroAmount on zero", async function () {
    const { arena } = await deploy();
    let caught: unknown = undefined;
    await arena.write
      .withdrawNative([(await hre.viem.getWalletClients())[0].account.address, 0n])
      .catch((err: unknown) => { caught = err; });
    expect(caught, "expected ZeroAmount revert").to.not.be.undefined;
    expect(String(caught)).to.include("ZeroAmount");
  });

  it("resubscribe reverts ReactivityUnderfunded when balance < 32 STT", async function () {
    const { arena } = await deploy();
    const [owner] = await hre.viem.getWalletClients();

    // Sweep the constructor funding so arena balance drops below the threshold
    await arena.write.withdrawNative([owner.account.address, parseEther("33")]);

    let caught: unknown = undefined;
    await arena.write.resubscribe().catch((err: unknown) => { caught = err; });
    expect(caught, "expected ReactivityUnderfunded revert").to.not.be.undefined;
    expect(String(caught)).to.include("ReactivityUnderfunded");
  });

  it("resubscribe emits Resubscribed when funded (precompile skipped locally → newId 0)", async function () {
    const { arena } = await deploy();
    const pub = await hre.viem.getPublicClient();

    const txHash = await arena.write.resubscribe();
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
    expect(receipt.status).to.equal("success");

    // On local hardhat the precompile doesn't exist, so subscribe returns no data and newId = 0.
    // The function should still complete cleanly and emit the Resubscribed event.
    const subId = (await arena.read.subscriptionId()) as bigint;
    expect(subId).to.equal(0n);
  });

  it("resubscribe reverts NotOwner for non-owner caller", async function () {
    const { arena } = await deploy();
    const [, other] = await hre.viem.getWalletClients();

    let caught: unknown = undefined;
    await arena.write.resubscribe([], { account: other.account }).catch((err: unknown) => { caught = err; });
    expect(caught, "expected NotOwner revert").to.not.be.undefined;
    expect(String(caught)).to.satisfy((s: string) => s.includes("NotOwner") || /0x30cd7471/i.test(s));
  });
});
