/**
 * set-personas.ts
 * ---------------
 * Pushes the V11 personas from personas.ts onto the live FighterRegistry via
 * `setPrompt`, and diffs desired against on-chain.
 *
 * Default mode is VERIFY (read-only). Writing requires --write.
 *
 * SAFETY INTERLOCK. The V11 personas name their actions in words and are only
 * correct when the Arena asks via `inferString` with a holdings-gated
 * `allowedValues`. Against the currently deployed Arena, which still calls
 * `inferNumber(0,6)` with a digit menu, a word answer contains no integer, the
 * clamp lands on 0 = Hold, and every fighter holds for the rest of the duel.
 *
 * So --write refuses to run unless the deployed Arena actually answers with
 * named actions, probed through previewTurnPrompt. That check is evidence, not
 * a flag somebody remembered to set. Override with --force only if you know why.
 *
 * It is deliberately a behavioural probe rather than a bytecode scan for the
 * inferString selector: solc does not store that selector as a searchable
 * literal, so the scan reported "absent" for an Arena that provably calls it.
 *
 * Run:
 *   pnpm exec hardhat run scripts/set-personas.ts --network somnia
 *   WRITE=1 pnpm exec hardhat run scripts/set-personas.ts --network somnia
 */
import hre from "hardhat";
import { createWalletClient, http, defineChain, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import fs from "fs";
import path from "path";
import { PERSONAS, PERSONA_NAMES, findPersonasWithDigits } from "./personas";

const REGISTRY_ABI = parseAbi([
  "function setPrompt(uint8 id, string systemPrompt) external",
  "function owner() view returns (address)",
  "function getFighter(uint8 id) view returns ((string name, string tagline, string systemPrompt, uint8 aggression, uint8 patience, uint8 risk))",
]);

const ARENA_ABI = parseAbi([
  "function previewTurnPrompt(uint256 duelId, uint8 fighterId) view returns (string prompt, string[] allowed)",
]);

const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (...a: unknown[]) => console.log(`[${ts()}]`, ...a);

async function main() {
  // `hardhat run` does not forward argv past the script name (HH305), so the
  // flags are env vars.
  const write = !!process.env.WRITE || process.argv.includes("--write");
  const force = !!process.env.FORCE || process.argv.includes("--force");

  // A digit in a persona is the exact hazard these prompts exist to remove.
  const dirty = findPersonasWithDigits();
  if (dirty.length > 0) {
    throw new Error(
      `personas ${dirty.join(", ")} contain a numeral; inferNumber would be able to extract it`,
    );
  }

  const deployments = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "deployments/somnia.json"), "utf8"),
  );
  const registry = deployments.contracts.FighterRegistry.address as `0x${string}`;
  const arena = deployments.contracts.Arena.address as `0x${string}`;

  const pub = await hre.viem.getPublicClient();
  const rpcUrl: string =
    (hre.network.config as { url?: string }).url ?? "https://api.infra.testnet.somnia.network";
  const chain = defineChain({
    id: hre.network.config.chainId ?? 50312,
    name: "somnia",
    nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

  log("registry:", registry);
  log("arena:   ", arena);

  // ── Interlock: does the deployed Arena ask for actions BY NAME? ───────────
  //
  // Checked behaviourally, not by scanning bytecode for the inferString
  // selector: solc does not store that selector as a searchable literal, so the
  // scan reported "not present" for an Arena that provably calls inferString.
  //
  // previewTurnPrompt exists only on the named-action Arena, and its allow-list
  // is built by the same code that fills allowedValues. If it answers with
  // action names, the Arena speaks names — which is what these personas need.
  let usesNames = false;
  try {
    const [, allowed] = (await pub.readContract({
      address: arena, abi: ARENA_ABI, functionName: "previewTurnPrompt", args: [BigInt(0), 0],
    })) as [string, string[]];
    usesNames = allowed.length > 0 && allowed.every((a) => /^[A-Za-z]+$/.test(a));
    log(`deployed Arena answer set: [${allowed.join(", ")}] -> named actions: ${usesNames}`);
  } catch {
    log("deployed Arena has no previewTurnPrompt — this is the old digit-menu Arena");
  }

  // ── Diff desired against on-chain ─────────────────────────────────────────
  const stale: number[] = [];
  for (let id = 0; id < PERSONAS.length; id++) {
    const f = (await pub.readContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: "getFighter",
      args: [id],
    })) as { name: string; systemPrompt: string };

    const same = f.systemPrompt === PERSONAS[id];
    if (!same) stale.push(id);
    const liveDigits = /\d/.test(f.systemPrompt) ? " [live prompt contains digits]" : "";
    console.log(
      `  ${id} ${f.name.padEnd(18)} ${same ? "up to date" : "DIFFERS"}` +
        ` (on-chain ${f.systemPrompt.length}b, desired ${PERSONAS[id].length}b)${liveDigits}`,
    );
    if (f.name !== PERSONA_NAMES[id]) {
      log(`  note: registry name "${f.name}" does not match PERSONA_NAMES[${id}] "${PERSONA_NAMES[id]}"`);
    }
  }

  if (stale.length === 0) {
    log("all six personas already match. nothing to do.");
    return;
  }
  log(`${stale.length} persona(s) differ: ${stale.join(", ")}`);

  if (!write) {
    log("verify mode. re-run with WRITE=1 to push.");
    return;
  }

  if (!usesNames && !force) {
    throw new Error(
      "REFUSING TO WRITE. The deployed Arena does not offer named actions, so it " +
        "still asks for a digit. Word-named personas would yield no extractable " +
        "integer, clamp to 0, and make every fighter Hold for the whole duel. " +
        "Deploy the Arena change first, or pass --force if you know why.",
    );
  }

  const key = process.env.PRIVATE_KEY as `0x${string}`;
  if (!key) throw new Error("PRIVATE_KEY not set");
  const account = privateKeyToAccount(key);

  const owner = (await pub.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "owner",
  })) as `0x${string}`;
  if (owner.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(`not registry owner: signer ${account.address}, owner ${owner}`);
  }

  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  for (const id of stale) {
    const hash = await wallet.writeContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: "setPrompt",
      args: [id, PERSONAS[id]],
    });
    await pub.waitForTransactionReceipt({ hash });
    log(`set persona ${id} (${PERSONA_NAMES[id]})  ${hash}`);
  }
  log("done. re-run without --write to confirm all six read back as up to date.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
