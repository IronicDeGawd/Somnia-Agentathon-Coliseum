import { expect } from "chai";
import hre from "hardhat";
import { parseEther, maxUint256 } from "viem";

// duels() tuple field indices — Solidity auto-getter for struct-in-mapping skips
// fixed-size arrays (lastAction uint8[2]), so the returned tuple is:
// 0 fighterA, 1 fighterB, 2 creator, 3 startBlock, 4 lastTurnBlock,
// 5 completedCallbacks, 6 turns, 7 poolMask, 8 status,
// 9 initialUsdsoPerFighter, 10 fundsRecovered, 11 winnerSlot, 12 simulated
const D = {
  fighterA:               0,
  fighterB:               1,
  creator:                2,
  startBlock:             3,
  lastTurnBlock:          4,
  completedCallbacks:     5,
  turns:                  6,
  poolMask:               7,
  status:                 8,
  initialUsdsoPerFighter: 9,
  fundsRecovered:         10,
  winnerSlot:             11,
  simulated:              12,
} as const;

const FIGHTER_A = 0;
const FIGHTER_B = 1;
const TURNS_3   = 3;

async function deploy() {
  const [owner, other] = await hre.viem.getWalletClients();
  const registry     = await hre.viem.deployContract("FighterRegistry");
  const usdso        = await hre.viem.deployContract("MockERC20", ["USDso", "USDso"]);
  const poolWeth     = await hre.viem.deployContract("MockSpotPool");
  const poolWbtc     = await hre.viem.deployContract("MockSpotPool");
  const poolSomi     = await hre.viem.deployContract("MockSpotPool");
  const mockPlatform = await hre.viem.deployContract("MockPlatform");

  const arena = await hre.viem.deployContract("Arena", [
    registry.address,
    usdso.address,
    poolWeth.address,
    poolWbtc.address,
    poolSomi.address,
    mockPlatform.address,
    1n,
    [18, 18, 18],
  ], { value: parseEther("33") });

  await hre.network.provider.send("hardhat_setBalance", [
    arena.address,
    "0x" + parseEther("43").toString(16),
  ]);

  await usdso.write.mint([owner.account.address, parseEther("100000")]);
  await usdso.write.approve([arena.address, maxUint256]);

  return { arena, usdso, poolWeth, poolWbtc, poolSomi, owner, other };
}

// Deploy 3 fresh sim pools with poolParams, markPrice, and book levels configured.
async function deploySimPools(usdsoAddr: `0x${string}`) {
  const simWeth = await hre.viem.deployContract("MockSpotPool");
  const simWbtc = await hre.viem.deployContract("MockSpotPool");
  const simSomi = await hre.viem.deployContract("MockSpotPool");

  const price = 1000n * 10n ** 18n;
  const qty   = 10n ** 21n;

  for (const pool of [simWeth, simWbtc, simSomi]) {
    await pool.write.setPoolParams([
      "0x0000000000000000000000000000000000000000" as `0x${string}`,
      usdsoAddr,
      1n * 10n ** 15n,
      1n * 10n ** 15n,
      1n,
    ]);
    await pool.write.setMarkPrice([price]);
    await pool.write.setBookLevel([true,  price, qty]); // bid
    await pool.write.setBookLevel([false, price, qty]); // ask
  }

  return { simWeth, simWbtc, simSomi };
}

describe("Arena — simulated market", function () {
  this.timeout(60_000);

  it("setSimPools reverts for a non-owner", async function () {
    const { arena, other } = await deploy();
    const simWeth = await hre.viem.deployContract("MockSpotPool");
    const simWbtc = await hre.viem.deployContract("MockSpotPool");
    const simSomi = await hre.viem.deployContract("MockSpotPool");

    let caught: unknown = undefined;
    await arena.write
      .setSimPools([simWeth.address, simWbtc.address, simSomi.address, [18, 18, 18]], {
        account: other.account,
      })
      .catch((e: unknown) => { caught = e; });

    expect(caught, "expected NotOwner revert").to.not.be.undefined;
    expect(String(caught)).to.satisfy(
      (s: string) => s.includes("NotOwner") || /0x[0-9a-f]{8}/.test(s),
    );
  });

  it("setSimPools by owner sets SIM_POOL_* addresses and flips simPoolsSet", async function () {
    const { arena, usdso } = await deploy();
    const { simWeth, simWbtc, simSomi } = await deploySimPools(usdso.address);

    expect(await arena.read.simPoolsSet()).to.equal(false);

    await arena.write.setSimPools([
      simWeth.address, simWbtc.address, simSomi.address,
      [18, 18, 18],
    ]);

    expect(await arena.read.simPoolsSet()).to.equal(true);
    expect((await arena.read.SIM_POOL_WETH() as string).toLowerCase())
      .to.equal(simWeth.address.toLowerCase());
    expect((await arena.read.SIM_POOL_WBTC() as string).toLowerCase())
      .to.equal(simWbtc.address.toLowerCase());
    expect((await arena.read.SIM_POOL_SOMI() as string).toLowerCase())
      .to.equal(simSomi.address.toLowerCase());
  });

  it("fundSimPools reverts when called before setSimPools", async function () {
    const { arena, usdso } = await deploy();
    // simPoolsSet is still false — fundSimPools should revert with InvalidPool
    let caught: unknown = undefined;
    await arena.write.fundSimPools([parseEther("7")]).catch((e: unknown) => { caught = e; });

    expect(caught, "expected InvalidPool revert").to.not.be.undefined;
    expect(String(caught)).to.include("InvalidPool");
  });

  it("startDuel with simulated=true reverts when simPoolsSet is false", async function () {
    const { arena } = await deploy();

    let caught: unknown = undefined;
    await arena.write
      .startDuel([FIGHTER_A, FIGHTER_B, TURNS_3, true])
      .catch((e: unknown) => { caught = e; });

    expect(caught, "expected InvalidPool revert").to.not.be.undefined;
    expect(String(caught)).to.include("InvalidPool");
  });

  it("full happy path: setSimPools + fundSimPools + startDuel(simulated=true) succeeds", async function () {
    const { arena, usdso } = await deploy();
    const { simWeth, simWbtc, simSomi } = await deploySimPools(usdso.address);

    await arena.write.setSimPools([
      simWeth.address, simWbtc.address, simSomi.address,
      [18, 18, 18],
    ]);

    // Approve usdsoPerPool × 3 for fundSimPools, then fund.
    const usdsoPerPool = parseEther("7");
    await usdso.write.approve([arena.address, maxUint256]);
    await arena.write.fundSimPools([usdsoPerPool]);

    // Approve for startDuel and start a 3-turn simulated duel (SOMI-only tier).
    await usdso.write.approve([arena.address, maxUint256]);
    const tx = await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_3, true]);

    const publicClient = await hre.viem.getPublicClient();
    const receipt = await publicClient.getTransactionReceipt({ hash: tx });
    expect(receipt.status).to.equal("success");

    const duelId = await arena.read.activeDuelId() as bigint;
    expect(duelId).to.be.greaterThan(0n);

    const duelState = await arena.read.duels([duelId]) as unknown[];
    expect(duelState[D.simulated]).to.equal(true, "duels[id].simulated should be true");
  });

  it("real-market duel has simulated=false at tuple index 13", async function () {
    const { arena } = await deploy();

    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_3, false]);

    const duelId = await arena.read.activeDuelId() as bigint;
    expect(duelId).to.be.greaterThan(0n);

    const duelState = await arena.read.duels([duelId]) as unknown[];
    expect(duelState[D.simulated]).to.equal(false, "duels[id].simulated should be false for real-market duel");
  });
});
