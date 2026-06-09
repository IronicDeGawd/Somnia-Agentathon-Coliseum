// ============================================================================
// Generate a dedicated bot wallet and write it to coliseum/.env.
// ----------------------------------------------------------------------------
// Generic version of gen-injector-key.mjs: the env var name is the first arg.
// Used for bots that must run on their own key (separate from the deployer) to
// avoid nonce contention — e.g. the simulated-market injector and the house
// matchmaking bot.
//
// Idempotent: if <VAR> already exists in coliseum/.env, prints that wallet's
// address and changes nothing. Otherwise generates a fresh key, appends it to
// .env, and prints the new address. The private key is written ONLY to .env and
// never printed — stdout carries just the public address (which you then fund).
//
// Run from coliseum/:  node scripts/gen-bot-key.mjs HOUSE_PRIVATE_KEY
// ============================================================================
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const varName = process.argv[2];
if (!varName || !/^[A-Z0-9_]+$/.test(varName)) {
  console.error("usage: node scripts/gen-bot-key.mjs <ENV_VAR_NAME>");
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, "..", ".env");

let env = "";
try { env = fs.readFileSync(envPath, "utf8"); } catch { /* no .env yet */ }

const existing = env.match(new RegExp(`^${varName}=(0x[0-9a-fA-F]{64})\\s*$`, "m"));
if (existing) {
  const acc = privateKeyToAccount(existing[1]);
  console.log("EXISTING " + acc.address);
} else {
  const pk = generatePrivateKey();
  const acc = privateKeyToAccount(pk);
  const prefix = env.length && !env.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(envPath, prefix + varName + "=" + pk + "\n");
  console.log("CREATED " + acc.address);
}
