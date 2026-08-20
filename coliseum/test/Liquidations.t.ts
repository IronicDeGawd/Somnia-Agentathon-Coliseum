import { expect } from "chai";
import { liquidationRecords, liquidationWord } from "../frontend/lib/liquidations";

/**
 * Reading a liquidation back off the venue.
 *
 * WHY THIS IS TESTED AGAINST INVENTED LOGS. No liquidation has ever happened to one
 * of our fighters — and measured over 150,000 blocks, none has happened to anyone
 * else on this venue either. So there is no real event to point the code at, and the
 * alternative to synthetic logs is shipping a path that has never once executed.
 *
 * The attribution rule is the dangerous part, and it is the reason this file exists.
 * There are eight rented trading accounts and they are handed out and taken back
 * fight after fight, so an account address on its own says nothing about WHICH fight
 * a liquidation belongs to. Attribute loosely and a fight would display somebody
 * else's disaster as its own.
 */
describe("liquidation records — reading the venue's own account of what it did", function () {
  const log = (account: string, before: number, after: number, block: number, positions = 1, stage = 1) => ({
    blockNumber: BigInt(block),
    args: {
      account,
      positionsProcessed: BigInt(positions),
      stageReached: stage,
      marginStatusBefore: before,
      marginStatusAfter: after,
    },
  });

  const leases = (entries: [string, number][]) =>
    new Map<string, number>(entries.map(([a, f]) => [a.toLowerCase(), f]));

  it("attributes a liquidation to the fighter who rented that account", function () {
    const got = liquidationRecords(
      [log("0xAAA", 3, 0, 100)],
      leases([["0xaaa", 1]]),
    );
    expect(got).to.have.length(1);
    expect(got[0].fighterId).to.equal(1);
    expect(got[0].statusBefore).to.equal(3);
    expect(got[0].statusAfter).to.equal(0);
  });

  it("matches the account whatever case the log reports it in", function () {
    // A log's address casing is not something to rely on, and a case-sensitive
    // compare has already cost real time elsewhere in this project.
    expect(liquidationRecords([log("0xAbCdEf", 2, 0, 100)], leases([["0xABCDEF", 0]])))
      .to.have.length(1);
  });

  it("DROPS a liquidation on an account this fight never rented", function () {
    // The whole point. These accounts are reused, so an unattributable event belongs
    // to another fight and showing it here would invent a disaster that never
    // happened to these fighters.
    expect(liquidationRecords([log("0xSTRANGER", 3, 0, 100)], leases([["0xaaa", 0]])))
      .to.deep.equal([]);
  });

  it("keeps both fighters when both were liquidated", function () {
    const got = liquidationRecords(
      [log("0xAAA", 1, 0, 100), log("0xBBB", 2, 0, 120)],
      leases([["0xaaa", 0], ["0xbbb", 1]]),
    );
    expect(got.map((r) => r.fighterId)).to.deep.equal([0, 1]);
  });

  it("orders by block, so the timeline reads in the order things happened", function () {
    const got = liquidationRecords(
      [log("0xAAA", 1, 0, 300), log("0xAAA", 2, 0, 100), log("0xAAA", 3, 0, 200)],
      leases([["0xaaa", 0]]),
    );
    expect(got.map((r) => Number(r.block))).to.deep.equal([100, 200, 300]);
  });

  it("carries how far the venue had to go", function () {
    const got = liquidationRecords([log("0xAAA", 3, 0, 100, 2, 4)], leases([["0xaaa", 0]]));
    expect(got[0].positions).to.equal(2);
    expect(got[0].stage).to.equal(4);
  });

  it("has no timestamp until one is asked for", function () {
    // Never inferred from the block number. A fight can stall, so arithmetic on
    // block deltas would print a time that never happened.
    expect(liquidationRecords([log("0xAAA", 1, 0, 100)], leases([["0xaaa", 0]]))[0].timestamp)
      .to.equal(undefined);
  });

  it("says how many positions the venue closed", function () {
    const one = { fighterId: 0, statusBefore: 3, statusAfter: 0, positions: 1, stage: 1, block: BigInt(1) };
    expect(liquidationWord(one)).to.equal("LIQUIDATED · position closed");
    expect(liquidationWord({ ...one, positions: 3 })).to.equal("LIQUIDATED · 3 positions closed");
  });

  it("nothing in, nothing out", function () {
    // An empty result is the EXPECTED result on this venue today, and must not be
    // treated as a failure by anything downstream.
    expect(liquidationRecords([], leases([["0xaaa", 0]]))).to.deep.equal([]);
  });
});
