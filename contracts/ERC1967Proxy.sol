// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

// Re-export OpenZeppelin's ERC1967Proxy for testing
// This allows tests to deploy proxies using viem.deployContract("ERC1967Proxy", [...])
