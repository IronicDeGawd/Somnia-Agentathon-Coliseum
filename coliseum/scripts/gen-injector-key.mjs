// ============================================================================
// Generate a dedicated wallet for the simulated-market price injector.
// ----------------------------------------------------------------------------
// The injector fires ~9 txs every tick; running it on the deployer key would
// collide on nonces with the watcher (which referees duels via turn() on that
// same key). So the injector gets its own throwaway wallet: it only calls the
// permissionless MockSpotPool setters, holds no custody, and just needs gas.
//
// Idempotent: if SIM_MARKET_PRIVATE_KEY already exists in coliseum/.env, this
// prints that wallet's address and changes nothing. Otherwise it generates a
// fresh key, appends it to .env, and prints the new address.
//
// The private key is written ONLY to .env and never printed — stdout carries
// just the public address (which you then fund with STT for gas).
//
// Run from coliseum/:  node scripts/gen-injector-key.mjs
// ============================================================================
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, "..", ".env");

let env = "";
try { env = fs.readFileSync(envPath, "utf8"); } catch { /* no .env yet */ }

const existing = env.match(/^SIM_MARKET_PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m);
if (existing) {
  const acc = privateKeyToAccount(existing[1]);
  console.log("EXISTING " + acc.address);
} else {
  const pk = generatePrivateKey();
  const acc = privateKeyToAccount(pk);
  const prefix = env.length && !env.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(envPath, prefix + "SIM_MARKET_PRIVATE_KEY=" + pk + "\n");
  console.log("CREATED " + acc.address);
}
