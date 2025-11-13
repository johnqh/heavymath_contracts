# HeavyMath Prediction Market Contracts

Multi-chain prediction market system with percentage-based odds and equilibrium calculation. Supports both EVM chains and Solana.

## Features

- **Novel Prediction Mechanism**: Predictors specify percentage-based odds instead of binary yes/no
- **Equilibrium Algorithm**: Automatically determines market sides based on bet distribution
- **Multi-Chain Support**: Unified TypeScript client for EVM and Solana
- **UUPS Upgradeable**: Contracts can be upgraded post-deployment for bug fixes and improvements
- **Oracle Integration**: Chainlink (EVM) and Switchboard (Solana) for result resolution
- **Dealer NFT System**: NFT-based permissions for creating prediction markets

## Architecture

### Smart Contracts

**EVM (Ethereum, Polygon, Arbitrum, Base)**:
- `DealerNFT`: UUPS upgradeable NFT granting market creation permissions
- `PredictionMarket`: UUPS upgradeable contract managing all prediction markets

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

const client = new PredictionClient();

// Create a prediction market
await client.createMarket(
  { walletClient },
  chainInfo,
  {
    nftId: "1",
    category: 1,
    subCategory: 2,
    scopeId: "World Cup 2026",
    eventId: "Game 1: USA vs MEX",
    outcome: "USA wins",
    predictionDeadline: Date.now() + 86400000, // 1 day
    eventTime: Date.now() + 172800000, // 2 days
    oracleDeadline: Date.now() + 259200000, // 3 days
    dealerFeePercent: 50 // 0.5%
  }
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
