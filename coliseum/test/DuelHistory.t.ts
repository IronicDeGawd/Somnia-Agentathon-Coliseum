import { expect } from "chai";
import hre from "hardhat";

type FighterRecord = {
  wins: number | bigint;
  losses: number | bigint;
  duels: number | bigint;
  cumulativePnl: bigint;
};

type Entry = {
  duelId: bigint;
  fighterA: number;
  fighterB: number;
  winnerSlot: number;
  winnerFighter: number;
  valueA: bigint;
  valueB: bigint;
  pnlA: bigint;
  pnlB: bigint;
  blockNumber: bigint;
};

const UNIT = BigInt("1000000000000000000"); // 1e18
const e = (n: number) => BigInt(n) * UNIT;

describe("DuelHistory", function () {
  // The first wallet client acts as the Arena (the only authorized writer).
  async function deploy() {
    const [arena, other] = await hre.viem.getWalletClients();
    const history = await hre.viem.deployContract("DuelHistory", [arena.account.address]);
    return { history, arena, other };
  }

  // record(duelId, A, B, winnerSlot, valueA, valueB, initial) via the arena client.
  async function record(
    history: Awaited<ReturnType<typeof deploy>>["history"],
    duelId: number,
    a: number,
    b: number,
    winnerSlot: number,
    valueA: bigint,
    valueB: bigint,
    initial: bigint,
  ) {
    await history.write.onResolved([
      BigInt(duelId),
      a,
      b,
      winnerSlot,
      valueA,
      valueB,
      initial,
    ]);
  }

  it("only the arena may call onResolved", async function () {
    const { history, other } = await deploy();
    let err: unknown;
    try {
      await history.write.onResolved(
        [BigInt(1), 0, 1, 0, e(150), e(60), e(100)],
        { account: other.account },
      );
    } catch (e_) {
      err = e_;
    }
    expect(err, "expected a non-arena caller to revert").to.not.be.undefined;
    expect(String(err)).to.include("OnlyArena");
  });

  it("records a win/loss with correct PnL (slot 0 wins)", async function () {
    const { history } = await deploy();
    // initial 100, winner A finishes 150 (+50), loser B finishes 60 (-40).
    await record(history, 1, 0, 1, 0, e(150), e(60), e(100));

    const ra = (await history.read.getFighterRecord([0])) as FighterRecord;
    const rb = (await history.read.getFighterRecord([1])) as FighterRecord;
    expect(Number(ra.wins)).to.equal(1);
    expect(Number(ra.losses)).to.equal(0);
    expect(Number(ra.duels)).to.equal(1);
    expect(ra.cumulativePnl).to.equal(e(50));
    expect(Number(rb.wins)).to.equal(0);
    expect(Number(rb.losses)).to.equal(1);
    expect(rb.cumulativePnl).to.equal(-e(40)); // negative PnL handled
  });

  it("records the slot-1 winner path", async function () {
    const { history } = await deploy();
    // valueA 80 (-20), valueB 120 (+20), winnerSlot 1 → fighter B (index 3) wins.
    await record(history, 2, 2, 3, 1, e(80), e(120), e(100));
    const r2 = (await history.read.getFighterRecord([2])) as FighterRecord;
    const r3 = (await history.read.getFighterRecord([3])) as FighterRecord;
    expect(Number(r2.losses)).to.equal(1);
    expect(r2.cumulativePnl).to.equal(-e(20));
    expect(Number(r3.wins)).to.equal(1);
    expect(r3.cumulativePnl).to.equal(e(20));
  });

  it("is idempotent — recording the same duel twice reverts", async function () {
    const { history } = await deploy();
    await record(history, 1, 0, 1, 0, e(150), e(60), e(100));
    let err: unknown;
    try {
      await record(history, 1, 0, 1, 0, e(150), e(60), e(100));
    } catch (e_) {
      err = e_;
    }
    expect(err, "expected a duplicate record to revert").to.not.be.undefined;
    expect(String(err)).to.include("AlreadyRecorded");
  });

  it("rejects out-of-range fighter indexes", async function () {
    const { history } = await deploy();
    let err: unknown;
    try {
      await record(history, 1, 6, 1, 0, e(150), e(60), e(100));
    } catch (e_) {
      err = e_;
    }
    expect(err, "expected a bad fighter index to revert").to.not.be.undefined;
    expect(String(err)).to.include("BadFighterIndex");
  });

  it("accumulates across duels and exposes a 6-slot leaderboard + ledger", async function () {
    const { history } = await deploy();
    await record(history, 1, 0, 1, 0, e(150), e(60), e(100)); // 0 beats 1
    await record(history, 2, 0, 2, 0, e(130), e(70), e(100)); // 0 beats 2
    await record(history, 3, 1, 0, 0, e(140), e(90), e(100)); // 1 beats 0

    const board = (await history.read.leaderboard()) as FighterRecord[];
    expect(board.length).to.equal(6);
    // fighter 0: 2 wins (duels 1,2), 1 loss (duel 3) → cumulativePnl +50 +30 -10 = +70
    expect(Number(board[0].wins)).to.equal(2);
    expect(Number(board[0].losses)).to.equal(1);
    expect(Number(board[0].duels)).to.equal(3);
    expect(board[0].cumulativePnl).to.equal(e(70));

    const total = (await history.read.totalDuels()) as bigint;
    expect(Number(total)).to.equal(3);

    // Pagination: page of 2 from offset 0, then 1 from offset 2.
    const page1 = (await history.read.getEntries([BigInt(0), BigInt(2)])) as Entry[];
    const page2 = (await history.read.getEntries([BigInt(2), BigInt(2)])) as Entry[];
    expect(page1.length).to.equal(2);
    expect(page2.length).to.equal(1);
    expect(page1[0].duelId).to.equal(BigInt(1));
    expect(page2[0].duelId).to.equal(BigInt(3));

    // Out-of-range offset returns empty.
    const empty = (await history.read.getEntries([BigInt(99), BigInt(5)])) as Entry[];
    expect(empty.length).to.equal(0);

    // Fighter 0 participated in all 3 duels.
    const f0count = (await history.read.fighterEntryCount([0])) as bigint;
    expect(Number(f0count)).to.equal(3);
    const f0entries = (await history.read.getFighterEntries([0, BigInt(0), BigInt(10)])) as Entry[];
    expect(f0entries.length).to.equal(3);
  });
});
