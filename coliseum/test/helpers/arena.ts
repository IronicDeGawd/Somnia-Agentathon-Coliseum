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
import { getContract, toFunctionSelector, type Abi } from "viem";

import { deployLinkedArena, ARENA_PARTS } from "../../scripts/lib/deployArena";

/** Router ABI plus each part's own functions, with shared getters not repeated. */
function mergedAbi(routerAbi: Abi, partAbis: Abi[]): Abi {
  const seen = new Set(
    routerAbi.filter((e) => e.type === "function").map((e) => toFunctionSelector(e as never)),
  );
  const extra: Abi[number][] = [];
  for (const partAbi of partAbis) {
    for (const entry of partAbi) {
      if (entry.type !== "function") continue;
      const sel = toFunctionSelector(entry as never);
      if (seen.has(sel)) continue;
      seen.add(sel);
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
