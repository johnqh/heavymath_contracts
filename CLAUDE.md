# CLAUDE.md - Heavymath Contracts

This file provides context for Claude Code when working on this project.

## Project Overview

Prediction market smart contracts for EVM chains with TypeScript SDK. Features a novel percentage-based prediction mechanism with equilibrium-based settlement.

- **Package**: `@sudobility/heavymath_contracts`
- **Stack**: Solidity 0.8.24, Hardhat, Viem 2, TypeScript
- **License**: BUSL-1.1
- **Package manager**: Bun

## Quick Commands

```bash
bun run compile:evm        # Compile Solidity contracts
bun run build              # Build everything (contracts + TS SDK)
bun run test:evm           # Run Hardhat test suite
bun run lint               # ESLint check
bun run typecheck          # TypeScript validation
bun run format             # Prettier formatting
```

## Project Structure

```
heavymath_contracts/
├── contracts/                    # Solidity source
│   ├── PredictionMarket.sol          # Core market logic (876 lines, UUPS)
│   ├── DealerNFT.sol                 # ERC721 license system (214 lines, UUPS)
│   ├── OracleResolver.sol            # Oracle integration (257 lines, UUPS)
│   ├── MockUSDC.sol                  # Test token (6 decimals)
│   └── ERC1967Proxy.sol              # Proxy re-export
├── src/                          # TypeScript SDK
│   ├── evm/index.ts                  # EVMPredictionClient
│   ├── unified/index.ts              # Unified client (wraps EVM)
│   └── solana/index.ts               # Placeholder (future)
├── test/evm/                     # Test suites
│   ├── PredictionMarket.test.ts      # Market lifecycle tests
│   ├── DealerNFT.test.ts            # NFT permission tests
│   ├── EquilibriumUSDC.test.ts       # Equilibrium algorithm tests
│   ├── ClientIntegration.test.ts     # SDK integration tests
│   └── utils/fixture.ts             # Shared test setup
├── scripts/evm/                  # Deployment & upgrade scripts
│   ├── deploy.ts                     # Deploy proxies
│   ├── upgrade.ts                    # UUPS upgrade
│   └── verify.ts                     # Etherscan verification
├── typechain-types/              # Generated contract types
├── hardhat.config.cts            # Hardhat configuration
├── DEPLOYED.json                 # Deployment addresses by network
└── .env.example                  # Environment template
```

## Smart Contracts

### PredictionMarket.sol (Core)
- UUPS upgradeable with reentrancy guard and pausable
- Market lifecycle: Active → Resolved/Cancelled/Abandoned
- ERC20 stake token (USDC, 6 decimals)
- Requires DealerNFT for market creation

**Key functions:**
- `createMarket(tokenId, category, subCategory, deadline, description, oracleId)`
- `placePrediction(marketId, percentage, amount)` - percentage is 0-100
- `updatePrediction(marketId, newPercentage, additionalAmount)` - 5-min grace period
- `withdrawPrediction(marketId)` - before deadline only
- `resolveMarket(marketId, resolution)` - manual resolution by dealer
- `resolveMarketWithOracle(marketId)` - automated oracle resolution
- `claimWinnings(marketId)` / `claimRefund(marketId)`
- `abandonMarket(marketId)` - after 24h grace period if unresolved

### DealerNFT.sol
- ERC721 NFT-based licensing for market creation
- Permission system with category/subcategory validation
- Wildcard: `0xFF` means "all categories"

### OracleResolver.sol
- Oracle types: Manual (0), PriceFeed (1), CustomData (2)
- Normalizes raw values to 0-100 percentage
- Staleness detection with configurable periods

## Core Algorithm: Equilibrium Calculation

The novel prediction mechanism uses percentage-based odds (0-100), not binary bets.

**Algorithm** (`calculateEquilibrium`): O(101) linear search
1. Calculate cumulative totals for each percentage (0-100)
2. For each point p, find where: `total_below / total_above ≈ percentage / (100 - percentage)`
3. Return p with minimal difference

**Settlement:**
1. Calculate equilibrium point
2. If one-sided market → auto-cancel, all refunded
3. If outcome > equilibrium → predictors above win
4. If outcome < equilibrium → predictors below win
5. If outcome == equilibrium → all refunded

**Fee System:**
- Dealer fee: 0.1%-2% (configurable, default 0.1%)
- System fee: 10% of dealer fee
- Fees only on distributable pool (total - equilibrium stakes)
- Equilibrium stakes auto-refunded (no fee)

## TypeScript SDK (EVMPredictionClient)

```typescript
const client = new EVMPredictionClient(contractAddresses);
await client.createMarket(wallet, params);
await client.placePrediction(wallet, marketId, percentage, amount);
// Handles ERC20 approval automatically before predictions
```

## Deployment

```bash
bun run deploy:evm:sepolia     # Deploy to Sepolia
bun run deploy:evm:mainnet     # Deploy to mainnet
bun run upgrade:evm:sepolia    # Upgrade UUPS proxy
bun run verify:evm:sepolia     # Verify on Etherscan
```

**Required env vars**: `PRIVATE_KEY`, `USDC_ADDRESS`, optionally `OWNER_MULTISIG`

## Supported Networks

Ethereum, Sepolia, Polygon, Arbitrum, Optimism, Base

## Test Fixture

`test/evm/utils/fixture.ts` provides `deployPredictionFixture()`:
- Deploys all 3 contracts as UUPS proxies
- Creates 6 wallet accounts (owner, 2 dealers, 3 predictors)
- Mints MockUSDC to all accounts
- Sets dealer NFT permissions

## Dependencies

- `@openzeppelin/contracts-upgradeable` 5.0.0
- `viem` 2.38.4
- `hardhat` 2.26.3
- `@nomicfoundation/hardhat-viem` 2.0.0

## CI/CD

Uses `johnqh/workflows/.github/workflows/unified-cicd.yml@main` with automatic NPM publishing.
