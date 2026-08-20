import { expect } from "chai";
import { marginStatusCopy } from "../frontend/lib/marginStatus";

describe("marginStatusCopy", function () {
  it("status 1 is MARGIN CALL", function () {
    expect(marginStatusCopy(1)).to.deep.equal({
      word: "MARGIN CALL",
      detail: "equity has fallen to the maintenance line",
    });
  });

  it("status 2 is LIQUIDATING", function () {
    expect(marginStatusCopy(2)).to.deep.equal({
      word: "LIQUIDATING",
      detail: "the venue is closing part of this position",
    });
  });

  it("status 3 is CLOSE-OUT", function () {
    expect(marginStatusCopy(3)).to.deep.equal({
      word: "CLOSE-OUT",
      detail: "the position is being closed out entirely",
    });
  });

  it("an unrecognised status (4) does not fall through to CLOSE-OUT", function () {
    const copy = marginStatusCopy(4);
    expect(copy).to.not.be.null;
    expect(copy!.word).to.not.equal("CLOSE-OUT");
    expect(copy).to.deep.equal({
      word: "UNKNOWN STATUS",
      detail: "this margin state is not recognised — treat with caution",
    });
  });

  it("an unrecognised status (99) does not fall through to CLOSE-OUT", function () {
    const copy = marginStatusCopy(99);
    expect(copy).to.not.be.null;
    expect(copy!.word).to.not.equal("CLOSE-OUT");
    expect(copy).to.deep.equal({
      word: "UNKNOWN STATUS",
      detail: "this margin state is not recognised — treat with caution",
    });
  });

  it("status 0 returns null (no warning presentable)", function () {
    expect(marginStatusCopy(0)).to.be.null;
  });

  it("a negative status returns null (no warning presentable)", function () {
    expect(marginStatusCopy(-1)).to.be.null;
  });

  // NaN is not <= 0 and not === to any of 1, 2, or 3 (every comparison against
  // NaN is false in JavaScript), so it falls past the null guard and all three
  // equality checks and lands on the unknown-status copy. This is correct
  // behaviour, not an accident of the chain.
  it("NaN returns the unknown-status copy", function () {
    expect(marginStatusCopy(NaN)).to.deep.equal({
      word: "UNKNOWN STATUS",
      detail: "this margin state is not recognised — treat with caution",
    });
  });

  it("Infinity returns the unknown-status copy", function () {
    expect(marginStatusCopy(Infinity)).to.deep.equal({
      word: "UNKNOWN STATUS",
      detail: "this margin state is not recognised — treat with caution",
    });
  });

  it("-Infinity returns null (it satisfies the <= 0 guard)", function () {
    expect(marginStatusCopy(-Infinity)).to.be.null;
  });

  it("a non-integer status (1.5) returns the unknown-status copy, not status 1's copy", function () {
    expect(marginStatusCopy(1.5)).to.deep.equal({
      word: "UNKNOWN STATUS",
      detail: "this margin state is not recognised — treat with caution",
    });
  });
});
