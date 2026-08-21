import { expect } from "chai";
import { marketOf } from "../frontend/lib/marketKind";

/**
 * Naming the game a fight is playing.
 *
 * WHY THIS IS WORTH TESTING. The market is the single most important thing about a
 * fight — real coin books, a prediction, a margin position, or a mock — and the
 * lobby's cards did not say. Adding a label is only an improvement if the label is
 * right: a spot fight badged PRACTICE would present real money as play money, which
 * is worse than the silence it replaces.
 *
 * A duel's stored record cannot answer it. The `simulated` flag is two-valued, so a
 * spot fight and an events fight both report false. The pools a fight recorded when
 * it started are the only honest source, and event desks are rebound to fresh
 * questions every fifteen minutes and MOVE ADDRESS when they are — so events can
 * only be identified by elimination. That is sound because the other three sets are
 * all stable, and these tests are what hold that reasoning in place.
 */
describe("market kind — which game is this fight playing?", function () {
  // The real address tables live in the frontend's contracts module, which imports
  // the bundler's path aliases and so cannot be loaded here. That is exactly why the
  // function takes the sets as arguments — these stand in for them, and the shape is
  // what matters.
  const spot = [
    "0xD180195da5459C7a0DEA188ed61216ec43682b50",
    "0x3605f28aA7C50e7441211e77Cb0762d49539326C",
    "0x259fD6559214dd5aD3752322426eA9F9fABEFff4",
  ];
  const sim = [
    "0x3eefa7384f046532eee8bb0acd3057fc8abc1c08",
    "0x41525ddda51d7b82fddf7b4ec478dcddb1922a95",
    "0xbbfd95bb70085dea83488668eeceffb2e2e1f86f",
  ];
  const perpDesk = "0x1111111111111111111111111111111111111111";
  const eventDesk = "0x2222222222222222222222222222222222222222";

  /** No pool is a perp desk. */
  const noPerps = new Map<string, boolean>();
  const perpsAt = (...addrs: string[]) =>
    new Map(addrs.map((a) => [a.toLowerCase(), true]));

  it("names the real coin books SPOT", function () {
    expect(marketOf(spot, noPerps, false, spot, sim)).to.equal("SPOT");
  });

  it("names the mock books PRACTICE", function () {
    expect(marketOf(sim, noPerps, true, spot, sim)).to.equal("PRACTICE");
  });

  it("names a perp desk PERPS, on the chain's word and not a table", function () {
    const pools = [perpDesk, perpDesk, perpDesk];
    expect(marketOf(pools, perpsAt(perpDesk), false, spot, sim)).to.equal("PERPS");
  });

  it("names anything left over EVENTS", function () {
    // The elimination case, and the reason it has to be elimination: an events desk
    // is rebound every fifteen minutes and no shipped table can hold its address.
    expect(marketOf([eventDesk, eventDesk, eventDesk], noPerps, false, spot, sim)).to.equal("EVENTS");
  });

  it("calls a fight PERPS if ANY of its pools is a perp desk", function () {
    // A perps fight's three slots are three separate desks, and a batch read can
    // return them in any order — requiring all three would misname it on a partial.
    expect(marketOf([eventDesk, perpDesk, eventDesk], perpsAt(perpDesk), false, spot, sim)).to.equal("PERPS");
  });

  it("SAYS NOTHING while the reads are in flight", function () {
    // The important one. A card draws no badge on undefined, and drawing the wrong
    // badge for a moment is worse than drawing none — a spot fight flashing
    // PRACTICE tells the viewer real money is play money.
    expect(marketOf(undefined, undefined, false, spot, sim)).to.equal(undefined);
    expect(marketOf(spot, undefined, false, spot, sim)).to.equal(undefined);
  });

  it("still names a practice fight before any read returns", function () {
    // `simulated` comes free with the duel record, so this one case needs no call.
    expect(marketOf(undefined, undefined, true, spot, sim)).to.equal("PRACTICE");
    expect(marketOf([], undefined, true, spot, sim)).to.equal("PRACTICE");
  });

  it("does not care what case an address arrives in", function () {
    // Addresses come back from different reads and casing is not something to rely
    // on — a case-sensitive compare has cost real time in this project before.
    expect(marketOf(spot.map((a) => a.toUpperCase()), noPerps, false, spot, sim)).to.equal("SPOT");
  });

  it("does not mistake a mixed set for the spot books", function () {
    // Two real books and one stranger is not a spot fight. `every` is load-bearing:
    // `some` would badge an events fight that happened to share one address.
    expect(marketOf([spot[0], spot[1], eventDesk], noPerps, false, spot, sim)).to.equal("EVENTS");
  });

  it("prefers the pools over the simulated flag when they disagree", function () {
    // The flag is the fallback, not the authority. A fight whose recorded pools are
    // the real books is a spot fight whatever the flag says.
    expect(marketOf(spot, noPerps, true, spot, sim)).to.equal("SPOT");
  });
});
