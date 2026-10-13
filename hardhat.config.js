require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");

// A public testnet is configured from the environment so no key is ever written to the repo:
//   KANOPY_RPC_URL       the network's JSON-RPC endpoint
//   KANOPY_DEPLOYER_KEY  the private key that deploys and attests
//   KANOPY_STEWARD_KEY   (optional) a second key that makes the demonstration claim
const keys = [process.env.KANOPY_DEPLOYER_KEY, process.env.KANOPY_STEWARD_KEY].filter(Boolean);

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris" },
  },
  networks: {
    localhost: { url: "http://127.0.0.1:8545" },
    ...(process.env.KANOPY_RPC_URL ? { testnet: { url: process.env.KANOPY_RPC_URL, accounts: keys } } : {}),
  },
};
