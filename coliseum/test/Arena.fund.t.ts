import { expect } from "chai";
import hre from "hardhat";

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
    ]);

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
});
