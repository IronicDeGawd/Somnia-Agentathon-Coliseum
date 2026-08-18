/**
 * probe-reactivity-oneshot.ts — measure a one-shot BlockTick before trusting it.
 *
 * Answers, with numbers rather than docs:
 *   1. does eventTopics[1] = <block number> fire ONCE at that block?
 *   2. can the handler chain the next hop?
 *   3. how late is it?
 *   4. what does a hop cost — and so what would gating by fight really cost?
 *
 * MEASURED 2026-08-18 on Somnia testnet: 4 hops armed, 4 firings, each landing
 * on EXACTLY the requested block (0 blocks late), at 0.0045 STT per firing —
 * which includes the 210,000-gas subscribe for the next hop. The one-shot topic
 * behaves as documented.
 *
 * Safety: hop-capped, small gasLimit, and stop() is called at the end whatever
 * happens. Spends real testnet STT.
 *
 *   STRIDE=30 HOPS=5 FUND=35 pnpm exec hardhat run scripts/probe-reactivity-oneshot.ts --network somnia
 */
import hre from "hardhat";
import { formatEther, parseEther } from "viem";

const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

async function main() {
  const stride = Number(process.env.STRIDE ?? "30");     // blocks between hops (~3 s)
  const hops   = Number(process.env.HOPS ?? "5");
  const fund   = process.env.FUND ?? "35";               // docs: 32 SOMI minimum balance
  const watchS = Number(process.env.WATCH_S ?? "90");

  const pub = await hre.viem.getPublicClient();
  const [wallet] = await hre.viem.getWalletClients();
  log(`deployer ${wallet.account.address}  balance ${formatEther(await pub.getBalance({ address: wallet.account.address }))} STT`);

  const spike = await hre.viem.deployContract("ReactivitySpike", [BigInt(stride), hops], {
    value: parseEther(fund),
  });
  log(`spike ${spike.address}  stride ${stride} blocks  maxHops ${hops}  funded ${fund} STT`);

  const before = await pub.getBalance({ address: spike.address });
  const armBlock = await pub.getBlockNumber();
  const h = await spike.write.arm();
  await pub.waitForTransactionReceipt({ hash: h });
  log(`armed at block ${armBlock} for block ${armBlock + BigInt(stride)} — subscription ${await spike.read.subscriptionId()}`);

  // Poll rather than wait on logs: if the topic is IGNORED and this behaves like
  // the every-block subscription, `firings` runs away from `hops` and that is the
  // finding — so the counters matter more than any single event.
  const deadline = Date.now() + watchS * 1000;
  let lastF = 0;
  while (Date.now() < deadline) {
    const f = Number(await spike.read.firings());
    const hp = Number(await spike.read.hops());
    if (f !== lastF) {
      const bal = await pub.getBalance({ address: spike.address });
      const blk = await pub.getBlockNumber();
      log(`  firings=${f} hops=${hp} block=${blk} balance=${formatEther(bal)} STT  spent=${formatEther(before - bal)}`);
      lastF = f;
      if (f > hops + 2) { log("  !! firing far more often than armed — topic appears ignored"); break; }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  const firings = Number(await spike.read.firings());
  const hopsDone = Number(await spike.read.hops());
  const after = await pub.getBalance({ address: spike.address });

  log("");
  log(`RESULT  armed ${hopsDone} hop(s), fired ${firings} time(s)`);
  log(`        spent ${formatEther(before - after)} STT total`);
  if (firings > 0) log(`        ${formatEther((before - after) / BigInt(firings))} STT per firing`);
  log(firings === 0
    ? "        NOTHING FIRED — one-shot did not deliver, or is deferred behind other traffic"
    : firings <= hopsDone + 1
      ? "        one firing per hop — the one-shot topic WORKS"
      : "        fired more often than armed — behaves like every-block");

  // Always clean up, and record whether unsubscribe is real.
  try {
    const s = await spike.write.stop();
    await pub.waitForTransactionReceipt({ hash: s });
    log("        stop() sent — unsubscribe path exercised");
  } catch (e) {
    log(`        stop() failed: ${(e as Error).message.split("\n")[0]}`);
  }
  const d = await spike.write.drain();
  await pub.waitForTransactionReceipt({ hash: d });
  log(`        drained; spike balance now ${formatEther(await pub.getBalance({ address: spike.address }))} STT`);

  // Print the log trail so lateness is visible.
  // The RPC caps a log query at 1000 blocks, so walk it in chunks.
  const head = await pub.getBlockNumber();
  const fired: unknown[] = [];
  for (let from = armBlock; from <= head; from += 1000n) {
    const to = from + 999n > head ? head : from + 999n;
    fired.push(...(await pub.getContractEvents({
      address: spike.address, abi: spike.abi, eventName: "Fired", fromBlock: from, toBlock: to,
    })));
  }
  for (const ev of fired as unknown as { args: Record<string, bigint> }[]) {
    const a = ev.args;
    log(`  Fired #${a.firing} hop ${a.hop}: armed for ${a.armedAtBlock}, fired at ${a.firedAtBlock} (late by ${Number(a.firedAtBlock) - Number(a.armedAtBlock)} blocks)`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
