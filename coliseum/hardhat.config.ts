import { HardhatUserConfig, task } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-viem";
import "dotenv/config";

import { mergeArenaAbi } from "./scripts/lib/mergeArenaAbi";

// Arena is a router plus parts sharing one address. The compiler only sees the
// router's own four functions, so without this every script and bot that asks
// the toolchain what Arena can do would fail to encode a call to startDuel.
task("compile", async (args, hre, runSuper) => {
  await runSuper(args);
  mergeArenaAbi(hre.config.paths.artifacts);
});

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.24",
        settings: { viaIR: true, optimizer: { enabled: true, runs: 200 } },
      },
      {
        version: "0.8.30",
        settings: { viaIR: true, optimizer: { enabled: true, runs: 200 } },
      },
    ],
  },
  networks: {
    somnia: {
      url: "https://api.infra.testnet.somnia.network",
      chainId: 50312,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    localhost: {
      url: "http://127.0.0.1:8545",
    },
  },
  paths: {
    sources: "./contracts",
  },
};

export default config;
