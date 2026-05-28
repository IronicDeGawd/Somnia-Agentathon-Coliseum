import hre from "hardhat";
async function main() {
  const pub = await hre.viem.getPublicClient();
  const bn = await pub.getBlockNumber();
  console.log("block:", bn, "mod 600 =", Number(bn % 600n), "next tick block:", bn + (600n - bn % 600n));
}
main().catch(console.error);
