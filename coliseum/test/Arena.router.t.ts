import { expect } from "chai";
import hre from "hardhat";
import { parseEther, maxUint256, toFunctionSelector, encodeFunctionData } from "viem";

import { deployArenaWithParts } from "./helpers/arena";

/**
 * Arena is one address made of several contracts: a router that holds the
 * storage and the money, and parts whose code runs against that storage.
 *
 * These tests cover the seams that only exist because of that arrangement —
 * the places where a mistake would be silent rather than loud.
 */

const VIEW_SELECTORS = [
  "hasCapacity()",
  "activeDuelId()",
  "getActiveDuelIds()",
  "duelsReadyForTurn()",
  "minDepositFor(uint16)",
  "minDepositForMarket(uint16,bool)",
  "previewTurnPrompt(uint256,uint8)",
] as const;

/** Signatures Matchmaker, Bookmaker or the frontend call on Arena's address. */
const EXTERNAL_SELECTORS = [
  "duels(uint256)",
  "platformFee(uint16)",
  "startDuel(uint8,uint8,uint16,bool)",
  "finalizeDuel(uint256)",
  "recoverFunds(uint256)",
  "fundPools(uint256)",
  "setSimPools(address,address,address,uint8[3])",
  "setDuelHistory(address)",
  "turn(uint256)",
  "expireTurn(uint256)",
  // The inference platform's callback. Its shape is dictated by the platform,
  // so it is pinned here: if it ever stops resolving, fighters silently stop
  // moving and every duel drifts to a draw.
  "handleFighterResponse(uint256,(address,bytes,uint8,uint256,uint256,uint256)[],uint8,"
    + "(uint256,address,address,bytes4,address[],(address,bytes,uint8,uint256,uint256,uint256)[],"
    + "uint256,uint256,uint256,uint256,uint256,uint8,uint8,uint256,uint256))",
] as const;

async function deploy() {
  const [owner] = await hre.viem.getWalletClients();
  const registry     = await hre.viem.deployContract("FighterRegistry");
  const usdso        = await hre.viem.deployContract("MockERC20", ["USDso", "USDso"]);
  const poolWeth     = await hre.viem.deployContract("MockSpotPool");
  const poolWbtc     = await hre.viem.deployContract("MockSpotPool");
  const poolSomi     = await hre.viem.deployContract("MockSpotPool");
  const mockPlatform = await hre.viem.deployContract("MockPlatform");

  const { arena, viewPart, router, parts } = await deployArenaWithParts(hre, [
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
    "0x" + parseEther("100").toString(16),
  ]);
  await usdso.write.mint([owner.account.address, parseEther("100000")]);
  await usdso.write.approve([arena.address, maxUint256]);

  return { arena, viewPart, router, parts, usdso, owner };
}

describe("Arena — routing to parts", function () {
  this.timeout(120_000);

  it("runs the part's code against the router's storage, not the part's own", async function () {
    const { arena, viewPart } = await deploy();

    // Identical while both are empty.
    expect(await arena.read.activeDuelId()).to.equal(0n);
    expect(await viewPart.read.activeDuelId()).to.equal(0n);

    await arena.write.startDuel([0, 1, 3, false]);

    // The duel was written to the ROUTER's storage. Asking the router routes the
    // read there and finds it; asking the part at its own address finds its own
    // storage, which nothing ever writes to. That gap is the whole mechanism.
    expect(await arena.read.activeDuelId(), "router sees the duel").to.equal(1n);
    expect(await viewPart.read.activeDuelId(), "the part's own storage stays empty").to.equal(0n);
    expect(await viewPart.read.getActiveDuelIds()).to.deep.equal([]);
  });

  it("keeps routed reads correct once a duel is running", async function () {
    const { arena } = await deploy();
    await arena.write.startDuel([0, 1, 3, false]);

    const ids = await arena.read.getActiveDuelIds() as bigint[];
    expect(ids.length).to.equal(1);
    expect(await arena.read.activeDuelId()).to.equal(ids[0]);
    expect(await arena.read.hasCapacity()).to.equal(true); // 1 of 3 slots used
  });

  it("reverts an unclaimed selector instead of quietly succeeding", async function () {
    const { arena } = await deploy();
    const publicClient = await hre.viem.getPublicClient();

    // A well-formed call to a function no part claims.
    const data = encodeFunctionData({
      abi: [{
        type: "function", name: "notAThing", stateMutability: "view",
        inputs: [], outputs: [{ type: "uint256" }],
      }],
      functionName: "notAThing",
    });

    let caught: unknown;
    await publicClient.call({ to: arena.address, data }).catch((e: unknown) => { caught = e; });
    expect(caught, "an unrouted call must revert, not return empty").to.not.be.undefined;
    expect(String(caught)).to.include("NoPart");
  });

  it("refuses to wire a selector to an address holding no code", async function () {
    const { router, owner } = await deploy();
    const sel = toFunctionSelector("hasCapacity()");

    let caught: unknown;
    // A plain wallet: delegatecall to it would SUCCEED and return nothing.
    await router.write.setPart([[sel], owner.account.address])
      .catch((e: unknown) => { caught = e; });
    expect(caught, "wiring to a codeless address must revert").to.not.be.undefined;
    expect(String(caught)).to.include("PartHasNoCode");
  });

  it("refuses to rewire while a duel is running", async function () {
    const { router, viewPart, arena } = await deploy();
    await arena.write.startDuel([0, 1, 3, false]);

    let caught: unknown;
    await router.write.setPart([[toFunctionSelector("hasCapacity()")], viewPart.address])
      .catch((e: unknown) => { caught = e; });
    expect(caught, "rewiring mid-duel must revert").to.not.be.undefined;
    expect(String(caught)).to.include("ArenaNotEmpty");
  });

  it("refuses to rewire while a deposit is still escrowed, even after the duel resolves", async function () {
    const { router, viewPart, arena } = await deploy();
    await arena.write.startDuel([0, 1, 3, false]);
    const duelId = await arena.read.activeDuelId() as bigint;

    // Force the duel out of the active list without paying the creator back, so
    // the only thing still blocking a rewire is the escrowed money.
    await hre.network.provider.send("hardhat_mine", ["0x3e9"]); // > EMERGENCY_FINALIZE_BLOCKS
    await arena.write.emergencyFinalize([duelId]);
    expect(await arena.read.getActiveDuelIds()).to.deep.equal([]);
    expect(await arena.read.escrowedPot()).to.be.greaterThan(0n);

    let caught: unknown;
    await router.write.setPart([[toFunctionSelector("hasCapacity()")], viewPart.address])
      .catch((e: unknown) => { caught = e; });
    expect(caught, "escrowed funds must block a rewire").to.not.be.undefined;
    expect(String(caught)).to.include("ArenaNotEmpty");

    // Once the creator is paid out, the arena is genuinely empty and rewiring works.
    await arena.write.recoverFunds([duelId]);
    expect(await arena.read.escrowedPot()).to.equal(0n);
    await router.write.setPart([[toFunctionSelector("hasCapacity()")], viewPart.address]);
  });

  it("only the owner may rewire", async function () {
    const { router, viewPart } = await deploy();
    const [, stranger] = await hre.viem.getWalletClients();

    let caught: unknown;
    await router.write.setPart(
      [[toFunctionSelector("hasCapacity()")], viewPart.address],
      { account: stranger.account },
    ).catch((e: unknown) => { caught = e; });
    expect(caught, "a stranger must not rewire Arena").to.not.be.undefined;
    // Matched by 4-byte code rather than name: a call sent from an explicit
    // account skips simulation, so the revert arrives raw and undecoded.
    expect(String(caught)).to.include(toFunctionSelector("NotOwner()"));
  });

  it("unrouting a selector makes it revert again", async function () {
    const { router, arena } = await deploy();
    const sel = toFunctionSelector("hasCapacity()");
    expect(await arena.read.hasCapacity()).to.equal(true);

    await router.write.setPart([[sel], "0x0000000000000000000000000000000000000000"]);

    let caught: unknown;
    await arena.read.hasCapacity().catch((e: unknown) => { caught = e; });
    expect(caught, "an unrouted selector must revert").to.not.be.undefined;
    expect(String(caught)).to.include("NoPart");
  });

  it("events raised by a part are emitted from Arena's own address", async function () {
    // The frontend and the indexer watch one address and filter by event
    // signature. A part emits while running as the router, so its logs must
    // carry the ROUTER's address — if they carried the part's, every duel would
    // vanish from the site the moment a part moved.
    const { arena, router, parts } = await deploy();
    const publicClient = await hre.viem.getPublicClient();

    // startDuel lives on the duel part and raises DuelStarted.
    const tx = await arena.write.startDuel([0, 1, 3, false]);
    const receipt = await publicClient.getTransactionReceipt({ hash: tx });

    const fromArena = receipt.logs.filter(
      (l) => l.address.toLowerCase() === router.address.toLowerCase(),
    );
    expect(fromArena.length, "the duel's own events come from Arena").to.be.greaterThan(0);

    const partAddresses = new Set(Object.values(parts).map((a) => a.toLowerCase()));
    for (const log of receipt.logs) {
      expect(partAddresses.has(log.address.toLowerCase()),
        `no log may come from a part's own address (${log.address})`).to.equal(false);
    }
  });

  it("every function the outside world calls is reachable", async function () {
    const { arena, router } = await deploy();
    const routerAbi = (await hre.artifacts.readArtifact("Arena")).abi;
    const onRouter = new Set(
      routerAbi.filter((e) => e.type === "function")
        .map((e) => toFunctionSelector(e as never)),
    );

    // Every signature Matchmaker, Bookmaker or the frontend calls must resolve
    // somewhere — implemented by the router, or claimed by a part. Which of the
    // two is an implementation detail that may change as parts move; being
    // reachable is the contract with the outside world.
    for (const sig of [...VIEW_SELECTORS, ...EXTERNAL_SELECTORS]) {
      const sel = toFunctionSelector(sig);
      const routed = await router.read.partOf([sel]) as string;
      const reachable = onRouter.has(sel)
        || routed !== "0x0000000000000000000000000000000000000000";
      expect(reachable, `${sig} must be callable on Arena`).to.equal(true);
    }

    // The duel record must keep its exact shape. The struct has 14 members; the
    // generated reader omits the fixed-size lastAction array, leaving 13. Both
    // Bookmaker and Matchmaker declare only the first 12 and ignore the rest, so
    // status must stay at position 8 and winnerSlot at position 11 — inserting a
    // field anywhere before those would silently feed them the wrong values.
    await arena.write.startDuel([0, 1, 3, false]);
    const duel = await arena.read.duels([1n]) as unknown[];
    expect(duel.length, "duel reader is 13 fields wide").to.equal(13);
    expect(duel[8], "status sits at position 8").to.equal(1);      // Active
    expect(duel[11], "winnerSlot sits at position 11").to.equal(255); // unset
  });
});
