/**
 * perps.ts — one place that stands up a believable perpetual-futures venue.
 *
 * The six market specifications below are not invented. They are the parameters
 * measured on chain 50312 on 2026-08-19, including the one that matters most:
 * Bitcoin's EFFECTIVE margin factor of 1853 basis points against a CONFIGURED 500.
 * Sizing anything off the configured value understates Bitcoin's margin by a factor
 * of 3.7, which is exactly the mistake the budget-ladder design exists to make
 * impossible — so the fixture has to reproduce it or the tests prove nothing.
 *
 * Margin for one smallest position, which is what the tier ladder is really about:
 *
 *   XRP $0.050 · ADA $0.175 · SOL $0.384 · BNB $0.602 · ETH $0.956 · BTC $11.97
 */
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { parseEther, maxUint256 } from "viem";

type Hex = `0x${string}`;

const ONE = 10n ** 18n;

export interface MarketSpec {
  name: string;
  /** 10^decimals of the synthetic base asset. */
  oneBase: bigint;
  minQuantity: bigint;
  lotSize: bigint;
  tickSize: bigint;
  /** Mark price in 18-decimal quote units. */
  mark: bigint;
  /** Effective (open-interest-scaled) initial margin factor, in basis points. */
  imf: bigint;
  baseDecimals: number;
}

/** Measured 2026-08-19. Order is cheapest margin first, which is also the order
 *  markets drop out of the budget ladder. */
export const MARKETS: MarketSpec[] = [
  { name: "XRP", oneBase: 10n ** 6n,  minQuantity: 10n ** 6n,  lotSize: 10n ** 6n,  tickSize: ONE / 10_000n, mark: ONE,             imf: 500n,  baseDecimals: 6  },
  { name: "ADA", oneBase: 10n ** 6n,  minQuantity: 10n ** 7n,  lotSize: 10n ** 7n,  tickSize: ONE / 10_000n, mark: ONE * 175n / 1000n, imf: 1000n, baseDecimals: 6  },
  { name: "SOL", oneBase: 10n ** 9n,  minQuantity: 10n ** 8n,  lotSize: 10n ** 8n,  tickSize: ONE / 100n,    mark: ONE * 768n / 10n,   imf: 500n,  baseDecimals: 9  },
  { name: "BNB", oneBase: 10n ** 18n, minQuantity: 10n ** 16n, lotSize: 10n ** 16n, tickSize: ONE / 100n,    mark: ONE * 602n,      imf: 1000n, baseDecimals: 18 },
  { name: "ETH", oneBase: 10n ** 18n, minQuantity: 10n ** 16n, lotSize: 10n ** 16n, tickSize: ONE / 100n,    mark: ONE * 1911n,     imf: 500n,  baseDecimals: 18 },
  // The outlier, and the whole reason the asset list is computed rather than
  // configured: 1853 bps where its config says 500.
  { name: "BTC", oneBase: 10n ** 8n,  minQuantity: 10n ** 5n,  lotSize: 10n ** 5n,  tickSize: ONE / 10n,     mark: ONE * 64_600n,   imf: 1853n, baseDecimals: 8  },
];

export const marketByName = (name: string): MarketSpec =>
  MARKETS.find((m) => m.name === name)!;

/** Margin one smallest position costs, in 18-decimal USDso. */
export function imPerLot(m: MarketSpec): bigint {
  return ((m.minQuantity * m.mark) / m.oneBase) * m.imf / 10_000n;
}

/** A label as Arena stores it: up to eight ASCII characters, zero-padded. */
export const label = (s: string): Hex =>
  ("0x" + Buffer.from(s, "ascii").toString("hex").padEnd(16, "0")) as Hex;

/**
 * Stand up the collateral token, the margin bank, six markets with two-sided books,
 * six desks, and the registry that leases fighter accounts behind them.
 *
 * @param arenaAddress whoever is allowed to lease, trade and release. In the unit
 *        tests that is a plain wallet standing in for Arena; in the integration
 *        tests it is the real router.
 */
export async function deployPerpVenue(
  hre: HardhatRuntimeEnvironment,
  arenaAddress: Hex,
  opts: { usdso?: Hex; float?: bigint; accounts?: bigint } = {},
) {
  const [owner] = await hre.viem.getWalletClients();

  const usdso = opts.usdso
    ? await hre.viem.getContractAt("MockERC20", opts.usdso)
    : await hre.viem.deployContract("MockERC20", ["USDso", "USDso"]);

  const bank = await hre.viem.deployContract("MockMarginBank", [usdso.address]);
  const registry = await hre.viem.deployContract("PerpAccountRegistry", [
    usdso.address, bank.address, arenaAddress,
  ]);

  const markets: Awaited<ReturnType<typeof hre.viem.deployContract>>[] = [];
  const desks: Awaited<ReturnType<typeof hre.viem.deployContract>>[] = [];

  for (const m of MARKETS) {
    const market = await hre.viem.deployContract("MockPerpPool", [
      bank.address, m.oneBase, m.tickSize, m.minQuantity, m.lotSize, m.mark, m.imf,
    ]);
    await bank.write.registerMarket([market.address, true]);
    await setBook(market, m);
    const desk = await hre.viem.deployContract("PerpDesk", [
      arenaAddress, market.address, registry.address, usdso.address,
    ]);
    markets.push(market);
    desks.push(desk);
  }

  await registry.write.registerDesks([desks.map((d) => d.address)]);
  await registry.write.addAccounts([opts.accounts ?? 6n]);

  // A float of zero is a deliberate option, not an oversight: the Arena integration
  // tests fund it through `fundPerpFloat` instead, so the seed accounting that keeps
  // house money separate from depositor money is exercised rather than bypassed.
  const float = opts.float ?? parseEther("500");
  if (float > 0n) {
    await usdso.write.mint([owner.account.address, float]);
    await usdso.write.approve([registry.address, maxUint256]);
    await registry.write.fundFloat([float]);
  }

  const index = (name: string) => MARKETS.findIndex((m) => m.name === name);

  return {
    owner, usdso, bank, registry, markets, desks, index,
    market: (name: string) => markets[index(name)],
    desk:   (name: string) => desks[index(name)],
  };
}

/**
 * A two-sided book about 20 basis points wide, with a hundred lots on each side.
 * That is the depth measured live — the thinnest top-of-book carried 101 lots — so
 * a fighter's single-lot order is never the reason a test fails.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function setBook(market: any, m: MarketSpec, depthLots = 100n) {
  const half = (m.mark * 10n) / 10_000n;
  const qty = m.minQuantity * depthLots;
  await market.write.setBookLevel([true,  alignDown(m.mark - half, m.tickSize), qty]);
  await market.write.setBookLevel([false, alignUp(m.mark + half, m.tickSize), qty]);
}

export const alignUp   = (p: bigint, tick: bigint) => ((p + tick - 1n) / tick) * tick;
export const alignDown = (p: bigint, tick: bigint) => (p / tick) * tick;

/** The identity Arena packs onto an order so a desk knows whose trade it is. */
export const userData = (duelId: bigint, fighterId: number): bigint =>
  (duelId << 8n) | BigInt(fighterId);

/**
 * Assert a call reverted with a specific custom error.
 *
 * Not `rejectedWith(name)`: a custom error that reaches the test through a raw
 * transaction rather than a simulation arrives UNDECODED — the node reports
 * "unrecognized custom error (return data: 0x…)" because it has no ABI — so matching
 * on the name alone silently depends on which path the call took. Matching the
 * four-byte selector as well pins the exact error either way.
 */
export async function expectCustomError(p: Promise<unknown>, signature: string) {
  const { toFunctionSelector } = await import("viem");
  const selector = toFunctionSelector(signature);
  const name = signature.split("(")[0]!;
  try {
    await p;
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (msg.includes(name) || msg.includes(selector)) return;
    throw new Error(`expected ${signature} (${selector}) but got: ${msg}`);
  }
  throw new Error(`expected ${signature} (${selector}) but the call succeeded`);
}
