import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-viem";
import "@nomicfoundation/hardhat-verify";
import "@nomicfoundation/hardhat-chai-matchers";
import "@typechain/hardhat";
import "@openzeppelin/hardhat-upgrades";
import "hardhat-gas-reporter";
import * as dotenv from "dotenv";
import * as fs from "fs";

// Load .env first, then .env.local as fallback
dotenv.config();
if (fs.existsSync('.env.local')) {
  dotenv.config({ path: '.env.local', override: false });
}

// Build Alchemy URLs using ALCHEMY_API_KEY
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || "";
const getAlchemyUrl = (network: string) =>
  ALCHEMY_API_KEY ? `https://${network}.g.alchemy.com/v2/${ALCHEMY_API_KEY}` : "";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test/evm",
    cache: "./cache",
    artifacts: "./artifacts"
  },
  networks: {
    hardhat: {
      chainId: 1337
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 1337
    },

    // Ethereum Networks
    mainnet: {
      url: getAlchemyUrl("eth-mainnet"),
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 1,
      gasPrice: "auto",
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || getAlchemyUrl("eth-sepolia") || "https://ethereum-sepolia-rpc.publicnode.com",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 11155111,
      gasPrice: "auto",
    },

    // Polygon Networks
    polygon: {
      url: getAlchemyUrl("polygon-mainnet"),
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 137,
      gasPrice: "auto",
    },

    // Optimism Networks
    optimism: {
      url: getAlchemyUrl("opt-mainnet"),
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 10,
      gasPrice: "auto",
    },

    // Arbitrum Networks
    arbitrum: {
      url: getAlchemyUrl("arb-mainnet"),
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 42161,
      gasPrice: "auto",
    },

    // Base Networks
    base: {
      url: getAlchemyUrl("base-mainnet"),
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 8453,
      gasPrice: "auto",
    },
  },
  etherscan: {
    apiKey: {
      mainnet: process.env.ETHERSCAN_MULTICHAIN_API_KEY || process.env.ETHERSCAN_API_KEY || "",
      sepolia: process.env.ETHERSCAN_MULTICHAIN_API_KEY || process.env.ETHERSCAN_API_KEY || "",
      polygon: process.env.ETHERSCAN_MULTICHAIN_API_KEY || process.env.POLYGONSCAN_API_KEY || "",
      optimisticEthereum: process.env.ETHERSCAN_MULTICHAIN_API_KEY || process.env.OPTIMISTIC_ETHERSCAN_API_KEY || "",
      arbitrumOne: process.env.ETHERSCAN_MULTICHAIN_API_KEY || process.env.ARBISCAN_API_KEY || "",
      base: process.env.ETHERSCAN_MULTICHAIN_API_KEY || process.env.BASESCAN_API_KEY || "",
    },
    customChains: [
      {
        network: "base",
        chainId: 8453,
        urls: {
          apiURL: "https://api.basescan.org/api",
          browserURL: "https://basescan.org"
        }
      }
    ]
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS !== undefined,
    currency: "USD",
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
};

export default config;
