/**
 * arena.ts — one place that stands an Arena up for tests.
 *
 * Arena is a router: it holds the storage and the funds, and hands functions it
 * does not implement to a part that runs against that same storage. Deploying it
 * therefore takes several steps — library, router, parts, wiring — and getting
 * any of them wrong fails in a confusing way, so no test does it by hand.
 *
 * The deployment itself is delegated to the SAME function the deploy scripts use
 * (scripts/lib/deployArena.ts), so every test run is also a check that the real
 * deploy path still produces a working Arena.
 *
 * What comes back is a single contract object at the router's address carrying
 * the combined interface, so callers cannot tell which functions live where.
 * That is the point: outside this file, Arena is one contract at one address.
 */
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { getContract, toFunctionSelector, toEventSelector, type Abi } from "viem";

import { deployLinkedArena, ARENA_PARTS } from "../../scripts/lib/deployArena";

/**
 * Router ABI plus everything the parts contribute, deduplicated.
 *
 * Events and errors matter as much as functions here. A part emits its own
 * events from the router's address, so anything reading Arena's logs needs those
 * signatures even though the router's own ABI has never heard of them.
 */
function entryKey(entry: Abi[number]): string | null {
  if (entry.type === "function") return `f:${toFunctionSelector(entry as never)}`;
  if (entry.type === "event") return `e:${toEventSelector(entry as never)}`;
  if (entry.type === "error") return `x:${(entry as { name: string }).name}`;
  return null;
}

function mergedAbi(routerAbi: Abi, partAbis: Abi[]): Abi {
  const seen = new Set<string>();
  for (const entry of routerAbi) {
    const k = entryKey(entry);
    if (k) seen.add(k);
  }
  const extra: Abi[number][] = [];
  for (const partAbi of partAbis) {
    for (const entry of partAbi) {
      const k = entryKey(entry);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      extra.push(entry);
    }
  }
  return [...routerAbi, ...extra] as Abi;
}

export async function deployArenaWithParts(
  hre: HardhatRuntimeEnvironment,
  args: unknown[],
  opts: { value?: bigint } = {},
) {
  const { address, arenaUtils, parts } = await deployLinkedArena(hre, args, {
    ...opts,
    quiet: true,
  });

  const routerAbi = (await hre.artifacts.readArtifact("Arena")).abi as Abi;
  const partAbis: Abi[] = [];
  for (const name of ARENA_PARTS) {
    partAbis.push((await hre.artifacts.readArtifact(name)).abi as Abi);
  }

  const [wallet] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();

  const arena = getContract({
    address,
    abi: mergedAbi(routerAbi, partAbis),
    client: { public: publicClient, wallet },
  });

  const router = await hre.viem.getContractAt("Arena", address);
  const viewPart = await hre.viem.getContractAt("ArenaViewPart", parts.ArenaViewPart);

  return { arena, arenaUtils, parts, router, viewPart };
}
