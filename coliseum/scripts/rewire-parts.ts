/**
 * rewire-parts.ts
 * ---------------
 * Redeploy ArenaUtils and every part, and point the LIVE router at the new ones.
 * The router keeps its address, so its storage, its funds and every consumer that
 * knows where Arena lives are untouched.
 *
 * This is the whole point of the router split: contract logic can be replaced
 * without migrating balances or re-pointing the frontend.
 *
 * Rewiring is refused while a duel is running or anything is escrowed. An
 * unclaimed payout from a finished fight counts — clear it with claim-match.ts.
 *
 * Selectors that no part claims any more are unrouted. This matters more than it
 * sounds: when a function's arguments change, the old signature keeps its own
 * separate entry pointing at the retired code, which still runs against live
 * storage. That is how a call in the old shape can quietly undo what the new one
 * recorded. The set of routed selectors is kept in the manifest so the next run
 * knows what to retire.
 *
 *   pnpm exec hardhat run scripts/rewire-parts.ts --network somnia
 */
import hre from "hardhat";
import { formatEther, toFunctionSelector, type Abi } from "viem";
import fs from "fs";
import path from "path";

import { ARENA_PARTS } from "./lib/deployArena";
import { routerOwnAbi } from "./lib/mergeArenaAbi";

type Hex = `0x${string}`;

async function main() {
  const manifestPath = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const routerAddr = manifest.contracts.Arena.address as Hex;

  const pub = await hre.viem.getPublicClient();
  const router = await hre.viem.getContractAt("Arena", routerAddr);

  const active = (await router.read.getActiveDuelIds()) as bigint[];
  const escrowed = (await router.read.escrowedPot()) as bigint;
  console.log(`Router:   ${routerAddr}`);
  console.log(`Active:   ${active.length} duel(s)`);
  console.log(`Escrowed: ${formatEther(escrowed)} USDso`);
  if (active.length || escrowed !== 0n) {
    throw new Error("the arena is not empty — finish and claim outstanding duels first");
  }

  const utils = await hre.viem.deployContract("ArenaUtils");
  console.log(`\nArenaUtils: ${utils.address}`);
  const libraries = { ArenaUtils: utils.address };

  // Only a part whose bytecode actually calls the library may be handed the link.
  async function linkOpts(name: string) {
    const artifact = await hre.artifacts.readArtifact(name);
    const needsUtils = Object.keys(artifact.linkReferences ?? {}).length > 0;
    return { artifact, opts: needsUtils ? { libraries } : {} };
  }

  // What the router's OWN bytecode answers — not the widened interface consumers
  // see, which lists every part's functions and would look like nothing needs
  // routing at all.
  const ownAbi = routerOwnAbi(hre.config.paths.artifacts) as unknown as Abi;
  const onRouter = new Set(
    ownAbi.filter((e) => e.type === "function").map((e) => toFunctionSelector(e as never)),
  );

  const parts: Record<string, Hex> = {};
  const routed = new Set<Hex>();
  for (const name of ARENA_PARTS) {
    const { artifact, opts } = await linkOpts(name);
    const part = await hre.viem.deployContract(name, [], opts as never);
    const selectors = (artifact.abi as Abi)
      .filter((e) => e.type === "function")
      .map((e) => toFunctionSelector(e as never))
      .filter((sel) => !onRouter.has(sel)) as Hex[];

    const hash = await router.write.setPart([selectors, part.address]);
    await pub.waitForTransactionReceipt({ hash });
    selectors.forEach((s) => routed.add(s));
    parts[name] = part.address as Hex;
    console.log(`${name}: ${part.address}  (${selectors.length} functions)`);
  }

  // Anything the previous wiring answered and this one does not — a renamed or
  // re-argumented function — still points at retired code running against live
  // storage. Retire it explicitly.
  const previous = (manifest.contracts.Arena.routedSelectors ?? []) as Hex[];
  const stale = previous.filter((sel) => !routed.has(sel));
  for (const sel of stale) {
    const to = (await router.read.partOf([sel])) as string;
    if (to === "0x0000000000000000000000000000000000000000") continue;
    const hash = await router.write.setPart([[sel], "0x0000000000000000000000000000000000000000"]);
    await pub.waitForTransactionReceipt({ hash });
    console.log(`unrouted stale selector ${sel} (was ${to})`);
  }

  manifest.contracts.Arena.arenaUtils = utils.address;
  manifest.contracts.Arena.parts = parts;
  manifest.contracts.Arena.routedSelectors = [...routed].sort();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\nManifest updated. Run verify-router.ts to confirm every selector resolves.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.shortMessage ?? e); process.exit(1); });
