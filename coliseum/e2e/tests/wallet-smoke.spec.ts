/**
 * Does the injected wallet actually connect?
 *
 * Run this before anything that costs money. It uses a throwaway key with no funds
 * and sends no transaction, so its only job is to prove the courier works: the site
 * discovers the wallet, lists it, connects to it, and reports the right network.
 *
 * If this fails, nothing further is worth running — every later test would fail at
 * the same first step and burn a fight's deposit finding out.
 */
import { test, expect } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { installWallet } from '../fixtures/wallet';

test('the site finds the injected wallet and connects to it', async ({ browser }) => {
  const context = await browser.newContext();
  const key = generatePrivateKey();
  const expected = privateKeyToAccount(key).address;

  const wallet = await installWallet(context, key, 'Coliseum Test Wallet');
  const page = await context.newPage();

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/duel');

  // The wallet must be visible to the page's own discovery, not just present in
  // the window — that difference is the whole reason for the announcement.
  const announced = await page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const found: string[] = [];
        window.addEventListener('eip6963:announceProvider', (e) =>
          found.push((e as CustomEvent).detail.info.name),
        );
        window.dispatchEvent(new Event('eip6963:requestProvider'));
        setTimeout(() => resolve(found), 500);
      }),
  );
  expect(announced).toContain('Coliseum Test Wallet');

  // The site connects to an announced wallet on its own, so there is usually
  // nothing to click. The button is only there when it has not — click it if so,
  // rather than assuming either behaviour.
  const connect = page.getByRole('button', { name: /^connect/i });
  if (await connect.count()) {
    await connect.first().click();
    await page.getByText('Coliseum Test Wallet').first().click();
  }

  // Connected means the address is on screen. It is truncated to two leading
  // characters and four trailing ones ("0xAb…f8C8"), so match on the tail — the
  // leading pair is too short to be distinctive.
  const short = new RegExp(expected.slice(-4), 'i');
  await expect(page.getByText(short).first()).toBeVisible({ timeout: 30_000 });

  // The site must NOT be showing its wrong-network state: it asked for the chain id
  // and got 50312 back.
  expect(wallet.calls).toContain('eth_chainId');
  await expect(page.getByText(/wrong network|switch network/i)).toHaveCount(0);

  expect(errors, `page errors: ${errors.join(' | ')}`).toHaveLength(0);

  await context.close();
});
