import hre from "hardhat";
async function main() {
  const pub = await hre.viem.getPublicClient();
  const block = await pub.getBlock();
  console.log("baseFeePerGas:", block.baseFeePerGas?.toString(), "wei");
  console.log("In gwei:", Number(block.baseFeePerGas ?? 0n) / 1e9);
}
main().catch(console.error);
