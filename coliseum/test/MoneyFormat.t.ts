import { expect } from "chai";
import { fmtUsd, fmtUsdNoSign, fmtAmount, fmtUsdsoRaw, fmtAmountRaw, fmtExactRaw } from "../frontend/lib/format";

/**
 * How much of a number the site is allowed to hide.
 *
 * WHY THIS IS TESTED AT ALL, for something as dull as a currency formatter. Duel
 * 74 was won by 0.000000800524579414 USDso. At two decimals both fighters printed
 * $0.03 and the gap between them printed as zero — so a correct result read on
 * screen as a draw the arena had got wrong. It had not: this chain declares a draw
 * only on equality to the wei, and those two figures were not equal. The fault was
 * entirely in the display.
 *
 * The fix was a widening ladder, and for a while it lived in the settlement panel
 * alone. That left the same page contradicting itself: the settlement card showed
 * the difference while the two large headline figures above it still rounded it
 * away. One rule now, in one file, tested here — because the failure it prevents
 * is invisible. Nothing errors, nothing looks broken; the page simply states
 * something untrue about who won.
 */
describe("money — enough digits to see the number", function () {
  const wei = (s: string) => BigInt(s);

  it("shows ordinary money at two decimals", function () {
    expect(fmtUsdNoSign(12.5)).to.equal("$12.50");
    expect(fmtAmount(12.5)).to.equal("12.50");
  });

  it("widens rather than rounding a small number to nothing", function () {
    // Each of these would print as 0.00 under a fixed two decimals.
    expect(fmtAmount(0.003)).to.equal("0.0030");
    expect(fmtAmount(0.00003)).to.equal("0.000030");
    expect(fmtAmount(0.0000003)).to.equal("0.00000030");
  });

  it("NEVER prints a non-zero value as zero", function () {
    // The duel 74 failure, stated as a rule. Anything that survives the ladder is
    // described in words instead of being flattened to 0.00.
    for (const n of [0.003, 0.00003, 0.0000003, 0.000000001]) {
      expect(fmtAmount(n)).to.not.equal("0.00");
    }
    expect(fmtAmount(0.000000001)).to.equal("<0.00000001");
    expect(fmtAmount(-0.000000001)).to.equal(">-0.00000001");
  });

  it("still prints an actual zero plainly", function () {
    // A fight with no position taken really is 0.00, and must not read as "almost
    // nothing" — that would suggest a figure too small to show.
    expect(fmtAmount(0)).to.equal("0.00");
    expect(fmtUsd(0)).to.equal("$0.00");
  });

  it("signs a change and does not sign a quantity", function () {
    // A PnL of +1.20 and a balance of 1.20 are different claims.
    expect(fmtUsd(1.2)).to.equal("+$1.20");
    expect(fmtUsd(-1.2)).to.equal("-$1.20");
    expect(fmtUsdNoSign(-1.2)).to.equal("$1.20");
  });

  it("does NOT separate the two duel-74 balances — and is not meant to", function () {
    // Worth pinning, because it is the limit of the ladder and easy to misread as
    // a bug. The ladder widens on the MAGNITUDE of a number, and these two are
    // around 0.0333 — comfortably printable at two decimals. It is their
    // DIFFERENCE that is tiny, and no per-number rule can see that.
    //
    // So both still read $0.03 at scanned width, by design: the tape rounds
    // because it is a scoreboard. What the ladder does fix is the MARGIN line,
    // which is the difference itself, and what settles the question entirely is
    // the exact figure on the settlement card below. Two different jobs.
    // The MARGIN is the recorded one — duel 74 was won by 0.000000800524579414.
    // The two balances around it are constructed to sit at that distance apart,
    // since what matters here is the gap, not the absolute size of the purses.
    const loser = wei("33355963026404585");
    const winner = loser + wei("800524579414");
    expect(fmtUsdsoRaw(winner)).to.equal(fmtUsdsoRaw(loser));
    // The margin itself is where the ladder earns its keep — at a fixed two
    // decimals this line printed "+0.0000", which is what made a win read as a
    // draw the arena had botched.
    // Six decimals, chosen because that is the first width at which the figure
    // survives at all. Not the full precision — but non-zero, which is the whole
    // point: the reader can see there IS a gap and go to the settlement card for
    // its exact size.
    expect(fmtAmountRaw(winner - loser)).to.equal("0.000001");
    // And the exact figures differ, which is what the settlement card shows.
    expect(fmtExactRaw(winner)).to.not.equal(fmtExactRaw(loser));
  });

  it("does not round at all where the result is justified", function () {
    // The settlement card's figure. Trailing zeros go; nothing else does.
    expect(fmtExactRaw(wei("800524579414"))).to.equal("0.000000800524579414");
    // A whole number keeps two decimals so it still reads as money.
    expect(fmtExactRaw(wei("1000000000000000000"))).to.equal("1.00");
  });

  it("keeps a whole number reading as money", function () {
    expect(fmtExactRaw(BigInt(0))).to.equal("0.00");
  });

  it("reads a wei balance as money", function () {
    expect(fmtUsdsoRaw(wei("2500000000000000000"))).to.equal("$2.50");
    expect(fmtAmountRaw(wei("2500000000000000000"))).to.equal("2.50");
  });
});
