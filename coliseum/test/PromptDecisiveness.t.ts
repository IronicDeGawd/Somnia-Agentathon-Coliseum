import { expect } from "chai";
import hre from "hardhat";

/**
 * What a fighter is told, and whether it is enough to decide on.
 *
 * WHY THIS FILE EXISTS. A perps fight produced twelve Holds from twelve moves while
 * seven actions were offered and every one was affordable (measured live, duel 89,
 * 2026-08-21). The markets had moved 5.6, 9.4 and 23.4 basis points across the whole
 * fight, so there was genuinely nothing to trade — but two things were also missing
 * from the prompt, and neither was a price:
 *
 *   1. Nothing said the fighter had an OPPONENT. The prompt reported a score against
 *      the fighter's own starting figure and stopped, so staying flat looked free.
 *   2. The move was stated absolutely. Four basis points means nothing without
 *      knowing what the market normally does in a minute.
 *
 * The prompt's WORDING is the thing that decides how a fighter behaves, and until now
 * only its action list was asserted. These tests pin the words.
 *
 * This file covers the second point — ranking a move rather than quoting it. The
 * first is asserted where a working Arena deploy already exists, in
 * `Arena.duel.t.ts` alongside the other spot-prompt assertions.
 *
 * Tested directly against the library rather than through two driven turns: the
 * function is pure, and standing up the reactivity path twice to exercise a string
 * builder would test the harness rather than the wording.
 */
describe("prompt — is this move worth noticing?", function () {
  async function utils() {
    return hre.viem.deployContract("ArenaUtils");
  }

  it("names the largest move of the fight, and its direction", async function () {
    const lib = await utils();
    // 100 → 101 is 100 bps, and the fight has seen nothing larger.
    const up = await lib.read.stepRankWord([101n * 10n ** 18n, 100n * 10n ** 18n, 100n]) as string;
    expect(up).to.match(/largest move of the fight so far, and upward/);

    const down = await lib.read.stepRankWord([99n * 10n ** 18n, 100n * 10n ** 18n, 100n]) as string;
    expect(down).to.match(/largest move of the fight so far, and downward/);
  });

  it("SAYS NOTHING when a bigger move has already happened", async function () {
    // The important half. A prompt that emphasised every move would talk a fighter
    // into trading noise, which is worse than holding — it pays the spread on
    // purpose. Emphasis has to be scarce to mean anything.
    const lib = await utils();
    const quiet = await lib.read.stepRankWord([
      100n * 10n ** 18n + 4n * 10n ** 16n, // 100.04, a 4 bps step
      100n * 10n ** 18n,
      300n,                                 // the fight has already seen 300 bps
    ]) as string;
    expect(quiet, `got: ${quiet}`).to.equal("");
  });

  it("says nothing on the first turn, when there is no previous price", async function () {
    const lib = await utils();
    expect(await lib.read.stepRankWord([100n * 10n ** 18n, 0n, 0n])).to.equal("");
  });

  it("says nothing when the price did not move at all", async function () {
    // Exactly equal prices are common on a quiet testnet book, and "the largest move
    // of the fight" would be a strange thing to say about no move.
    const lib = await utils();
    const flat = 100n * 10n ** 18n;
    expect(await lib.read.stepRankWord([flat, flat, 0n])).to.equal("");
  });

  it("says nothing when a market has no price to compare", async function () {
    const lib = await utils();
    expect(await lib.read.stepRankWord([0n, 100n * 10n ** 18n, 100n])).to.equal("");
  });

  it("treats a move that ties the record as the record", async function () {
    // maxStepBps is written before the prompt is built, so the current turn's own step
    // is already in it: an equal comparison is what a new high-water mark looks like,
    // and requiring strictly-greater would silence every one of them.
    const lib = await utils();
    const tie = await lib.read.stepRankWord([
      101n * 10n ** 18n, 100n * 10n ** 18n, 100n,
    ]) as string;
    expect(tie).to.match(/largest move of the fight so far/);
  });
});
