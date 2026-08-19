/**
 * Two perps fights at once, both started the way a player starts one.
 *
 * WHY TWO AT ONCE. Margin on the venue is pooled per trading address, and every
 * fighter is given its own address precisely so one fighter's loss cannot be taken
 * out of another's collateral. Nothing about that guarantee is visible in a single
 * fight — it only shows when two fighters hold margin at the same moment, and then
 * only when one of them is liquidated. So the fights run side by side and the
 * addresses are checked afterwards from the chain.
 *
 * Every step here is a real transaction on a real chain. Each player pays a real
 * deposit, and the fight that starts is a fight that happened.
 *
 *   WALLET_FILE=… BASE_URL=… pnpm exec playwright test perps-loop
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import fs from 'fs';
import { installWallet } from '../fixtures/wallet';

const wallets: { address: `0x${string}`; privateKey: `0x${string}` }[] =
  JSON.parse(fs.readFileSync(process.env.WALLET_FILE!, 'utf-8'));

/**
 * The two fights run on DIFFERENT round counts, and that is deliberate rather than
 * incidental. Every round count is its own waiting line, and a line holds one player
 * at a time — so four players in ONE line pair up in arrival order, and which two
 * met is not something a test can pin down. On separate lines each pair is certain,
 * while the fights themselves still overlap, which is the part that matters.
 */
const FIGHT_ONE_TURNS = 3;
const FIGHT_TWO_TURNS = 6;

interface Player {
  page: Page;
  address: `0x${string}`;
  close: () => Promise<void>;
}

/**
 * Take one player from an empty browser to sitting in the queue.
 *
 * Deliberately does the whole thing through the page — the market card, the tier,
 * the fighter, the approval and the queue — because the point is to prove a player
 * can reach a perps fight from the site, not that the contract accepts a call.
 */
async function queueAsPlayer(
  browser: Browser,
  index: number,
  fighter: RegExp,
  turns: number,
): Promise<Player> {
  const w = wallets[index];
  const context = await browser.newContext();
  await installWallet(context, w.privateKey, `Player ${index + 1}`);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`${w.address}: ${e.message}`));

  await page.goto('/duel');

  // The wallet is connected already — the site finds an announced provider on its
  // own — so the balance appearing is the signal that reads are working.
  await expect(page.getByText(/USDso/).first()).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: /create new duel|expand to start/i }).first().click();

  await page.getByRole('button', { name: /PERPS/ }).first().click();
  // The tier buttons are labelled with the round count followed by the assets that
  // tier currently trades, and those assets are read from the chain — so match on
  // the number and a letter, never on the asset names.
  await page.locator('button').filter({ hasText: new RegExp(`^${turns}[A-Za-z]`) }).first().click();
  await page.getByRole('button', { name: fighter }).first().click();

  // Not anchored. The button's accessible name is not exactly its visible text, so
  // an anchored pattern silently matches nothing and the failure reads as "the site
  // never offered a queue button" rather than "the pattern was too strict".
  await expect(page.getByText(/INSUFFICIENT USDso/)).toHaveCount(0);
  const enter = page.getByRole('button', { name: /ENTER QUEUE/ });
  await expect(enter.first()).toBeEnabled({ timeout: 60_000 });
  await enter.first().click();

  // Approve and queue are one button and two transactions, so this waits for the
  // pair rather than for a click to return.
  await expect(page.getByText(/waiting for opponent|APPROVING \+ QUEUEING/i).first())
    .toBeVisible({ timeout: 180_000 });

  expect(errors, errors.join(' | ')).toHaveLength(0);
  return { page, address: w.address, close: () => context.close() };
}

/** Both players of one fight, queued together and matched against each other. */
async function runFight(browser: Browser, a: number, b: number, turns: number, label: string) {
  // The first player has to be in the queue before the second arrives, or both take
  // the empty slot and sit waiting for an opponent who is also waiting.
  const p1 = await queueAsPlayer(browser, a, /DEGEN/, turns);
  const p2 = await queueAsPlayer(browser, b, /WHALE/, turns);

  // Matching happens inside the second player's queue transaction, so by the time it
  // returns the fight exists. Both pages should move to it on their own.
  const duelUrl = /\/duel\/\d+/;
  await Promise.all([
    expect(p1.page).toHaveURL(duelUrl, { timeout: 240_000 }),
    expect(p2.page).toHaveURL(duelUrl, { timeout: 240_000 }),
  ]);

  const duelId = Number(p1.page.url().match(/\/duel\/(\d+)/)![1]);
  expect(Number(p2.page.url().match(/\/duel\/(\d+)/)![1])).toBe(duelId);

  fs.appendFileSync(
    process.env.RESULT_FILE!,
    JSON.stringify({ label, turns, duelId, players: [p1.address, p2.address] }) + '\n',
  );

  // The fight is now the chain's business. What the page must show is that it is a
  // PERPS fight: the moves it reports have to be long and short, not buy and sell.
  const tape = p1.page.getByText(/LONG |SHORT /);
  await expect(tape.first()).toBeVisible({ timeout: 15 * 60 * 1000 });

  await p1.close();
  await p2.close();
  return duelId;
}

test('fight one — two players, three rounds, perps', async ({ browser }) => {
  await runFight(browser, 0, 1, FIGHT_ONE_TURNS, 'fight-1');
});

test('fight two — two more players, six rounds, at the same time', async ({ browser }) => {
  await runFight(browser, 2, 3, FIGHT_TWO_TURNS, 'fight-2');
});
