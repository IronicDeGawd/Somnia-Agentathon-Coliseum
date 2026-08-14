/**
 * start-event-duel.ts
 * -------------------
 * Start a house event fight on the currently bound prediction desks.
 *
 * The creator funds it, so the operator wallet must approve Arena for USDso.
 * A 6-round fight trades the SOMI coin book plus the ETH question; 9 and 15
 * add the BTC question.
 *
 *   TURNS=6 A=0 B=1 pnpm exec hardhat run scripts/start-event-duel.ts --network somnia
 */
import hre from "hardhat";
import { formatEther, maxUint256 } from "viem";
import fs from "fs";
import path from "path";

const ERC20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

async function main() {
  const turns = Number(process.env.TURNS ?? "6");
  const a = Number(process.env.A ?? "0");
  const b = Number(process.env.B ?? "1");

  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "deployments", `${hre.network.name}.json`), "utf-8"));
  const arenaAddr = manifest.contracts.Arena.address as `0x${string}`;

  const pub = await hre.viem.getPublicClient();
  const [wallet] = await hre.viem.getWalletClients();
  const arena = await hre.viem.getContractAt("Arena", arenaAddr);
  const usdso = (await arena.read.USDSO()) as `0x${string}`;

  if (!(await arena.read.eventPoolsSet())) throw new Error("no event desks registered — run bind-event-window.ts");

  const stake = (await arena.read.minDepositForEvent([turns])) as bigint;
  const fee = (await arena.read.platformFee([turns])) as bigint;
  const need = stake + fee;
  const bal = (await pub.readContract({ address: usdso, abi: ERC20, functionName: "balanceOf", args: [wallet.account.address] })) as bigint;
  console.log(`${turns} rounds: stake ${formatEther(stake)} + fee ${formatEther(fee)} = ${formatEther(need)} USDso`);
  console.log(`operator holds ${formatEther(bal)}`);
  if (bal < need) throw new Error("operator is short of USDso");

  const allowance = (await pub.readContract({ address: usdso, abi: ERC20, functionName: "allowance", args: [wallet.account.address, arenaAddr] })) as bigint;
  if (allowance < need) {
    const h = await wallet.writeContract({ address: usdso, abi: ERC20, functionName: "approve", args: [arenaAddr, maxUint256] });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log("approved Arena to spend USDso");
  }

  const hash = await arena.write.startEventDuel([a, b, turns]);
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(`startEventDuel tx ${hash} (block ${r.blockNumber})`);

  const ids = (await arena.read.getActiveDuelIds()) as bigint[];
  const duelId = ids[ids.length - 1];
  console.log(`duel #${duelId} is live`);

  // The prompt each fighter will actually be asked with — the proof that a
  // question reads as odds and not as a price.
  for (const f of [a, b]) {
    const [prompt, allowed] = (await arena.read.previewTurnPrompt([duelId, f])) as [string, string[]];
    console.log(`\nfighter ${f}:\n  ${prompt}\n  allowed: ${allowed.join(", ")}`);
    if (/[0-9]/.test(prompt)) console.log("  WARNING: a digit reached the prompt");
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.shortMessage ?? e); process.exit(1); });
