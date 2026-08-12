/**
 * deployArena.ts
 * --------------
 * Deploys ArenaUtils and links it into Arena.
 *
 * Arena outgrew the EIP-170 24576-byte contract limit once the prompt layer
 * moved to named actions. The fix was to make the heavy string builders
 * (`legalActions`, `buildMarketSummary`) `public` on ArenaUtils, which turns
 * them into a separately deployed library reached by delegatecall instead of
 * bytecode inlined into Arena. That took Arena from 24844 bytes (over the
 * limit) to 22089 — smaller than it was before the change.
 *
 * The cost is that Arena can no longer be deployed on its own: its bytecode
 * ships with a placeholder where the library address goes. Every Arena
 * deployment must go through this function, or it fails with
 * MissingLibraryAddressError.
 */
import type { HardhatRuntimeEnvironment } from "hardhat/types";

type Hex = `0x${string}`;

/**
 * Deploy ArenaUtils, then Arena linked against it.
 * @returns the Arena contract and the library address — record the library in the
 *          manifest, since verifying or re-linking Arena later needs to know it.
 */
export async function deployLinkedArena(
  hre: HardhatRuntimeEnvironment,
  args: unknown[],
  opts: { value?: bigint } = {},
): Promise<{ address: Hex; arenaUtils: Hex }> {
  const utils = await hre.viem.deployContract("ArenaUtils");
  console.log(`  ArenaUtils:      ${utils.address}  (library)`);

  const arena = await hre.viem.deployContract("Arena", args as never, {
    ...(opts.value !== undefined ? { value: opts.value } : {}),
    libraries: { ArenaUtils: utils.address },
  } as never);

  return { address: arena.address as Hex, arenaUtils: utils.address as Hex };
}
