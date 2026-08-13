/**
 * deployArena.ts
 * --------------
 * Stands up a complete Arena: the shared library, the router, and every part,
 * wired together.
 *
 * Arena outgrew the EIP-170 24576-byte contract limit twice. The first time, the
 * heavy string builders moved into ArenaUtils as `public` functions, making it a
 * separately deployed library reached by delegatecall. That bought room but not
 * headroom, so Arena is now a ROUTER: it holds the storage and the funds and
 * answers the hot paths itself, and hands any other function to the part that
 * claims it. Parts run against the router's storage, so from the outside there
 * is still one Arena at one address.
 *
 * Two consequences for anyone deploying:
 *   - Arena cannot be deployed on its own. Its bytecode ships with a placeholder
 *     where the library address goes, and it answers nothing routed until the
 *     parts are wired. Always come through this function.
 *   - Wiring is only permitted while the arena is empty. That is trivially true
 *     for a fresh deploy and deliberately hard later — see setPart.
 */
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { toFunctionSelector, type Abi } from "viem";

type Hex = `0x${string}`;

/** Every part, in the order they are deployed and wired. */
export const ARENA_PARTS = ["ArenaVaultPart", "ArenaViewPart"] as const;

/** Function entries a part claims: its own, minus anything the router answers. */
function claimedSelectors(routerAbi: Abi, partAbi: Abi): Hex[] {
  const onRouter = new Set(
    routerAbi.filter((e) => e.type === "function").map((e) => toFunctionSelector(e as never)),
  );
  return partAbi
    .filter((e) => e.type === "function")
    .map((e) => toFunctionSelector(e as never))
    .filter((sel) => !onRouter.has(sel));
}

/**
 * Deploy ArenaUtils, the Arena router linked against it, and every part; then
 * point each part's functions at it.
 *
 * @returns the router address plus the library and part addresses — record them
 *          all in the manifest. Verifying or re-linking needs the library, and
 *          swapping a part later needs to know what is currently wired.
 */
export async function deployLinkedArena(
  hre: HardhatRuntimeEnvironment,
  args: unknown[],
  opts: { value?: bigint; quiet?: boolean } = {},
): Promise<{ address: Hex; arenaUtils: Hex; parts: Record<string, Hex> }> {
  const log = (m: string) => { if (!opts.quiet) console.log(m); };
  const utils = await hre.viem.deployContract("ArenaUtils");
  log(`  ArenaUtils:      ${utils.address}  (library)`);
  const libraries = { ArenaUtils: utils.address };

  const router = await hre.viem.deployContract("Arena", args as never, {
    ...(opts.value !== undefined ? { value: opts.value } : {}),
    libraries,
  } as never);
  log(`  Arena:           ${router.address}  (router)`);

  const routerAbi = (await hre.artifacts.readArtifact("Arena")).abi as Abi;
  const parts: Record<string, Hex> = {};

  for (const name of ARENA_PARTS) {
    const artifact = await hre.artifacts.readArtifact(name);
    // Only parts that actually call into ArenaUtils may be given the link —
    // passing it to one that does not is rejected outright.
    const needsUtils = Object.keys(artifact.linkReferences ?? {}).length > 0;
    const part = await hre.viem.deployContract(
      name, [], (needsUtils ? { libraries } : {}) as never,
    );
    const partAbi = artifact.abi as Abi;
    const selectors = claimedSelectors(routerAbi, partAbi);

    await router.write.setPart([selectors, part.address]);
    parts[name] = part.address as Hex;
    log(`  ${name}:  ${part.address}  (${selectors.length} functions)`);
  }

  return { address: router.address as Hex, arenaUtils: utils.address as Hex, parts };
}
