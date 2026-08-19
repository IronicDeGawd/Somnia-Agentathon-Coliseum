/**
 * Every tier the lobby offers, on every market, played through the site.
 *
 * Driven by a MATRIX of `{market, turns, pair}` so the batching stays in the
 * caller's hands rather than Playwright's. That matters for three reasons the
 * runner cannot know about:
 *
 *  - THE ARENA HOLDS SIX FIGHTS AT ONCE. A seventh reverts `ArenaFull`, and it
 *    reverts inside the second player's queue transaction, so the failure lands on
 *    a player rather than on the operator.
 *  - A WALLET CANNOT BE IN TWO FIGHTS AT ONCE. Transactions from one address are
 *    ordered, so a pair in two concurrent fights collides on its own nonce.
 *  - TWO FIGHTS ON THE SAME TIER CROSS-PAIR. A tier is one waiting line holding
 *    one player, so four players in one line match in arrival order and which two
 *    met is not something a test can assert. Every entry in a batch therefore has
 *    a distinct (market, turns).
 *
 * Every fight here is real: real deposits, real orders, a real result.
 *
 *   MATRIX='[{"market":"EVENTS","turns":3,"pair":0}]' WALLET_FILE=… \
 *   RESULT_FILE=… BASE_URL=… pnpm exec playwright test all-markets
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import fs from 'fs';
import { installWallet } from '../fixtures/wallet';

interface Entry { market: string; turns: number; pair: number }

const MATRIX: Entry[] = JSON.parse(process.env.MATRIX!);
const wallets: { address: `0x${string}`; privateKey: `0x${string}` }[] =
  JSON.parse(fs.readFileSync(process.env.WALLET_FILE!, 'utf-8'));

/** The market cards, as the lobby labels them. */
const CARD: Record<string, RegExp> = {
  SPOT: /SPOT/,
  PRACTICE: /PRACTICE/,
  EVENTS: /EVENTS/,
  PERPS: /PERPS/,
};

async function queueAsPlayer(
  browser: Browser,
  walletIndex: number,
  fighter: RegExp,
  market: string,
  turns: number,
): Promise<{ page: Page; address: string; close: () => Promise<void> }> {
  const w = wallets[walletIndex];
  const context = await browser.newContext();
  await installWallet(context, w.privateKey, `Player ${walletIndex + 1}`);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/duel');
  await expect(page.getByText(/USDso/).first()).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: /create new duel|expand to start/i }).first().click();

  // EVERY creator interaction is scoped to the creator panel. The lobby also renders
  // a card per waiting line and a card per live fight, and those carry round numbers
  // too — so an unscoped "the button starting with 9" matched a live fight's card
  // once duel 27 existed, navigating away instead of picking a tier, and the wallet
  // never signed anything.
  const panel = page.locator('#duel-creator-panel');
  await panel.getByRole('button', { name: CARD[market] }).first().click();

  // Tier buttons read as the round count followed by the assets that tier trades,
  // and those come from the chain — so match the number and a letter, never a name.
  await panel.locator('button').filter({ hasText: new RegExp(`^${turns}[A-Za-z]`) }).first().click();
  await panel.getByRole('button', { name: fighter }).first().click();

  // A wallet too poor for this tier is the one failure worth naming outright: the
  // button simply reads INSUFFICIENT and a timeout would blame the site.
  await expect(
    page.getByText(/INSUFFICIENT USDso/),
    `${market} ${turns}r: wallet ${w.address} cannot cover the deposit`,
  ).toHaveCount(0);

  const enter = panel.getByRole('button', { name: /ENTER QUEUE/ });
  await expect(enter.first()).toBeEnabled({ timeout: 60_000 });
  await enter.first().click();

  // Wait for the queue to be CONFIRMED, not merely started. "APPROVING + QUEUEING"
  // appears the instant the button is clicked, so accepting it let this return while
  // the transaction was still in flight — and the second player then estimated gas
  // against a line that still looked empty, took the cheap estimate, and ran out of
  // gas on the expensive matching path. Either the page says it is waiting, or it
  // has already moved to the fight because the opponent was there first.
  await page.waitForFunction(
    () => /\/duel\/\d+/.test(location.pathname) ||
          /waiting for opponent/i.test(document.body.innerText || ''),
    undefined,
    { timeout: 240_000 },
  );

  expect(errors, `page errors: ${errors.join(' | ')}`).toHaveLength(0);
  return { page, address: w.address, close: () => context.close() };
}

for (const e of MATRIX) {
  test(`${e.market} ${e.turns} rounds`, async ({ browser }) => {
    const a = e.pair * 2;
    const p1 = await queueAsPlayer(browser, a, /DEGEN/, e.market, e.turns);
    const p2 = await queueAsPlayer(browser, a + 1, /WHALE/, e.market, e.turns);

    // Matching happens inside the second queue transaction, so the fight exists by
    // the time it returns and both pages should move to it on their own.
    const duelUrl = /\/duel\/\d+/;
    await Promise.all([
      expect(p1.page).toHaveURL(duelUrl, { timeout: 300_000 }),
      expect(p2.page).toHaveURL(duelUrl, { timeout: 300_000 }),
    ]);

    const duelId = Number(p1.page.url().match(/\/duel\/(\d+)/)![1]);
    expect(
      Number(p2.page.url().match(/\/duel\/(\d+)/)![1]),
      'both players must land in the SAME fight',
    ).toBe(duelId);

    // The fight must be a NEW one. Landing on any /duel/N is not proof of a match:
    // the lobby will happily navigate a player into somebody else's live fight, and
    // this assertion passed four times in a row on a fight neither player was in
    // while all four of their queue transactions had quietly failed.
    const floor = Number(process.env.MIN_DUEL ?? '0');
    expect(duelId, `duel ${duelId} predates this run — no new fight was started`)
      .toBeGreaterThanOrEqual(floor);

    fs.appendFileSync(
      process.env.RESULT_FILE!,
      JSON.stringify({ market: e.market, turns: e.turns, duelId, players: [p1.address, p2.address] }) + '\n',
    );

    await p1.close();
    await p2.close();
  });
}
