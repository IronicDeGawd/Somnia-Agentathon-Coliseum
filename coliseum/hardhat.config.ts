import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-viem";
import "dotenv/config";

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
