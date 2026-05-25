/**
 * Test 1 — Somnia Agents LLM Inference
 *
 * Steps:
 *   1. Deploy LLMInferenceTest to Somnia testnet (or reuse ADDRESS env var)
 *   2. Read required deposit from contract
 *   3. Call requestInference() with correct msg.value
 *   4. Poll for ResponseReceived / RequestFailed (up to 120s)
 *
 * Run: npm run test:agent
 * Env: PRIVATE_KEY required. Optional: LLM_CONTRACT_ADDRESS to skip deploy.
 */

import hre from "hardhat";
import "dotenv/config";

const TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 3_000;

async function main() {
  const [deployer] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();

  console.log("Wallet:", deployer.account.address);
  const balance = await publicClient.getBalance({ address: deployer.account.address });
  console.log("Balance:", Number(balance) / 1e18, "STT\n");

  // --- Deploy (or reuse) ---
  let contractAddress = process.env.LLM_CONTRACT_ADDRESS as `0x${string}` | undefined;

  if (!contractAddress) {
    console.log("Deploying LLMInferenceTest...");
    const contract = await hre.viem.deployContract("LLMInferenceTest");
    contractAddress = contract.address;
    console.log("Deployed at:", contractAddress);
    console.log("  (set LLM_CONTRACT_ADDRESS=" + contractAddress + " to skip next deploy)\n");
  } else {
    console.log("Reusing contract at:", contractAddress, "\n");
  }

  const contract = await hre.viem.getContractAt("LLMInferenceTest", contractAddress);

  // --- Read required deposit ---
  const deposit = (await contract.read.requiredDeposit()) as bigint;
  console.log("Required deposit:", Number(deposit) / 1e18, "STT");

  const walletBalance = await publicClient.getBalance({ address: deployer.account.address });
  if (walletBalance < deposit) {
    throw new Error(`Insufficient balance. Need ${Number(deposit)/1e18} STT, have ${Number(walletBalance)/1e18} STT`);
  }

  // --- Fire request ---
  console.log("Calling requestInference()...");
  // hardhat-viem write takes args array first, then tx overrides as last element
  const hash = await contract.write.requestInference([] as [], { value: deposit });
  console.log("TX hash:", hash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log("TX confirmed in block:", receipt.blockNumber.toString());

  const requestId = (await contract.read.lastRequestId()) as bigint;
  console.log("Request ID:", requestId.toString(), "\n");

  // --- Poll for callback ---
  console.log("Waiting for agent callback (up to 120s)...");
  const fromBlock = receipt.blockNumber;
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    const successes = await contract.getEvents.ResponseReceived({}, { fromBlock });
    if (successes.length > 0) {
      const ev = successes[0];
      const args = ev.args as Record<string, unknown>;
      console.log("\n✅ SUCCESS");
      console.log("  Request ID:", (args.requestId as bigint)?.toString());
      console.log("  LLM response:", args.response);

      const stored = await contract.read.lastResponse();
      console.log("  Stored on-chain:", stored);
      return;
    }

    const failures = await contract.getEvents.RequestFailed({}, { fromBlock });
    if (failures.length > 0) {
      const ev = failures[0];
      const args = ev.args as Record<string, unknown>;
      console.log("\n❌ FAILED — status:", args.status);
      process.exit(1);
    }

    process.stdout.write(".");
    await sleep(POLL_INTERVAL_MS);
  }

  console.log("\n⏰ TIMEOUT — no callback after 120s");
  console.log("Check: https://shannon-explorer.somnia.network/tx/" + hash);
  process.exit(1);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => { console.error(e); process.exit(1); });
