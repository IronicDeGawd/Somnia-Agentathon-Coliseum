import { expect } from "chai";
import hre from "hardhat";

type Fighter = {
  name: string;
  tagline: string;
  systemPrompt: string;
  aggression: bigint;
  patience: bigint;
  risk: bigint;
};

describe("FighterRegistry", function () {
  async function deployRegistry() {
    const registry = await hre.viem.deployContract("FighterRegistry");
    return { registry };
  }

  it("FIGHTER_COUNT equals 6", async function () {
    const { registry } = await deployRegistry();
    const count = (await registry.read.FIGHTER_COUNT()) as bigint;
    expect(Number(count)).to.equal(6);
  });

  it("all 6 fighters have non-empty name, tagline, and systemPrompt", async function () {
    const { registry } = await deployRegistry();
    for (let i = 0; i < 6; i++) {
      const f = (await registry.read.getFighter([i])) as Fighter;
      expect(f.name.length, `fighter ${i} name empty`).to.be.greaterThan(0);
      expect(f.tagline.length, `fighter ${i} tagline empty`).to.be.greaterThan(0);
      expect(f.systemPrompt.length, `fighter ${i} systemPrompt empty`).to.be.greaterThan(0);
    }
  });

  it("all 6 fighters have distinct names", async function () {
    const { registry } = await deployRegistry();
    const names: string[] = [];
    for (let i = 0; i < 6; i++) {
      const f = (await registry.read.getFighter([i])) as Fighter;
      expect(names, `duplicate name: ${f.name}`).to.not.include(f.name);
      names.push(f.name);
    }
  });

  it("stat bars are in [0, 5] and sum is in [3, 15]", async function () {
    const { registry } = await deployRegistry();
    for (let i = 0; i < 6; i++) {
      const f = (await registry.read.getFighter([i])) as Fighter;
      const agg = Number(f.aggression);
      const pat = Number(f.patience);
      const rsk = Number(f.risk);
      expect(agg, `fighter ${i} aggression out of [0,5]`).to.be.within(0, 5);
      expect(pat, `fighter ${i} patience out of [0,5]`).to.be.within(0, 5);
      expect(rsk, `fighter ${i} risk out of [0,5]`).to.be.within(0, 5);
      const sum = agg + pat + rsk;
      expect(sum, `fighter ${i} stat sum ${sum} out of [3,15]`).to.be.within(3, 15);
    }
  });

  it("getFighter(6) reverts with FighterOutOfBounds", async function () {
    const { registry } = await deployRegistry();
    let caughtErr: unknown;
    try {
      await registry.read.getFighter([6]);
    } catch (err: unknown) {
      caughtErr = err;
    }
    expect(caughtErr, "expected getFighter(6) to revert").to.not.be.undefined;
    expect(String(caughtErr)).to.include("FighterOutOfBounds");
  });
});
