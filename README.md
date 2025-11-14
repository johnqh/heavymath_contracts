# HeavyMath Prediction Market Contracts

Multi-chain prediction market system with percentage-based odds and equilibrium calculation. Supports both EVM chains and Solana.

## Features

- **Novel Prediction Mechanism**: Predictors specify percentage-based odds instead of binary yes/no
- **Equilibrium Algorithm**: Automatically determines market sides based on bet distribution
- **Multi-Chain Support**: Unified TypeScript client for EVM and Solana
- **UUPS Upgradeable**: Contracts can be upgraded post-deployment for bug fixes and improvements
- **Oracle Integration**: Chainlink (EVM) and Switchboard (Solana) for result resolution
- **Dealer NFT System**: NFT-based permissions for creating prediction markets
- **USDC Settlement**: EVM markets accept ERC20 deposits (USDC by default) with SafeERC20 handling and pre-deadline withdrawals
- **Safety Valves**: Dealers (or the contract owner) can cancel empty markets, anyone can abandon unresolved markets after a grace period, and the system auto-refunds if equilibrium has no opposing side

## Architecture

### Smart Contracts

**EVM (Ethereum, Polygon, Arbitrum, Base)**:
- `DealerNFT`: UUPS upgradeable NFT granting market creation permissions
- `PredictionMarket`: UUPS upgradeable contract managing all prediction markets
  - Requires a configured ERC20 stake token (USDC) during initialization
  - Supports `withdrawPrediction`, `cancelMarket`, and `abandonMarket` flows for safer user refunds
  - Dealer and system fees are accrued and withdrawn in the stake token

**Solana** (Coming soon):
- Anchor programs for NFT and prediction market functionality

### TypeScript Client

Three-layer architecture:
- **EVM Client**: Direct interaction with EVM contracts using viem
- **Solana Client**: Direct interaction with Solana programs
- **Unified Client**: Chain-agnostic interface working across both chains

## Installation

```bash
npm install @heavymath/prediction-contracts
```

## Usage

### EVM Example

```typescript
import { createWalletClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import { PredictionClient } from '@heavymath/prediction-contracts';

const walletClient = createWalletClient({
  chain: sepolia,
  transport: http()
});

const client = new PredictionClient({
  predictionMarket: "0xPredictionMarketProxy",
  stakeToken: "0xUSDCAddress"
});

// Create a prediction market through the EVM client
await client.evm.createMarket(
  { walletClient, publicClient },
  {
    tokenId: 1n,
    category: 1n,
    subCategory: 2n,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 86_400),
    description: "Team A wins",
    oracleId: "0x0000000000000000000000000000000000000000000000000000000000000000"
  }
);

// Place a prediction (handles USDC approval automatically)
await client.evm.placePrediction(
  { walletClient, publicClient },
  1n,
  60,
  1_000_000n // 1 USDC (6 decimals)
);
```

## Development

### Setup

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env
# Edit .env with your configuration

# Compile contracts
npm run compile:evm

# Run tests
npm run test:evm
```

### Build

```bash
# Build all
npm run build

# Build specific components
npm run build:evm      # Contracts + EVM client
npm run build:solana   # Solana programs + client
npm run build:unified  # Unified client
```

### Testing

```bash
# Run all tests
npm test

# Run specific tests
npm run test:evm      # EVM contract tests
npm run test:solana   # Solana program tests
npm run test:unified  # Unified client tests

# Run PredictionClient example (requires env vars)
PRIVATE_KEY=0x... \
PREDICTION_MARKET=0x... \
USDC_ADDRESS=0x... \
node --loader ts-node/esm examples/evm/prediction-client.ts
```

### Deployment

#### EVM

```bash
# Deploy to Sepolia testnet
npm run deploy:evm:sepolia

# Verify on Etherscan
npm run verify:evm:sepolia

# Upgrade contracts
npm run prepare-upgrade:evm  # Validate upgrade first
npm run upgrade:evm:sepolia
```

##### Stake Token & Governance Checklist

| Network        | USDC Token Address                                   | Notes                              |
| -------------- | ---------------------------------------------------- | ---------------------------------- |
| Ethereum Mainnet | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`        | Set contract owner to multisig     |
| Base Mainnet     | `0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA`        | Confirm Circle native USDC         |
| Arbitrum One     | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`        |                                     |
| Sepolia (test)   | Deploy MockUSDC or use native test USDC address     | Configure `USDC_ADDRESS` env var   |

Deployment scripts must be provided with `USDC_ADDRESS` and `OWNER_MULTISIG` environment variables so the PredictionMarket initializer receives the correct stake token and ownership is transferred to a multi-sig immediately after deployment.

#### Solana

```bash
# Deploy to Devnet
npm run deploy:solana:devnet

# Deploy to Mainnet
npm run deploy:solana:mainnet
```

## Project Structure

```
heavymath_contracts/
├── contracts/              # Solidity contracts (EVM)
├── programs/              # Anchor programs (Solana)
├── src/                   # TypeScript clients
│   ├── evm/              # EVM client
│   ├── solana/           # Solana client
│   ├── unified/          # Unified client
│   └── utils/
├── test/                  # Tests
├── scripts/               # Deployment scripts
└── examples/              # Usage examples
```

## How It Works

### Prediction Mechanism

Unlike traditional binary prediction markets, predictors specify a percentage (0-100) representing their desired odds:

- **50%**: Willing to bet at 1:1 odds on either side
- **25%**: Willing to bet at 1:3 odds (risk 1 to win 3)
- **75%**: Willing to bet at 3:1 odds (risk 3 to win 1)

### Equilibrium Algorithm

At the prediction deadline, the system calculates an equilibrium point where:
```
total_below_equilibrium / total_above_equilibrium = equilibrium / (100 - equilibrium)
```

Predictions below the equilibrium bet on the negative outcome, predictions above bet on the positive outcome. If everyone predicts at the same percentage, all bets are refunded.

### Payout

Winners share the losers' stakes proportionally:
```
payout = stake + (stake / total_winner_side) * total_loser_side - fees
```

Fees:
- Dealer fee: 0.1% - 2% (dealer sets within bounds)
- System fee: 10% of dealer fee

### Lifecycle Safety

- **ERC20 Escrows**: EVM markets require an ERC20 stake token (USDC by default). All deposits, claims, and fee withdrawals use SafeERC20 transfers to avoid ETH mismatches.
- **Withdraw Prediction**: Users can call `withdrawPrediction(marketId)` any time before the deadline to reclaim their entire stake.
- **Cancellation & Abandonment**: Dealers (or the owner) can `cancelMarket` when no wagers exist, and anyone can call `abandonMarket` after the resolution grace period to trigger full refunds if an oracle or dealer disappears.
- **Oracle Timestamp Guardrails**: `resolveMarketWithOracle` verifies that oracle data was produced after the prediction deadline, so stale feeds can’t settle markets prematurely.

## Security

- UUPS upgradeable proxy pattern for post-deployment fixes
- Comprehensive access control
- Reentrancy protection
- Oracle timeout mechanism
- Extensive test coverage (>95%)

## License

See [LICENSE.md](./LICENSE.md)

## Contributing

Contributions welcome! Please read our contributing guidelines first.

## Links

- Documentation: [Coming soon]
- GitHub: [https://github.com/heavymath/heavymath_contracts](https://github.com/heavymath/heavymath_contracts)
