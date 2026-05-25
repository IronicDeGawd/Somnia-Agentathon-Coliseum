import hre from "hardhat";

type Fighter = {
  name: string;
  tagline: string;
  systemPrompt: string;
  aggression: bigint;
  patience: bigint;
  risk: bigint;
};

async function main() {
  console.log("Deploying FighterRegistry to network:", hre.network.name);

  const walletClients = await hre.viem.getWalletClients();
  if (!walletClients.length) throw new Error("No wallet clients — set PRIVATE_KEY in .env");

  const registry = await hre.viem.deployContract("FighterRegistry");
  console.log("FighterRegistry deployed at:", registry.address);

  const fighter0 = (await registry.read.getFighter([0])) as Fighter;
  console.log("Fighter 0 name:", fighter0.name);
  console.log("Fighter 0 tagline:", fighter0.tagline);
  console.log("Fighter 0 aggression/patience/risk:", fighter0.aggression, fighter0.patience, fighter0.risk);

  const count = (await registry.read.FIGHTER_COUNT()) as bigint;
  console.log("Verification: FIGHTER_COUNT =", count.toString());
}

main().catch((err) => {
  console.error("deploy-registry failed:", err);
  process.exitCode = 1;
});
