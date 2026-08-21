import { expect } from "chai";
import { newestFirst } from "../frontend/lib/timelineOrder";

/**
 * Ordering a fight's timeline, where the rows do not agree on how to measure time.
 *
 * WHY THIS IS A FILE OF ITS OWN RATHER THAN A ONE-LINE SORT. The first version was
 * the one-line sort, and it was wrong in a way nothing on screen announced. It gave
 * each row a single number — the wall-clock time if it had one, the BLOCK NUMBER if
 * it did not — and compared those. A block height counts blocks since the chain
 * began; a timestamp counts seconds since 1970, and is roughly ten times larger. So
 * any move still waiting for its clock sank below every move that had one: round
 * twelve could sit under round one, and a margin sighting floated to the top of a
 * finished fight because a sighting is stamped in seconds from the moment it is made.
 *
 * The rows genuinely know different things, which is the whole difficulty. A move or
 * a liquidation is a chain event — its block is known the instant it lands and never
 * changes, while its wall-clock time has to be fetched afterwards and may never
 * arrive. A margin sighting is the mirror image: it has no block, because nothing
 * recorded it, and all it has is the moment a browser noticed.
 */
describe("timeline order — two kinds of clock in one list", function () {
  const move = (block: number, timestamp?: number) => ({ tag: `b${block}`, block: BigInt(block), timestamp });
  const seen = (seenAt: number) => ({ tag: `s${seenAt}`, seenAt });
  const keyOf = (r: any) => (r.seenAt !== undefined ? { seenAt: r.seenAt } : { block: r.block, timestamp: r.timestamp });
  const tags = (rows: any[]) => rows.map((r) => r.tag);

  it("orders chain rows by block, newest first", function () {
    expect(tags(newestFirst([move(100), move(300), move(200)], keyOf)))
      .to.deep.equal(["b300", "b200", "b100"]);
  });

  it("does NOT sink a row whose clock has not arrived", function () {
    // The original bug, stated directly: b300 has no timestamp and b100 does, and
    // a naive single-key sort put b300 last because a block number is the smaller
    // number. Block order is known from the first paint and must be honoured.
    expect(tags(newestFirst([move(100, 1_700_000_100), move(300)], keyOf)))
      .to.deep.equal(["b300", "b100"]);
  });

  it("keeps two events in one block in the order they were supplied", function () {
    // A refusal and a move can share a block. Their log order is the real order,
    // so the sort must be stable rather than free to swap them.
    const a = { tag: "first", block: BigInt(50) };
    const b = { tag: "second", block: BigInt(50) };
    expect(tags(newestFirst([a, b], keyOf))).to.deep.equal(["first", "second"]);
  });

  it("places a sighting against the moves whose clocks are known", function () {
    const rows = [move(100, 1_000), move(200, 2_000), move(300, 3_000), seen(2_500)];
    expect(tags(newestFirst(rows, keyOf)))
      .to.deep.equal(["b300", "s2500", "b200", "b100"]);
  });

  it("puts a sighting above moves that have no clock yet", function () {
    // A sighting can only be made by a page open right now, so it belongs at the
    // newest end of anything it cannot be compared against — never buried.
    expect(tags(newestFirst([move(100), move(200), seen(9_999)], keyOf)))
      .to.deep.equal(["s9999", "b200", "b100"]);
  });

  it("orders several sightings among themselves, newest first", function () {
    expect(tags(newestFirst([seen(100), seen(300), seen(200)], keyOf)))
      .to.deep.equal(["s300", "s200", "s100"]);
  });

  it("drops a sighting older than every move to the bottom", function () {
    expect(tags(newestFirst([move(100, 5_000), move(200, 6_000), seen(1_000)], keyOf)))
      .to.deep.equal(["b200", "b100", "s1000"]);
  });

  it("handles a list with nothing in it", function () {
    // A fight that has not started yet, and the state the page renders most often.
    expect(newestFirst([], keyOf)).to.deep.equal([]);
  });

  it("leaves the caller's array alone", function () {
    // The page holds this list across renders; sorting it in place would reorder
    // state React believes it owns.
    const input = [move(100), move(300)];
    newestFirst(input, keyOf);
    expect(tags(input)).to.deep.equal(["b100", "b300"]);
  });
});
