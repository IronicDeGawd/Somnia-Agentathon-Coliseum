import { expect } from "chai";
import { fightMinutes, fightLengthLabel } from "../frontend/lib/fightLength";

/**
 * How long a fight takes, as told to somebody about to pay to enter one.
 *
 * WHY THIS IS WORTH TESTING. The figure goes on the button that takes a deposit.
 * Somebody choosing fifteen rounds is committing to sit through it, and a wrong
 * or falsely precise number is worse than no number: it turns a normal slow
 * stretch into "the fight is broken". So what is pinned here is not arithmetic
 * so much as honesty — the answer must always be a range, always hedged, and
 * must grow with the round count.
 */
describe("fight length — how long am I signing up for?", function () {
  it("always answers with a range, never a single promised time", function () {
    const { low, high } = fightMinutes(9);
    expect(high).to.be.greaterThan(low);
  });

  it("gets longer as the fight gets longer", function () {
    // The one relationship a viewer will actually check by eye across the four
    // tier buttons sitting side by side.
    const tiers = [3, 6, 9, 15].map((t) => fightMinutes(t));
    for (let i = 1; i < tiers.length; i++) {
      expect(tiers[i].low).to.be.greaterThan(tiers[i - 1].low);
      expect(tiers[i].high).to.be.greaterThan(tiers[i - 1].high);
    }
  });

  it("brackets the pace that was actually measured", function () {
    // Three fights running at once each gained one round in seventy-five
    // seconds. A six-round fight at that pace is about seven and a half
    // minutes, and the bracket has to contain it or it is describing some other
    // arena than the one that was watched.
    const { low, high } = fightMinutes(6);
    expect(low).to.be.at.most(7);
    expect(high).to.be.at.least(8);
  });

  it("hedges out loud", function () {
    // The tilde is the whole point. Without it the button states a fact it
    // cannot know.
    expect(fightLengthLabel(6)).to.match(/^~/);
  });

  it("uses an en dash so two numbers do not read as a subtraction", function () {
    expect(fightLengthLabel(15)).to.contain("–");
    expect(fightLengthLabel(15)).to.not.contain("-");
  });

  it("never collapses to the same figure twice", function () {
    // `~3–3 MIN` would read as a rendering fault. The slow end being twice the
    // fast one is what rules it out, for every round count including one.
    for (const t of [1, 3, 6, 9, 15]) {
      const { low, high } = fightMinutes(t);
      expect(high).to.be.greaterThan(low);
    }
  });

  it("never claims a fight is over in under a minute", function () {
    // Rounding a very short fight toward zero would print `~0 MIN`, which reads
    // as instant. Nothing here is instant.
    expect(fightMinutes(1).low).to.be.at.least(1);
  });

  it("names the four tiers the lobby actually offers", function () {
    // Not asserting exact figures — those are a judgement about a caretaker's
    // pace and may be retuned. What is fixed is that every tier on offer gets a
    // usable, plausible answer rather than a blank or an absurdity.
    for (const t of [3, 6, 9, 15]) {
      const { low, high } = fightMinutes(t);
      expect(low).to.be.at.least(1);
      expect(high).to.be.at.most(40);
    }
  });
});
