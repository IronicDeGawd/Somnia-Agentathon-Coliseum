import { expect } from "chai";
import { newObservations, settledStatuses } from "../frontend/lib/marginWatch";

/**
 * The margin timeline's only piece of real logic.
 *
 * WHY IT NEEDS TESTING AT ALL, given nothing here touches a chain. A margin state
 * is the one thing in a fight that NOTHING records: the venue answers "what is this
 * account's state right now" from current equity, no event is emitted by anyone, and
 * the link from a fighter to its rented trading account is deleted at the final
 * bell. So a state that is not written down while a page is open is gone for good,
 * and this function decides what gets written down.
 *
 * Both ways of getting it wrong look fine on screen until the moment matters. Record
 * every sample and a ten-second poll buries the fight under six identical lines a
 * minute; record nothing on a first sighting and the one copy of the moment is lost.
 *
 * MEASURED ON THE REAL VENUE, duel 83, which is why the states themselves stay
 * unproven: with the position open the venue reported equity 0.0627 against an
 * initial requirement of 0.0618, a MAINTENANCE line of 0.0309, and close-out at
 * 0.0155. A margin call fires below maintenance — half the equity present. Draining
 * an account cannot get there, because the withdrawal is capped at equity minus the
 * INITIAL requirement, which by definition leaves the account above initial and so
 * comfortably above maintenance. Nothing we control can trip it; only the market can.
 */
describe("margin watch — what counts as a new sighting", function () {
  const map = (entries: [number, number][]) => new Map<number, number>(entries);

  it("a first sighting of healthy is not news", function () {
    // Every fighter in every fight starts healthy. Recording it would put a
    // meaningless line at the top of the timeline before anything had happened.
    expect(newObservations([], map([[0, 0], [1, 0]]), 100)).to.deep.equal([]);
  });

  it("a first sighting of trouble is recorded", function () {
    expect(newObservations([], map([[0, 1]]), 100)).to.deep.equal([
      { fighterId: 0, status: 1, seenAt: 100 },
    ]);
  });

  it("the same state, seen again, is not recorded again", function () {
    const already = [{ fighterId: 0, status: 1, seenAt: 100 }];
    expect(newObservations(already, map([[0, 1]]), 160)).to.deep.equal([]);
  });

  it("an escalation is recorded", function () {
    const already = [{ fighterId: 0, status: 1, seenAt: 100 }];
    expect(newObservations(already, map([[0, 2]]), 160)).to.deep.equal([
      { fighterId: 0, status: 2, seenAt: 160 },
    ]);
  });

  it("a RETURN to healthy is news, unlike a first sighting of it", function () {
    // The asymmetry is the point: a fighter climbing back off the line is the
    // second half of the story and must not be dropped by the same rule that
    // suppresses the opening line.
    const already = [{ fighterId: 0, status: 1, seenAt: 100 }];
    expect(newObservations(already, map([[0, 0]]), 160)).to.deep.equal([
      { fighterId: 0, status: 0, seenAt: 160 },
    ]);
  });

  it("the two fighters are tracked apart", function () {
    const already = [{ fighterId: 0, status: 1, seenAt: 100 }];
    expect(newObservations(already, map([[0, 1], [1, 3]]), 160)).to.deep.equal([
      { fighterId: 1, status: 3, seenAt: 160 },
    ]);
  });

  it("a fighter that is not being watched records nothing", function () {
    // A spot fight has no margin at all, so its statuses map is empty and the
    // timeline must stay clean rather than filling with zeroes.
    expect(newObservations([], map([]), 100)).to.deep.equal([]);
  });

  it("a first healthy sighting is remembered even though it is not recorded", function () {
    // Otherwise it is re-examined on every poll — and the moment it is examined
    // against an empty history it looks like a first sighting again, forever.
    const settled = settledStatuses([], map([[0, 0], [1, 2]]));
    expect(settled.get(0)).to.equal(0);
    expect(settled.get(1)).to.equal(2);
  });

  it("what was already recorded wins over the live reading when seeding", function () {
    // The recorded history is the source of truth for "what did we last write
    // down"; the live map is only a candidate.
    const settled = settledStatuses([{ fighterId: 0, status: 3, seenAt: 100 }], map([[0, 0]]));
    expect(settled.get(0)).to.equal(3);
  });
});
