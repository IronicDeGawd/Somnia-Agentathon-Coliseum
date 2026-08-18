import { expect } from "chai";
import hre from "hardhat";
import {
  parseEther, maxUint256, keccak256, toHex, pad, numberToHex,
  encodeFunctionData, decodeEventLog, type Hex,
} from "viem";

import { deployArenaWithParts } from "./helpers/arena";

/**
 * Arena — one-shot Reactivity ticks.
 *
 * A subscription with a zero in its second topic fires on EVERY block: ~10.5 times
 * a second, measured at ~31 STT/hour whether a fight was running or the arena was
 * empty. Put a block NUMBER there and it fires once, at that block, for 0.0045 STT.
 * Everything here is about that one field, and about not paying for it while idle.
 *
 * WHAT THESE TESTS CAN AND CANNOT SEE, and why:
 *
 * The reactivity precompile lives at 0x…0100, and a local node will not execute code
 * installed at that exact address — measured: hardhat_setCode there sticks
 * (eth_getCode returns the code) but every call to it returns empty. Neighbouring
 * addresses (0x…00ff, 0x…0101) run fine, so a mock precompile cannot stand in
 * without changing the address Arena compiles in, which would leave the real path
 * untested.
 *
 * A call to an address that does not execute SUCCEEDS and returns nothing, which
 * Arena reads as "precompile unavailable" — so locally every subscribe yields id
 * zero, and subscriptionId / armedForBlock stay zero no matter what happens.
 *
 * What is asserted here is therefore the half computed on our side and announced in
 * the TickArmed event: WHICH block gets asked for, and whether a tick is asked for
 * at all. That covers the two ways this change goes wrong quietly — a zero target
 * block (back to paying by the second) and a missing re-arm (a fight that stops
 * advancing). The bookkeeping that needs a real subscription id back — skipping a
 * re-arm that is already correct, and cancelling on the way out — is verified on
 * testnet; see context/plan/reactivity-oneshot-ticks.md.
 */

const PRECOMPILE = "0x0000000000000000000000000000000000000100" as const;
const BLOCK_TICK = keccak256(toHex("BlockTick(uint64)"));

const FIGHTER_A = 0;
const FIGHTER_B = 1;
const TURNS_3   = 3;

/** Long enough that "a multiple of the interval" and "the block armed for" differ. */
const INTERVAL = 10n;

/** duels() tuple index of lastTurnBlock — the auto-getter skips uint8[2] lastAction. */
const LAST_TURN_BLOCK = 4;

const TICK_ARMED_ABI = [{
  type: "event",
  name: "TickArmed",
  inputs: [
    { name: "targetBlock", type: "uint64", indexed: false },
    { name: "subscriptionId", type: "uint256", indexed: false },
  ],
}] as const;

const ON_EVENT_ABI = [{
  type: "function",
  name: "onEvent",
  inputs: [
    { name: "emitter", type: "address" },
    { name: "eventTopics", type: "bytes32[]" },
    { name: "data", type: "bytes" },
  ],
  outputs: [],
  stateMutability: "nonpayable",
}] as const;

async function mineBlock(n = 1) {
  for (let i = 0; i < n; i++) await hre.network.provider.send("evm_mine", []);
}

async function blockNumber(): Promise<bigint> {
  return (await hre.viem.getPublicClient()).getBlockNumber();
}

async function mineUntil(target: bigint) {
  while ((await blockNumber()) < target) await mineBlock();
}

/** Every block number a transaction asked for a tick at. */
async function armedTargets(hash: Hex): Promise<bigint[]> {
  const publicClient = await hre.viem.getPublicClient();
  const receipt = await publicClient.getTransactionReceipt({ hash });
  const out: bigint[] = [];
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: TICK_ARMED_ABI, ...log });
      out.push((decoded.args as unknown as { targetBlock: bigint }).targetBlock);
    } catch {
      // Any other event from the same transaction.
    }
  }
  return out;
}

/** Fire one BlockTick at Arena, as the precompile, naming `atBlock` in topic 1. */
async function fireTick(arena: { address: Hex }, atBlock: bigint): Promise<Hex> {
  await hre.network.provider.send("hardhat_impersonateAccount", [PRECOMPILE]);
  await hre.network.provider.send("hardhat_setBalance", [
    PRECOMPILE,
    "0x" + parseEther("100").toString(16),
  ]);
  const hash: Hex = await hre.network.provider.send("eth_sendTransaction", [{
    from: PRECOMPILE,
    to: arena.address,
    data: encodeFunctionData({
      abi: ON_EVENT_ABI,
      functionName: "onEvent",
      args: [PRECOMPILE, [BLOCK_TICK, pad(numberToHex(atBlock), { size: 32 })], "0x"],
    }),
    // The reactive path snapshots prices and fires two inference requests. Capped
    // at the local node's per-transaction ceiling, which is below the 15M the live
    // subscription asks for.
    gas: "0xf00000",
  }]);
  return hash;
}

async function deploy() {
  const [owner] = await hre.viem.getWalletClients();
  const registry     = await hre.viem.deployContract("FighterRegistry");
  const usdso        = await hre.viem.deployContract("MockERC20", ["USDso", "USDso"]);
  const poolWeth     = await hre.viem.deployContract("MockSpotPool");
  const poolWbtc     = await hre.viem.deployContract("MockSpotPool");
  const poolSomi     = await hre.viem.deployContract("MockSpotPool");
  const mockPlatform = await hre.viem.deployContract("MockPlatform");

  const { arena } = await deployArenaWithParts(hre, [
    registry.address,
    usdso.address,
    poolWeth.address,
    poolWbtc.address,
    poolSomi.address,
    mockPlatform.address,
    INTERVAL,
    [18, 18, 18],
  ], { value: parseEther("33") });

  await hre.network.provider.send("hardhat_setBalance", [
    arena.address,
    "0x" + parseEther("100").toString(16),
  ]);

  await usdso.write.mint([owner.account.address, parseEther("100000")]);
  await usdso.write.approve([arena.address, maxUint256]);

  return { arena, usdso, mockPlatform, owner };
}

type Arena = Awaited<ReturnType<typeof deploy>>["arena"];
/** reactivityStatus() → (on, armedFor, subId, nextDue) */
type Status = readonly [boolean, bigint, bigint, bigint];

async function lastTurnBlockOf(arena: Arena, duelId: bigint): Promise<bigint> {
  const duel = (await arena.read.duels([duelId])) as readonly unknown[];
  return duel[LAST_TURN_BLOCK] as bigint;
}

describe("Arena — one-shot Reactivity ticks", function () {
  this.timeout(60_000);

  it("asks for the block a turn is due at, never for every block", async function () {
    const { arena } = await deploy();
    await arena.write.resubscribe();

    const hash = await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_3, false]);
    const due  = (await lastTurnBlockOf(arena, 1n)) + INTERVAL;

    const targets = await armedTargets(hash);
    expect(targets, "startDuel must arm exactly one tick").to.have.lengthOf(1);
    // A zero here is the every-block subscription, which is the whole cost this
    // change exists to remove.
    expect(targets[0]).to.equal(due);
    expect(targets[0]).to.not.equal(0n);

    const status = (await arena.read.reactivityStatus()) as Status;
    expect(status[0], "switched on").to.equal(true);
    expect(status[3], "nextDue").to.equal(due);
  });

  it("asks for nothing while reactivity is switched off", async function () {
    const { arena } = await deploy();

    const startHash = await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_3, false]);
    expect(await armedTargets(startHash)).to.have.lengthOf(0);

    await mineBlock(Number(INTERVAL) + 1);
    const turnHash = await arena.write.turn([1n]);
    expect(await armedTargets(turnHash)).to.have.lengthOf(0);

    const status = (await arena.read.reactivityStatus()) as Status;
    expect(status[0]).to.equal(false);
    expect(status[1]).to.equal(0n);
  });

  it("a firing at the armed block advances the duel and books the next one", async function () {
    const { arena } = await deploy();
    await arena.write.resubscribe();
    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_3, false]);

    const before = await lastTurnBlockOf(arena, 1n);
    const armed  = before + INTERVAL;

    await mineUntil(armed);
    const hash = await fireTick(arena, armed);

    const after = await lastTurnBlockOf(arena, 1n);
    expect(after, "lastTurnBlock advanced").to.be.greaterThan(before);

    // The firing is spent. Without a fresh one booked here the chain ends and the
    // fight sits still until the keeper notices.
    const targets = await armedTargets(hash);
    expect(targets, "the firing must book the next one").to.have.lengthOf(1);
    expect(targets[0]).to.equal(after + INTERVAL);
    expect(targets[0]).to.be.greaterThan(armed);
  });

  it("acts on a firing whose block is not a multiple of the turn interval", async function () {
    const { arena } = await deploy();
    await arena.write.resubscribe();
    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_3, false]);

    const before = await lastTurnBlockOf(arena, 1n);

    // Past due AND not a multiple of the interval. The old every-block subscription
    // discarded exactly these firings; against a named target block that check would
    // throw away nearly every firing we pay for.
    let target = before + INTERVAL;
    while (target % INTERVAL === 0n) target += 1n;
    await mineUntil(target);
    await fireTick(arena, target);

    expect(await lastTurnBlockOf(arena, 1n)).to.be.greaterThan(before);
  });

  it("aims at whichever of two running duels is due soonest", async function () {
    const { arena } = await deploy();
    await arena.write.resubscribe();

    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_3, false]);
    const firstDue = (await lastTurnBlockOf(arena, 1n)) + INTERVAL;

    // A second duel started later is due later, so it must not steal the tick —
    // that would leave the first fight waiting on a firing that comes too late.
    await mineBlock(3);
    const secondHash = await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_3, false]);
    const secondDue  = (await lastTurnBlockOf(arena, 2n)) + INTERVAL;
    expect(secondDue, "second duel is genuinely due later").to.be.greaterThan(firstDue);

    expect((await armedTargets(secondHash))[0], "still the earlier deadline").to.equal(firstDue);
    expect(((await arena.read.reactivityStatus()) as Status)[3]).to.equal(firstDue);

    // Advance duel 1 only. Duel 2 now holds the earliest deadline, so the tick moves.
    await mineUntil(firstDue);
    const tickHash = await fireTick(arena, firstDue);
    expect((await armedTargets(tickHash))[0], "now aimed at duel 2").to.equal(secondDue);
  });

  it("a keeper-driven turn re-arms, so the watchdog does not end the chain", async function () {
    const { arena } = await deploy();
    await arena.write.resubscribe();
    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_3, false]);

    await mineBlock(Number(INTERVAL) + 2);
    const hash = await arena.write.turn([1n]);

    const targets = await armedTargets(hash);
    expect(targets, "turn() must re-arm").to.have.lengthOf(1);
    expect(targets[0]).to.equal((await lastTurnBlockOf(arena, 1n)) + INTERVAL);
  });

  it("stops asking once the last running duel is gone", async function () {
    const { arena } = await deploy();
    await arena.write.resubscribe();
    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_3, false]);

    // Force the fight to end without playing it out — what is under test is that
    // nothing is armed afterwards, not how it ended.
    await mineBlock(1001);
    const hash = await arena.write.emergencyFinalize([1n]);

    expect(await armedTargets(hash), "an empty arena must arm nothing").to.have.lengthOf(0);

    const status = (await arena.read.reactivityStatus()) as Status;
    expect(status[3], "nothing due").to.equal(0n);
    expect(status[1], "nothing armed").to.equal(0n);
    expect(status[0], "still switched on, just idle").to.equal(true);
  });

  it("disableReactivity hands turns back to the keeper", async function () {
    const { arena } = await deploy();
    await arena.write.resubscribe();
    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_3, false]);

    await arena.write.disableReactivity();
    const status = (await arena.read.reactivityStatus()) as Status;
    expect(status[0]).to.equal(false);
    expect(status[1]).to.equal(0n);

    await mineBlock(Number(INTERVAL) + 2);
    const hash = await arena.write.turn([1n]);
    expect(await armedTargets(hash), "nothing armed while off").to.have.lengthOf(0);
  });

  it("resubscribe still refuses below the subscription minimum", async function () {
    const { arena } = await deploy();
    await hre.network.provider.send("hardhat_setBalance", [
      arena.address,
      "0x" + parseEther("32").toString(16),
    ]);

    let caught: unknown;
    await arena.write.resubscribe().catch((e: unknown) => { caught = e; });
    expect(caught, "expected ReactivityUnderfunded").to.not.be.undefined;
    expect(String(caught)).to.satisfy(
      (s: string) => s.includes("ReactivityUnderfunded") || /0x[0-9a-f]{8}/.test(s),
    );
  });

  it("only the precompile can fire a tick", async function () {
    const { arena, owner } = await deploy();
    await arena.write.resubscribe();
    await arena.write.startDuel([FIGHTER_A, FIGHTER_B, TURNS_3, false]);

    const before = await lastTurnBlockOf(arena, 1n);
    await mineBlock(Number(INTERVAL) + 2);

    // Public access would let an attacker time turns around pool manipulation.
    const hash = await owner.sendTransaction({
      to: arena.address,
      data: encodeFunctionData({
        abi: ON_EVENT_ABI,
        functionName: "onEvent",
        args: [PRECOMPILE, [BLOCK_TICK, pad(numberToHex(await blockNumber()), { size: 32 })], "0x"],
      }),
    });

    expect(await armedTargets(hash)).to.have.lengthOf(0);
    expect(await lastTurnBlockOf(arena, 1n), "no turn advanced").to.equal(before);
  });
});
