# @sudobility/heavymath_contracts

Multi-chain prediction market smart contracts and TypeScript SDK for EVM chains. Features a percentage-based prediction mechanism with equilibrium-based settlement.

## Installation

```bash
bun add @sudobility/heavymath_contracts
```

## Usage

```typescript
import { PredictionClient } from '@sudobility/heavymath_contracts';
import { EVMPredictionClient } from '@sudobility/heavymath_contracts/evm';

const client = new EVMPredictionClient({
  predictionMarket: '0x...',
  stakeToken: '0x...',  // USDC address (optional, resolved on-chain)
});

// Place a prediction (auto-approves ERC20)
await client.placePrediction(walletContext, marketId, 60, 1_000_000n);

// Create a market (requires Dealer NFT)
await client.createMarket(walletContext, {
  tokenId: 1n, category: 1n, subCategory: 2n,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 86400),
  description: 'Team A wins',
});

// Read market state
const market = await client.getMarket(publicClient, marketId);
```

## Smart Contracts

Three UUPS-upgradeable Solidity 0.8.24 contracts:

- **PredictionMarket** -- core market lifecycle (create, predict, resolve, claim)
- **DealerNFT** -- ERC721 licensing with category/subcategory permissions
- **OracleResolver** -- oracle registration and data feeds

### How It Works

1. Dealers create markets with a deadline
2. Users place predictions at a percentage (0-100) with USDC
3. At deadline, equilibrium is calculated across the percentage spectrum
4. Winners (on the correct side of equilibrium) share the losers' stakes proportionally
5. Fees: dealer fee (0.1-2%) + system fee (10% of dealer fee)

## Development

```bash
bun run compile:evm    # Compile Solidity
bun run test:evm       # Run Hardhat tests
bun run build          # Build all (evm + unified + react-native TS)
bun run lint           # ESLint check
bun run typecheck      # TypeScript check
bun run deploy:evm:sepolia  # Deploy to Sepolia
```

## SDK Entry Points

| Import | Description |
|--------|-------------|
| `@sudobility/heavymath_contracts` | Unified PredictionClient |
| `@sudobility/heavymath_contracts/evm` | EVMPredictionClient (viem) |

## Related Packages

- `@sudobility/heavymath_types` -- shared type definitions
- `@sudobility/heavymath_indexer_client` -- indexer API client
- `@sudobility/heavymath_lib` -- business logic hooks
- `heavymath_app` -- frontend web application

## License

BUSL-1.1
