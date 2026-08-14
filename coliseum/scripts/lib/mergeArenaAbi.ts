/**
 * mergeArenaAbi.ts
 * ----------------
 * Makes the compiled description of Arena tell the truth.
 *
 * Arena is one address made of a router plus several parts. The router's own
 * bytecode implements almost nothing — it forwards by function selector — so the
 * compiler describes it as a contract with four functions. Anything that asks
 * the toolchain "what can I call on Arena?" would get that answer and fail to
 * encode a call to startDuel, which is exactly the sort of breakage the split
 * was supposed to keep invisible.
 *
 * After every compile this folds each part's functions, events and errors into
 * Arena's own description. Bytecode and library links are left untouched — only
 * the interface is widened, and only to what is genuinely reachable at Arena's
 * address.
 *
 * Deduplicated by selector, so re-running is harmless.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { toFunctionSelector, toEventSelector } from "viem";

type AbiEntry = { type: string; name?: string };

const ROUTER = "contracts/Arena.sol/Arena.json";
const PART_PATHS = [
  "contracts/parts/ArenaVaultPart.sol/ArenaVaultPart.json",
  "contracts/parts/ArenaDuelPart.sol/ArenaDuelPart.json",
  "contracts/parts/ArenaTurnPart.sol/ArenaTurnPart.json",
  "contracts/parts/ArenaViewPart.sol/ArenaViewPart.json",
];

/** Stable identity for an ABI entry, so the same function is never added twice. */
function key(entry: AbiEntry): string | null {
  try {
    if (entry.type === "function") return `f:${toFunctionSelector(entry as never)}`;
    if (entry.type === "event") return `e:${toEventSelector(entry as never)}`;
    if (entry.type === "error") return `x:${entry.name}`;
  } catch {
    return null;
  }
  return null;
}

/** The key under which Arena's own, unmerged interface is preserved. */
export const OWN_ABI_KEY = "routerOwnAbi";

export function mergeArenaAbi(artifactsRoot: string): void {
  const routerPath = join(artifactsRoot, ROUTER);
  if (!existsSync(routerPath)) return;

  const router = JSON.parse(readFileSync(routerPath, "utf8"));

  // Keep what the router's own bytecode actually dispatches. Deployment needs
  // it to work out which functions each part should claim; asking the widened
  // interface would say "the router already handles everything", nothing would
  // be wired, and every routed call would revert. Written only once — a
  // recompile rewrites the artifact from scratch and this is set again from the
  // fresh, unmerged interface.
  // A copy, not a reference: the merge below pushes into router.abi, which would
  // otherwise grow this too and leave no record of what the router really has.
  if (!router[OWN_ABI_KEY]) router[OWN_ABI_KEY] = [...router.abi];

  const seen = new Set<string>();
  for (const entry of router.abi as AbiEntry[]) {
    const k = key(entry);
    if (k) seen.add(k);
  }

  let added = 0;
  for (const rel of PART_PATHS) {
    const p = join(artifactsRoot, rel);
    if (!existsSync(p)) continue;
    const part = JSON.parse(readFileSync(p, "utf8"));
    for (const entry of part.abi as AbiEntry[]) {
      const k = key(entry);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      router.abi.push(entry);
      added++;
    }
  }

  writeFileSync(routerPath, JSON.stringify(router, null, 2));
}

/**
 * What the Arena router's own bytecode dispatches, as opposed to the widened
 * interface consumers see. Deployment uses this to decide what each part claims.
 */
export function routerOwnAbi(artifactsRoot: string): AbiEntry[] {
  const router = JSON.parse(readFileSync(join(artifactsRoot, ROUTER), "utf8"));
  return (router[OWN_ABI_KEY] ?? router.abi) as AbiEntry[];
}
