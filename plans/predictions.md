# Onchain Prediction Market Implementation Plan

## Executive Summary

Implementation of a novel prediction market system where predictors specify percentage-based odds and an equilibrium algorithm determines market sides. Supports both EVM and Solana chains.

**Development Priority**: EVM implementation first, then Solana

**Infrastructure Pattern**: Following ~/0xmail/mail_box_contracts architecture with Hardhat (EVM), Cargo (Solana), and unified TypeScript clients

**Key Difference**: This project uses **UUPS Upgradeable Proxy Pattern** for EVM contracts, enabling post-deployment bug fixes and improvements while maintaining the same address.

**Development Approach**: Test-driven development - write tests alongside or before each feature implementation, not at the end.

## Project Structure

Following the proven pattern from mail_box_contracts with UUPS upgrade infrastructure:

```
heavymath_contracts/
├── contracts/              # Solidity contracts (EVM)
│   ├── DealerNFT.sol              # UUPS Upgradeable NFT
│   ├── PredictionMarket.sol       # UUPS Upgradeable Market
│   ├── MockUSDC.sol (for testing)
│   └── interfaces/
│       ├── IDealerNFT.sol
│       └── IPredictionMarket.sol
│
├── programs/              # Anchor programs (Solana)
│   ├── dealer-nft/
│   │   ├── Cargo.toml
│   │   └── src/lib.rs
│   └── prediction-market/
│       ├── Cargo.toml
│       └── src/lib.rs
│
├── src/                   # TypeScript clients
│   ├── evm/
│   │   ├── evm-prediction-client.ts
│   │   ├── types.ts
│   │   └── index.ts
│   ├── solana/
│   │   ├── solana-prediction-client.ts
│   │   ├── types.ts
│   │   └── index.ts
│   ├── unified/
│   │   ├── prediction-client.ts  (Unified client)
│   │   ├── wallet-detector.ts
│   │   ├── types.ts
│   │   └── index.ts
│   ├── react/ (optional)
│   │   ├── hooks/
│   │   └── index.ts
│   └── utils/
│       ├── validation.ts
│       └── chain-config.ts
│
├── scripts/               # Deployment & upgrade scripts
│   ├── evm/
│   │   ├── deploy.ts         # Initial UUPS proxy deployment
│   │   ├── verify.ts         # Etherscan verification
│   │   ├── upgrade.ts        # UUPS upgrade script
│   │   └── prepare-upgrade.ts # Validate upgrade safety
│   └── solana/
│       └── deploy.ts
│
├── test/                  # Tests
│   ├── evm/
│   │   ├── DealerNFT.test.ts
│   │   ├── PredictionMarket.test.ts
│   │   ├── Equilibrium.test.ts
│   │   ├── Payout.test.ts
│   │   ├── Oracle.test.ts
│   │   ├── Security.test.ts
│   │   ├── Upgrade.test.ts        # UUPS upgrade tests
│   │   └── Integration.test.ts
│   ├── solana/
│   │   └── prediction-market.test.ts
│   └── unified/
│       └── unified-client.test.ts
│
├── typechain-types/       # Generated TypeChain types
├── artifacts/             # Hardhat compilation artifacts
├── target/                # Anchor/Cargo build output
├── deployments/           # Deployment records
├── dist/                  # Built TypeScript
│
├── hardhat.config.cts     # Hardhat configuration
├── Cargo.toml            # Rust workspace
├── Anchor.toml           # Anchor configuration
├── tsconfig.json         # Base TypeScript config
├── tsconfig.evm.json     # EVM client config
├── tsconfig.solana.json  # Solana client config
├── tsconfig.unified.json # Unified client config
├── package.json
├── DEPLOYED.json         # Deployment tracking
└── README.md
```

## System Architecture

### Core Components

1. **NFT Contract** (Dealer Licenses)
   - Grants permission to create prediction markets
   - Stores dealer capabilities via category/subCategory mapping
   - Uses 0xFF as wildcard for "all categories" or "all subcategories"

2. **Prediction Market Contract**
   - Manages all prediction markets
   - Handles deposits, predictions, and payouts
   - Integrates with oracle for result resolution
   - Upgradeable via UUPS proxy pattern

3. **Oracle Integration**
   - Chainlink (EVM) / Switchboard (Solana)
   - Returns simple boolean (true/false) result
   - Auto-refund on oracle timeout (no manual intervention)

4. **Fee Management**
   - System fee: Adjustable by System owner (default 10% of dealer fee)
   - Dealer fee: Set by dealer within bounds (0.1% - 2%, i.e., 10-200 basis points)

5. **TypeScript Clients**
   - **EVM Client**: Uses viem for EVM interactions
   - **Solana Client**: Uses @solana/web3.js for Solana interactions
   - **Unified Client**: Single interface that works across both chains

### User Roles

- **System Owner**: Smart contract owner, sets fee bounds, updates NFT permissions, superuser rights (pause, emergency withdraw, cancel markets)
- **Dealer**: NFT holder, creates and manages prediction markets, sets own fee within bounds
- **Predictor**: Places single percentage-based prediction per market with USDC

---

## Design Decisions Summary

### Core Rules

1. **One Prediction Per Predictor**: Each predictor can only have ONE active prediction per market
   - Can add USDC amount to existing prediction (keeps same percentage)
   - Can update prediction (change percentage and/or amount)
   - Can remove prediction (full refund before deadline)
   - Cannot have multiple predictions at different percentages

2. **No Minimums**: No minimum bet amount, no minimum total market size

3. **No Maximums**: No limit on number of predictors per market

4. **Time Validation**:
   - prediction_deadline must be ≤ event_time
   - oracle_deadline must be > event_time
   - Minimum 24 hour market duration (creation to prediction_deadline)
   - Predictions can only be modified before prediction_deadline

5. **Equilibrium Calculation**:
   - Primary: Fully on-chain using mapping-based O(101) iteration (percentage 0-100)
   - Fallback: Off-chain calculated + on-chain verified (anyone can submit, verified on-chain)

6. **NFT Transfer**: Markets and all future fees transfer to new NFT owner

7. **Edge Cases**: If no two-sided market exists after equilibrium calculation, refund all predictors

8. **Oracle Failure**: Auto-refund all if oracle doesn't respond by oracle_deadline

9. **Dealer Cancellation**: Dealer can cancel market only if no predictions have been placed yet

10. **Payout Model**: Allow winners to receive less than stake if fees are very high (consistent fee model)

### Technical Decisions

- **Upgradability**: UUPS proxy pattern for both NFT and Prediction Market contracts
- **Admin Powers**: System owner can pause contracts + emergency withdraw funds
- **USDC**: Native USDC only (Solana), configurable per chain (EVM)
- **Claims**: Individual claims, no batching
- **Excluded Predictions**: Auto-refund during market lock if at exact equilibrium point
- **Target Chains**: Ethereum, Polygon, Arbitrum, Base (keep flexible)
- **Build Tools**: Hardhat (EVM), Cargo/Anchor (Solana)
- **Type Generation**: TypeChain for EVM, Anchor IDL for Solana
- **Testing**: Hardhat tests (EVM), Anchor tests (Solana), Mocha (unified)

---

## Smart Contract Specifications

### 1. NFT Contract (EVM)

**Base**: OpenZeppelin ERC721Upgradeable, ERC721EnumerableUpgradeable, OwnableUpgradeable, UUPSUpgradeable

#### Data Structures

```solidity
// 0xFF is special value meaning "all categories" or "all subcategories"
uint256 constant ALL_CATEGORIES = 0xFF;
uint256 constant ALL_SUBCATEGORIES = 0xFF;

// Nested mapping: tokenId => category => list of allowed subCategories
mapping(uint256 => mapping(uint256 => uint256[])) public dealerPermissions;

// Helper mapping to check if specific combo is allowed
mapping(uint256 => mapping(uint256 => mapping(uint256 => bool))) public isPermissionAllowed;

// Track if a tokenId has permissions set
mapping(uint256 => bool) public hasPermissions;
```

#### Key Functions

```solidity
function mint(address dealer, uint256 tokenId) external onlyOwner

function setPermissions(
    uint256 tokenId,
    uint256 category,
    uint256[] calldata subCategories
) external onlyOwner
// Can be called multiple times to add permissions for different categories
// Use category=0xFF, subCategories=[0xFF] for "all categories and subcategories"
// Use category=0x01, subCategories=[0xFF] for "category 1, all subcategories"

function validatePermission(
    uint256 tokenId,
    uint256 category,
    uint256 subCategory
) public view returns (bool)
// Returns true if the tokenId holder can create markets in this category/subCategory
// Checks for ALL_CATEGORIES and ALL_SUBCATEGORIES wildcards

function _afterTokenTransfer(
    address from,
    address to,
    uint256 tokenId,
    uint256 batchSize
) internal virtual override
// Hook to notify prediction market contract of NFT transfers
// Updates dealer address in all active markets for this NFT
```

#### Events

```solidity
event LicenseIssued(uint256 indexed tokenId, address indexed dealer);
event PermissionsSet(uint256 indexed tokenId, uint256 category, uint256[] subCategories);
event LicenseTransferred(uint256 indexed tokenId, address indexed from, address indexed to);
```

---

### 2. Prediction Market Contract (EVM)

**Base**: OpenZeppelin OwnableUpgradeable, ReentrancyGuardUpgradeable, PausableUpgradeable, UUPSUpgradeable

#### Data Structures

```solidity
enum MarketState {
    Active,           // Accepting predictions
    Locked,           // Past prediction_deadline, awaiting oracle
    Resolved,         // Oracle resolved, payouts available
    Cancelled,        // Cancelled by system/dealer
    Abandoned,        // Oracle failed to respond by oracle_deadline
    Refunded          // No two-sided market, all refunded
}

struct Market {
    uint256 nftTokenId;
    address dealer;
    uint256 dealerFeePercent; // Basis points, set by dealer within bounds

    // Market metadata
    uint256 category;
    uint256 subCategory;
    string scopeId;        // e.g., "World Cup"
    string eventId;        // e.g., "Game 1, A vs B"
    string outcome;        // e.g., "A wins"

    // Timestamps
    uint256 createdAt;
    uint256 predictionDeadline;
    uint256 eventTime;
    uint256 oracleDeadline;

    // State
    MarketState state;
    bool result;           // true = outcome occurred, false = did not occur
    uint256 equilibriumPoint; // Basis points (0-10000 = 0.00%-100.00%)

    // Financials
    uint256 totalStaked;
    uint256 totalPositiveSide;  // Amount on positive outcome side (above equilibrium)
    uint256 totalNegativeSide;  // Amount on negative outcome side (below equilibrium)
    uint256 totalRefunded;      // Amount at exact equilibrium (excluded)

    // Oracle
    bytes32 oracleRequestId;
}

struct Prediction {
    uint256 percentage;    // 0-100 (whole number)
    uint256 amount;        // USDC amount (6 decimals)
    bool side;             // true = positive, false = negative (determined at lock)
    bool excluded;         // true if at exact equilibrium point
    bool claimed;          // Has the predictor claimed their payout/refund?
}

// Market storage
mapping(uint256 => Market) public markets;
uint256 public marketCounter;

// Prediction storage - ONE prediction per predictor per market
mapping(uint256 => mapping(address => Prediction)) public predictions;

// Mapping for efficient equilibrium calculation: marketId => percentage (0-100) => total amount
mapping(uint256 => mapping(uint256 => uint256)) public amountAtPercentage;

// Array of predictor addresses for each market (for iteration)
mapping(uint256 => address[]) public predictors;
mapping(uint256 => mapping(address => bool)) public isPredictorInMarket;
```

#### Configuration

```solidity
IERC20 public usdcToken;
IERC721 public dealerNFT;

uint256 public minDealerFeePercent = 10;   // 0.1% (basis points)
uint256 public maxDealerFeePercent = 200;  // 2.0% (basis points)
uint256 public systemFeePercent = 1000;    // 10% of dealer fee (basis points)

uint256 constant BASIS_POINTS = 10000;
uint256 constant MIN_MARKET_DURATION = 24 hours;
```

*(Full contract specification continues as in previous version...)*

---

## TypeScript Client Architecture

### Package Configuration

Following mail_box_contracts pattern:

```json
{
  "name": "@heavymath/prediction-contracts",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/unified/src/unified/index.js",
  "types": "dist/unified/src/unified/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/unified/src/unified/index.d.ts",
      "default": "./dist/unified/src/unified/index.js"
    },
    "./evm": {
      "types": "./dist/unified/src/evm/index.d.ts",
      "default": "./dist/unified/src/evm/index.js"
    },
    "./solana": {
      "types": "./dist/unified/src/solana/index.d.ts",
      "default": "./dist/unified/src/solana/index.js"
    },
    "./react": {
      "types": "./dist/unified/src/react/index.d.ts",
      "default": "./dist/unified/src/react/index.js"
    }
  },
  "scripts": {
    "build": "npm run build:evm && npm run build:solana && npm run build:unified",
    "build:evm": "npx hardhat compile && tsc --project tsconfig.evm.json",
    "build:solana": "cargo build --manifest-path programs/prediction-market/Cargo.toml && tsc --project tsconfig.solana.json",
    "build:unified": "tsc --project tsconfig.unified.json",
    "test": "npm run test:evm && npm run test:solana && npm run test:unified",
    "test:evm": "npx hardhat test",
    "test:solana": "cd programs/prediction-market && cargo test",
    "test:unified": "mocha dist/test/unified/**/*.test.js",
    "compile:evm": "npx hardhat compile",
    "compile:solana": "anchor build",
    "deploy:evm:sepolia": "npx hardhat run scripts/evm/deploy.ts --network sepolia",
    "deploy:evm:mainnet": "npx hardhat run scripts/evm/deploy.ts --network mainnet",
    "deploy:solana:devnet": "anchor deploy --provider.cluster devnet",
    "deploy:solana:mainnet": "anchor deploy --provider.cluster mainnet-beta",
    "upgrade:evm:sepolia": "npx hardhat run scripts/evm/upgrade.ts --network sepolia",
    "upgrade:evm:mainnet": "npx hardhat run scripts/evm/upgrade.ts --network mainnet",
    "verify:evm:sepolia": "npx hardhat run scripts/evm/verify.ts --network sepolia",
    "verify:evm:mainnet": "npx hardhat run scripts/evm/verify.ts --network mainnet",
    "prepare-upgrade:evm": "npx hardhat run scripts/evm/prepare-upgrade.ts"
  }
}
```

### 1. EVM Client (`src/evm/evm-prediction-client.ts`)

**Stateless client using viem**:

```typescript
import { Address, Hash, PublicClient, WalletClient } from 'viem';
import { ChainInfo } from '@sudobility/configs';
import {
  DealerNFT__factory,
  PredictionMarket__factory
} from '../../typechain-types';

export interface EVMWallet {
  walletClient: WalletClient;
  publicClient?: PublicClient;
}

export interface GasOptions {
  gasMultiplier?: number;
  maxGasLimit?: bigint;
  gasLimit?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

export interface TransactionResult {
  hash: Hash;
  estimatedGas?: bigint;
  gasLimit?: bigint;
  gasUsed?: bigint;
}

export class EVMPredictionClient {
  static readonly nftAbi = DealerNFT__factory.abi;
  static readonly predictionAbi = PredictionMarket__factory.abi;

  /**
   * Create a new prediction market
   */
  async createMarket(
    wallet: EVMWallet,
    chainInfo: ChainInfo,
    params: {
      nftTokenId: bigint;
      category: bigint;
      subCategory: bigint;
      scopeId: string;
      eventId: string;
      outcome: string;
      predictionDeadline: bigint;
      eventTime: bigint;
      oracleDeadline: bigint;
      dealerFeePercent: bigint;
    },
    gasOptions?: GasOptions
  ): Promise<TransactionResult> {
    // Implementation
  }

  /**
   * Place a prediction
   */
  async placePrediction(
    wallet: EVMWallet,
    chainInfo: ChainInfo,
    marketId: bigint,
    percentage: number,
    amount: bigint,
    gasOptions?: GasOptions
  ): Promise<TransactionResult> {
    // Implementation
  }

  /**
   * Update prediction
   */
  async updatePrediction(
    wallet: EVMWallet,
    chainInfo: ChainInfo,
    marketId: bigint,
    newPercentage: number,
    newAmount: bigint,
    gasOptions?: GasOptions
  ): Promise<TransactionResult> {
    // Implementation
  }

  /**
   * Lock market and calculate equilibrium
   */
  async lockMarket(
    wallet: EVMWallet,
    chainInfo: ChainInfo,
    marketId: bigint,
    gasOptions?: GasOptions
  ): Promise<TransactionResult> {
    // Implementation
  }

  /**
   * Claim payout
   */
  async claimPayout(
    wallet: EVMWallet,
    chainInfo: ChainInfo,
    marketId: bigint,
    gasOptions?: GasOptions
  ): Promise<TransactionResult> {
    // Implementation
  }

  /**
   * Get market details
   */
  async getMarket(
    chainInfo: ChainInfo,
    marketId: bigint,
    publicClient?: PublicClient
  ): Promise<Market> {
    // Implementation
  }

  /**
   * Get prediction for an address
   */
  async getPrediction(
    chainInfo: ChainInfo,
    marketId: bigint,
    predictor: Address,
    publicClient?: PublicClient
  ): Promise<Prediction> {
    // Implementation
  }
}
```

### 2. Solana Client (`src/solana/solana-prediction-client.ts`)

**Stateless client using @solana/web3.js**:

```typescript
import {
  Connection,
  PublicKey,
  Transaction,
  ConfirmOptions,
} from '@solana/web3.js';
import { ChainInfo } from '@sudobility/configs';

export interface Wallet {
  publicKey: PublicKey;
  signTransaction<T extends Transaction>(transaction: T): Promise<T>;
  signAllTransactions<T extends Transaction>(transactions: T[]): Promise<T[]>;
}

export interface SolanaWallet {
  wallet: Wallet;
  connection?: Connection;
}

export interface ComputeUnitOptions {
  computeUnitLimit?: number;
  computeUnitPrice?: number;
  autoOptimize?: boolean;
  computeUnitMultiplier?: number;
  skipComputeUnits?: boolean;
}

export interface TransactionResult {
  signature: string;
  transactionHash: string;
  simulatedUnits?: number;
  computeUnitLimit?: number;
  computeUnitPrice?: number;
}

export class SolanaPredictionClient {
  /**
   * Create a new prediction market
   */
  async createMarket(
    wallet: SolanaWallet,
    chainInfo: ChainInfo,
    params: {
      nftMint: PublicKey;
      category: number;
      subCategory: number;
      scopeId: string;
      eventId: string;
      outcome: string;
      predictionDeadline: number;
      eventTime: number;
      oracleDeadline: number;
      dealerFeePercent: number;
    },
    computeOptions?: ComputeUnitOptions
  ): Promise<TransactionResult> {
    // Implementation
  }

  /**
   * Place a prediction
   */
  async placePrediction(
    wallet: SolanaWallet,
    chainInfo: ChainInfo,
    marketPubkey: PublicKey,
    percentage: number,
    amount: bigint,
    computeOptions?: ComputeUnitOptions
  ): Promise<TransactionResult> {
    // Implementation
  }

  // ... other methods similar to EVM client
}
```

### 3. Unified Client (`src/unified/prediction-client.ts`)

**Chain-agnostic interface**:

```typescript
import { ChainType } from '@sudobility/types';
import { ChainInfo } from '@sudobility/configs';
import type { EVMWallet } from '../evm/evm-prediction-client';
import type { SolanaWallet } from '../solana/solana-prediction-client';

export type Wallet = EVMWallet | SolanaWallet;

export interface MarketResult {
  marketId: string;
  dealer: string;
  category: string;
  subCategory: string;
  scopeId: string;
  eventId: string;
  outcome: string;
  state: MarketState;
  totalStaked: string;
  equilibriumPoint?: string;
}

export interface PredictionResult {
  percentage: number;
  amount: string;
  side?: boolean;
  excluded: boolean;
  claimed: boolean;
}

export interface UnifiedTransaction {
  transactionHash: string;
  blockNumber?: number;
  confirmed: boolean;
}

/**
 * PredictionClient - Stateless multi-chain prediction market client
 *
 * This client provides a unified interface for both EVM and Solana chains.
 * All wallet connections and chain information are passed as parameters.
 *
 * @example EVM Usage
 * ```typescript
 * import { createWalletClient, http } from 'viem';
 * import { RpcHelpers } from '@sudobility/configs';
 * import { Chain } from '@sudobility/types';
 *
 * const chainInfo = RpcHelpers.getChainInfo(Chain.ETH_SEPOLIA);
 * const walletClient = createWalletClient({
 *   chain: sepolia,
 *   transport: http()
 * });
 *
 * const client = new PredictionClient();
 * await client.createMarket(
 *   { walletClient },
 *   chainInfo,
 *   { ... market params ... }
 * );
 * ```
 *
 * @example Solana Usage
 * ```typescript
 * import { useWallet } from '@solana/wallet-adapter-react';
 * import { RpcHelpers } from '@sudobility/configs';
 * import { Chain } from '@sudobility/types';
 *
 * const chainInfo = RpcHelpers.getChainInfo(Chain.SOLANA_DEVNET);
 * const wallet = useWallet();
 *
 * const client = new PredictionClient();
 * await client.createMarket(
 *   { wallet },
 *   chainInfo,
 *   { ... market params ... }
 * );
 * ```
 */
export class PredictionClient {
  // Cache for dynamic imports
  private static evmClient: any = null;
  private static solanaClient: any = null;

  constructor() {
    // Stateless - no initialization needed
  }

  // Performance optimization: cache client imports
  private async getEVMClient() {
    if (!PredictionClient.evmClient) {
      const { EVMPredictionClient } = await import('../evm/evm-prediction-client.js');
      PredictionClient.evmClient = new EVMPredictionClient();
    }
    return PredictionClient.evmClient;
  }

  private async getSolanaClient() {
    if (!PredictionClient.solanaClient) {
      const { SolanaPredictionClient } = await import('../solana/solana-prediction-client.js');
      PredictionClient.solanaClient = new SolanaPredictionClient();
    }
    return PredictionClient.solanaClient;
  }

  /**
   * Create a new prediction market
   */
  async createMarket(
    wallet: Wallet,
    chainInfo: ChainInfo,
    params: {
      nftId: string;
      category: number;
      subCategory: number;
      scopeId: string;
      eventId: string;
      outcome: string;
      predictionDeadline: number | bigint;
      eventTime: number | bigint;
      oracleDeadline: number | bigint;
      dealerFeePercent: number;
    },
    options?: {
      gasOptions?: any;
      computeOptions?: any;
    }
  ): Promise<MarketResult> {
    // Route to appropriate implementation based on chain type
    if (chainInfo.chainType === ChainType.EVM) {
      const evmClient = await this.getEVMClient();
      const result = await evmClient.createMarket(
        wallet as EVMWallet,
        chainInfo,
        {
          nftTokenId: BigInt(params.nftId),
          category: BigInt(params.category),
          subCategory: BigInt(params.subCategory),
          scopeId: params.scopeId,
          eventId: params.eventId,
          outcome: params.outcome,
          predictionDeadline: BigInt(params.predictionDeadline),
          eventTime: BigInt(params.eventTime),
          oracleDeadline: BigInt(params.oracleDeadline),
          dealerFeePercent: BigInt(params.dealerFeePercent),
        },
        options?.gasOptions
      );
      // Convert to unified format
      return this.convertToMarketResult(result, chainInfo);
    } else {
      const solanaClient = await this.getSolanaClient();
      const result = await solanaClient.createMarket(
        wallet as SolanaWallet,
        chainInfo,
        params,
        options?.computeOptions
      );
      return this.convertToMarketResult(result, chainInfo);
    }
  }

  /**
   * Place a prediction
   */
  async placePrediction(
    wallet: Wallet,
    chainInfo: ChainInfo,
    marketId: string,
    percentage: number,
    amount: string,
    options?: {
      gasOptions?: any;
      computeOptions?: any;
    }
  ): Promise<UnifiedTransaction> {
    // Similar routing logic
  }

  /**
   * Get market details
   */
  async getMarket(
    chainInfo: ChainInfo,
    marketId: string
  ): Promise<MarketResult> {
    // Similar routing logic
  }

  // ... other methods
}
```

---

## Implementation Phases

### Phase 1: Project Setup & Infrastructure (Week 1)

- [ ] Initialize project structure following mail_box_contracts pattern
- [ ] Set up package.json with all dependencies
- [ ] Configure Hardhat for EVM
- [ ] Configure Cargo/Anchor for Solana
- [ ] Set up TypeScript configurations (evm, solana, unified)
- [ ] Set up testing infrastructure
- [ ] Create deployment scripts structure
- [ ] Set up Git repository with proper .gitignore

**Deliverables**:
- Project compiles successfully
- Basic test structure in place
- Scripts for build/test/deploy configured

### Phase 2: EVM Contracts - Core (Week 1-2)

**DealerNFT Implementation**:
- [ ] Set up test file: `test/evm/DealerNFT.test.ts`
- [ ] Write test: Should initialize with correct parameters
- [ ] Implement DealerNFT with UUPS upgradeability
  - [ ] Use OpenZeppelin's UUPSUpgradeable base
  - [ ] Implement `initialize()` function (not constructor)
- [ ] Write test: Should prevent re-initialization
- [ ] Add initialization guard
- [ ] Write test: Should mint NFT to dealer
- [ ] Implement `mint()` function
- [ ] Write test: Should set permissions for category/subCategory
- [ ] Implement permission mapping structure (with 0xFF wildcard)
- [ ] Write test: Should validate permissions correctly (all wildcard combinations)
- [ ] Implement `validatePermission()` function
- [ ] Write test: Should only allow owner to upgrade
- [ ] Implement `_authorizeUpgrade()` with onlyOwner
- [ ] Write test: Should preserve state after upgrade
- [ ] Add storage gap for future versions
- [ ] Write test: Should update dealer in prediction market on NFT transfer
- [ ] Implement NFT transfer hook (`_afterTokenTransfer`)

**PredictionMarket Implementation**:
- [ ] Set up test file: `test/evm/PredictionMarket.test.ts`
- [ ] Write test: Should initialize with USDC and NFT addresses
- [ ] Implement PredictionMarket skeleton with UUPS
  - [ ] Use OpenZeppelin's UUPSUpgradeable base
  - [ ] Implement `initialize()` function
- [ ] Write test: Should prevent re-initialization
- [ ] Add initialization guard
- [ ] Write test: Should only allow NFT owner to create market
- [ ] Write test: Should validate market timestamps (deadline ≤ event_time, etc.)
- [ ] Write test: Should validate 24hr minimum market duration
- [ ] Write test: Should validate dealer fee within bounds
- [ ] Implement market creation with all validations
- [ ] Write test: Should place prediction with valid parameters
- [ ] Write test: Should reject prediction with invalid percentage (>100)
- [ ] Write test: Should reject prediction after deadline
- [ ] Implement prediction placement
- [ ] Write test: Should allow predictor to add to existing prediction
- [ ] Implement `addToPrediction()`
- [ ] Write test: Should allow predictor to update prediction (change %, amount)
- [ ] Implement `updatePrediction()`
- [ ] Write test: Should allow predictor to remove prediction and get refund
- [ ] Implement `removePrediction()`
- [ ] Write test: Should only allow one prediction per predictor
- [ ] Enforce one prediction per predictor rule

**Upgrade Tests**:
- [ ] Set up test file: `test/evm/Upgrade.test.ts`
- [ ] Write test: Should upgrade NFT to new implementation
- [ ] Write test: Should upgrade PredictionMarket to new implementation
- [ ] Write test: Should preserve NFT state after upgrade
- [ ] Write test: Should preserve market data after upgrade
- [ ] Write test: Should prevent non-owner from upgrading
- [ ] Implement upgrade authorization checks

**TypeChain Generation**:
- [ ] Generate TypeChain types
- [ ] Verify types work with tests

**Deliverables**:
- DealerNFT.sol fully implemented with 20+ tests
- PredictionMarket.sol core functionality with 25+ tests
- Upgrade.test.ts with 6+ tests
- UUPS upgrade pattern correctly implemented
- TypeChain types generated and working
- **>85% test coverage** for implemented features
- All tests passing

### Phase 3: EVM Contracts - Equilibrium Algorithm (Week 2-3)

**Data Structure Implementation**:
- [ ] Set up test file: `test/evm/Equilibrium.test.ts`
- [ ] Write test: Should track amounts at each percentage correctly
- [ ] Implement mapping-based data structure (`amountAtPercentage`)
- [ ] Write test: Should update amountAtPercentage when prediction placed
- [ ] Write test: Should update amountAtPercentage when prediction updated
- [ ] Write test: Should update amountAtPercentage when prediction removed

**Equilibrium Calculation**:
- [ ] Write test: Should calculate equilibrium at 50% for balanced bets
- [ ] Implement basic equilibrium calculation (O(101) iteration)
- [ ] Write test: Should calculate equilibrium at 25% for 1:3 ratio
- [ ] Write test: Should calculate equilibrium at 75% for 3:1 ratio
- [ ] Write test: Should calculate fractional equilibrium (e.g., 22.34%)
- [ ] Refine equilibrium calculation to handle fractions
- [ ] Write test: Should verify off-chain calculated equilibrium
- [ ] Implement off-chain equilibrium verification (`verifyEquilibrium`)
- [ ] Write test: Should reject invalid off-chain equilibrium

**Side Assignment**:
- [ ] Write test: Should assign predictions below equilibrium to negative side
- [ ] Write test: Should assign predictions above equilibrium to positive side
- [ ] Implement side assignment logic (`assignSides`)
- [ ] Write test: Should mark predictions at exact equilibrium as excluded
- [ ] Implement exclusion logic for exact matches
- [ ] Write test: Should auto-refund excluded predictions during lock
- [ ] Implement auto-refund for excluded predictions

**Edge Cases**:
- [ ] Write test: All predictors at same percentage → Refund all
- [ ] Write test: All predictors at 50% → Refund all
- [ ] Write test: Only predictions below 50% → Refund all
- [ ] Write test: Only predictions above 50% → Refund all
- [ ] Write test: Single predictor → Refund
- [ ] Write test: Equilibrium results in all on one side → Refund all
- [ ] Implement edge case handling in `lockMarket()`
- [ ] Write test: Two-sided market detection works correctly
- [ ] Implement `isTwoSidedMarket()` check

**Gas Optimization**:
- [ ] Benchmark gas for 10 predictors
- [ ] Benchmark gas for 50 predictors
- [ ] Benchmark gas for 100 predictors
- [ ] Benchmark gas for 500 predictors
- [ ] Document gas costs in comments
- [ ] Optimize if needed (target: <500k gas for 100 predictors)

**Deliverables**:
- Equilibrium algorithm fully working
- `Equilibrium.test.ts` with 25+ tests
- All edge cases handled and tested
- Gas benchmarks documented
- **>95% test coverage** for equilibrium logic
- All tests passing

### Phase 4: EVM Contracts - Oracle & Resolution (Week 3-4)

**Mock Oracle Setup**:
- [ ] Set up test file: `test/evm/Oracle.test.ts`
- [ ] Create mock oracle contract for testing
- [ ] Write test: Mock oracle should callback with result

**Oracle Integration**:
- [ ] Write test: Should request oracle after market locks
- [ ] Set up Chainlink Functions integration
- [ ] Implement oracle request in `lockMarket()`
- [ ] Write test: Should store oracle request ID
- [ ] Write test: Should resolve market when oracle responds true
- [ ] Write test: Should resolve market when oracle responds false
- [ ] Implement fulfill callback for resolution (`resolveMarket`)
- [ ] Write test: Should only allow oracle to call resolve
- [ ] Add oracle authorization check
- [ ] Write test: Should reject resolve if oracle deadline passed
- [ ] Add oracle deadline validation

**Oracle Timeout**:
- [ ] Write test: Should allow abandonment after oracle deadline
- [ ] Implement `abandonMarket()` function
- [ ] Write test: Should refund all predictors when abandoned
- [ ] Implement refund logic for abandoned markets
- [ ] Write test: Should not allow abandon before oracle deadline
- [ ] Write test: Should not allow abandon if already resolved
- [ ] Add state checks for abandon

**Market State Management**:
- [ ] Write test: Market state transitions correctly (Active → Locked → Resolved)
- [ ] Write test: Market state transitions to Abandoned on timeout
- [ ] Write test: Market state transitions to Refunded on no two-sided market
- [ ] Write test: Cannot transition from terminal states
- [ ] Implement state machine validation

**Testnet Integration**:
- [ ] Deploy to Sepolia testnet
- [ ] Set up Chainlink Functions subscription on Sepolia
- [ ] Create test market on Sepolia
- [ ] Lock market and trigger oracle
- [ ] Verify oracle responds
- [ ] Verify market resolves correctly
- [ ] Document testnet addresses

**Deliverables**:
- Oracle integration complete
- `Oracle.test.ts` with 15+ tests
- Mock oracle for local testing
- Successful Sepolia testnet oracle test
- **>90% test coverage** for oracle logic
- All tests passing

### Phase 5: EVM Contracts - Payout & Fees (Week 4-5)

**Payout Calculation**:
- [ ] Set up test file: `test/evm/Payout.test.ts`
- [ ] Write test: Winner with 100 USDC stake, 1:1 odds, should get 200 USDC minus fees
- [ ] Write test: Winner with 100 USDC stake, 2:1 odds, should get 150 USDC minus fees
- [ ] Implement basic payout calculation (`calculatePayout`)
- [ ] Write test: Loser should get 0 USDC
- [ ] Write test: Excluded predictor should get full refund
- [ ] Implement excluded predictor refund logic

**Fee Calculation**:
- [ ] Write test: Dealer fee should be X% of winner's profit
- [ ] Write test: System fee should be Y% of dealer fee
- [ ] Implement fee calculation in `calculatePayout`
- [ ] Write test: Winner can receive less than stake if fees very high
- [ ] Write test: Fee calculation with multiple winners (proportional)
- [ ] Implement proportional fee distribution

**Claim Payout**:
- [ ] Write test: Winner should claim correct payout amount
- [ ] Implement `claimPayout()` function
- [ ] Write test: Should mark prediction as claimed
- [ ] Write test: Should prevent double claim
- [ ] Add claimed flag check
- [ ] Write test: Should transfer USDC to predictor
- [ ] Implement USDC transfer
- [ ] Write test: Cancelled market - should refund full stake
- [ ] Write test: Abandoned market - should refund full stake
- [ ] Write test: Refunded market - should refund full stake
- [ ] Implement refund logic for all terminal states

**Fee Withdrawal**:
- [ ] Write test: Dealer should withdraw accumulated fees
- [ ] Implement dealer fee tracking and withdrawal
- [ ] Write test: System should withdraw accumulated fees
- [ ] Implement system fee tracking and withdrawal
- [ ] Write test: Only dealer can withdraw their fees
- [ ] Write test: Only system owner can withdraw system fees
- [ ] Add access control for withdrawals

**NFT Transfer & Dealer Updates**:
- [ ] Write test: New NFT owner receives dealer fees after transfer
- [ ] Implement dealer update on NFT transfer
- [ ] Write test: Original dealer doesn't receive fees after NFT transfer
- [ ] Write test: Active markets continue normally after NFT transfer

**Edge Cases**:
- [ ] Write test: Very high fees (winner receives less than stake)
- [ ] Write test: Single winner takes all
- [ ] Write test: Many winners split proportionally
- [ ] Write test: Rounding errors in fee distribution
- [ ] Write test: Excluded + winners + losers all in same market

**Deliverables**:
- Payout system fully working
- `Payout.test.ts` with 25+ tests
- Fee distribution correct and tested
- NFT transfer scenarios tested
- **>95% test coverage** for payout logic
- All tests passing

### Phase 6: EVM Contracts - Security & Admin (Week 5-6)

**Pause Functionality**:
- [ ] Set up test file: `test/evm/Security.test.ts`
- [ ] Write test: Owner should pause contract
- [ ] Implement pause/unpause functionality (OpenZeppelin Pausable)
- [ ] Write test: Cannot create market when paused
- [ ] Write test: Cannot place prediction when paused
- [ ] Add whenNotPaused modifiers
- [ ] Write test: Can still lock/resolve/claim when paused
- [ ] Write test: Non-owner cannot pause
- [ ] Add onlyOwner to pause functions

**Emergency Withdraw**:
- [ ] Write test: Owner should emergency withdraw all USDC
- [ ] Implement emergency withdraw function
- [ ] Write test: Non-owner cannot emergency withdraw
- [ ] Write test: Emergency withdraw records amount withdrawn
- [ ] Add access control check

**Fee Configuration**:
- [ ] Write test: Owner should set dealer fee bounds (min/max)
- [ ] Implement `setDealerFeeBounds()` function
- [ ] Write test: New dealer fees must be within bounds
- [ ] Write test: Existing markets keep their original fee
- [ ] Write test: Owner should set system fee percentage
- [ ] Implement `setSystemFee()` function
- [ ] Write test: Non-owner cannot set fees
- [ ] Write test: Fee bounds validation (min ≤ max, max ≤ 100%)

**Market Cancellation**:
- [ ] Write test: Owner should cancel any market anytime
- [ ] Write test: Dealer should cancel market with no predictions
- [ ] Write test: Dealer cannot cancel market with predictions
- [ ] Implement cancellation logic and access control
- [ ] Write test: Cancelled market refunds all predictors

**Input Validation**:
- [ ] Review all functions for input validation
- [ ] Write test: Reject zero amounts
- [ ] Write test: Reject empty strings (scopeId, eventId, outcome)
- [ ] Write test: Reject invalid addresses (zero address)
- [ ] Write test: Reject percentage > 100
- [ ] Add comprehensive validation

**Access Control Tests**:
- [ ] Write test: Non-NFT-owner cannot create market
- [ ] Write test: Non-predictor cannot claim someone else's payout
- [ ] Write test: Non-oracle cannot resolve market
- [ ] Write test: Non-owner cannot upgrade contract
- [ ] Verify all access control modifiers

**Attack Vector Tests**:
- [ ] Write test: Reentrancy attack on claimPayout fails
- [ ] Write test: Integer overflow/underflow prevented
- [ ] Write test: Cannot manipulate equilibrium calculation
- [ ] Write test: Cannot claim payout twice
- [ ] Write test: Cannot grief by creating many markets

**Gas Optimization**:
- [ ] Profile gas usage for all major functions
- [ ] Optimize storage packing
- [ ] Optimize loop iterations
- [ ] Target: createMarket <200k, placePrediction <150k, lockMarket <500k for 100 predictors
- [ ] Document final gas costs

**Deliverables**:
- All admin functions working
- `Security.test.ts` with 30+ tests
- Security hardened against common attacks
- Gas optimized and benchmarked
- **>95% overall test coverage**
- All tests passing

### Phase 7: EVM TypeScript Client (Week 6)

**Client Setup**:
- [ ] Create `src/evm/evm-prediction-client.ts`
- [ ] Create `src/evm/types.ts`
- [ ] Set up test file: `test/unified/evm-client.test.ts`
- [ ] Set up TypeChain imports

**Market Management Methods**:
- [ ] Write test: Should create market with valid params
- [ ] Implement `createMarket()` method with gas estimation
- [ ] Write test: Should cancel market
- [ ] Implement `cancelMarket()` method
- [ ] Write test: Should lock market
- [ ] Implement `lockMarket()` method
- [ ] Write test: Should abandon market after timeout
- [ ] Implement `abandonMarket()` method

**Prediction Methods**:
- [ ] Write test: Should place prediction
- [ ] Implement `placePrediction()` method with USDC approval
- [ ] Write test: Should add to prediction
- [ ] Implement `addToPrediction()` method
- [ ] Write test: Should update prediction
- [ ] Implement `updatePrediction()` method
- [ ] Write test: Should remove prediction
- [ ] Implement `removePrediction()` method
- [ ] Write test: Should claim payout
- [ ] Implement `claimPayout()` method

**Read Methods**:
- [ ] Write test: Should get market details
- [ ] Implement `getMarket()` method
- [ ] Write test: Should get prediction for address
- [ ] Implement `getPrediction()` method
- [ ] Write test: Should get all markets for NFT
- [ ] Implement `getMarketsForNFT()` method
- [ ] Write test: Should get predictor's active markets
- [ ] Implement `getPredictorMarkets()` method
- [ ] Write test: Should calculate estimated payout
- [ ] Implement `calculateEstimatedPayout()` method

**Gas Estimation**:
- [ ] Implement gas estimation for all write methods
- [ ] Add gas multiplier option
- [ ] Add max gas limit safety check
- [ ] Write test: Gas estimation works correctly
- [ ] Write test: Gas multiplier applies correctly

**Error Handling**:
- [ ] Write test: Should throw on insufficient USDC balance
- [ ] Write test: Should throw on insufficient USDC allowance
- [ ] Write test: Should throw on invalid parameters
- [ ] Add comprehensive error handling

**Deliverables**:
- Full-featured EVMPredictionClient
- Client tests with 30+ tests
- Comprehensive JSDoc documentation
- TypeChain integration working
- **>90% test coverage** for client
- All tests passing

### Phase 8: EVM Testing & Deployment (Week 7)

**Integration Testing**:
- [ ] Set up test file: `test/evm/Integration.test.ts`
- [ ] Write test: Full happy path (create → predict → lock → resolve → claim)
- [ ] Write test: Multiple predictors, different percentages
- [ ] Write test: NFT transfer mid-market
- [ ] Write test: Market cancellation refunds predictors
- [ ] Write test: Oracle timeout abandons market
- [ ] Write test: No two-sided market refunds all
- [ ] Write test: Multiple markets from same NFT
- [ ] Write test: Complex scenario with 50+ predictors

**Coverage Analysis**:
- [ ] Run coverage report
- [ ] Identify uncovered lines
- [ ] Write tests for uncovered scenarios
- [ ] Achieve >95% branch coverage
- [ ] Achieve >95% line coverage
- [ ] Document any intentionally uncovered code

**Attack/Exploit Testing**:
- [ ] Test reentrancy on all external calls
- [ ] Test integer overflow scenarios
- [ ] Test access control bypass attempts
- [ ] Test state manipulation attempts
- [ ] Test gas griefing scenarios
- [ ] Test front-running scenarios

**Testnet Deployment**:
- [ ] Create deployment script
- [ ] Deploy MockUSDC to Sepolia
- [ ] Deploy DealerNFT (proxy + implementation) to Sepolia
- [ ] Deploy PredictionMarket (proxy + implementation) to Sepolia
- [ ] Verify all contracts on Etherscan
- [ ] Mint test NFT to test dealer
- [ ] Set permissions on NFT
- [ ] Configure Chainlink Functions subscription
- [ ] Document all deployed addresses

**End-to-End Testing on Testnet**:
- [ ] Create market on Sepolia via contract
- [ ] Create market on Sepolia via TypeScript client
- [ ] Place predictions from multiple accounts
- [ ] Wait for prediction deadline
- [ ] Lock market and trigger oracle
- [ ] Verify oracle responds correctly
- [ ] Claim payouts
- [ ] Test upgrade on Sepolia
- [ ] Verify state preserved after upgrade

**Documentation**:
- [ ] Document deployment process
- [ ] Document all contract addresses
- [ ] Document Chainlink configuration
- [ ] Create troubleshooting guide
- [ ] Document gas costs on testnet

**Deliverables**:
- `Integration.test.ts` with 15+ comprehensive scenarios
- All tests passing (200+ total tests across all files)
- **>95% code coverage** achieved
- Contracts deployed and verified on Sepolia
- E2E tests on testnet successful
- Complete deployment documentation
- Testnet addresses in DEPLOYED.json

### Phase 9: Unified Client (Week 7-8)

**Unified Types**:
- [ ] Create `src/unified/types.ts`
- [ ] Define MarketResult interface (chain-agnostic)
- [ ] Define PredictionResult interface
- [ ] Define UnifiedTransaction interface
- [ ] Define Wallet union type

**Client Implementation**:
- [ ] Create `src/unified/prediction-client.ts`
- [ ] Set up test file: `test/unified/unified-client.test.ts`
- [ ] Implement PredictionClient class skeleton
- [ ] Write test: Should detect EVM chain and route to EVM client
- [ ] Implement chain detection and routing
- [ ] Write test: Should create market on EVM chain
- [ ] Implement `createMarket()` with EVM routing
- [ ] Write test: Should convert EVM result to unified format
- [ ] Implement result conversion (EVM → unified)

**All Methods**:
- [ ] Write test: Should place prediction on EVM
- [ ] Implement `placePrediction()` with routing
- [ ] Write test: Should update prediction on EVM
- [ ] Implement `updatePrediction()` with routing
- [ ] Write test: Should remove prediction on EVM
- [ ] Implement `removePrediction()` with routing
- [ ] Write test: Should claim payout on EVM
- [ ] Implement `claimPayout()` with routing
- [ ] Write test: Should get market on EVM
- [ ] Implement `getMarket()` with routing
- [ ] Write test: Should get prediction on EVM
- [ ] Implement `getPrediction()` with routing

**Error Handling**:
- [ ] Write test: Should throw on unsupported chain type
- [ ] Write test: Should throw on missing chain configuration
- [ ] Write test: Should handle EVM client errors gracefully
- [ ] Add unified error handling

**Examples**:
- [ ] Create `examples/evm-usage.ts`
- [ ] Create `examples/unified-usage.ts`
- [ ] Add example for creating market
- [ ] Add example for placing predictions
- [ ] Add example for claiming payouts
- [ ] Test examples compile

**Documentation**:
- [ ] Write README for unified client
- [ ] Document all interfaces
- [ ] Add JSDoc comments
- [ ] Create API reference
- [ ] Add usage guide

**Deliverables**:
- PredictionClient unified class working with EVM
- `unified-client.test.ts` with 20+ tests
- Examples for EVM (Solana placeholder)
- Full JSDoc documentation
- **>90% test coverage** for unified client
- All tests passing

### Phase 10: Solana Contracts (Week 8-12)

- [ ] Set up Anchor project for dealer-nft
- [ ] Set up Anchor project for prediction-market
- [ ] Implement NFT program (similar to EVM)
- [ ] Implement Prediction Market program
- [ ] Implement equilibrium algorithm (may need batching)
- [ ] Integrate Switchboard oracle
- [ ] Implement payout system
- [ ] Write comprehensive tests
- [ ] Deploy to Devnet

**Deliverables**:
- Solana programs fully implemented
- All tests passing
- Deployed to Devnet

### Phase 11: Solana TypeScript Client (Week 12-13)

- [ ] Implement SolanaPredictionClient class
- [ ] Implement all program interactions
- [ ] Add compute unit optimization
- [ ] Write client tests
- [ ] Generate Anchor TypeScript types
- [ ] Integrate with unified client

**Deliverables**:
- Full-featured Solana client
- Integrated with unified client

### Phase 12: Final Testing & Documentation (Week 13-14)

- [ ] Comprehensive testing across both chains
- [ ] Performance testing
- [ ] Security audit preparation
- [ ] Complete API documentation
- [ ] Create usage guides
- [ ] Create deployment guides
- [ ] Prepare for mainnet

**Deliverables**:
- Production-ready codebase
- Complete documentation
- Deployment plan

---

## Development Stack

### EVM Stack

**Smart Contracts**:
- Solidity 0.8.24
- OpenZeppelin Contracts Upgradeable 5.0+
- OpenZeppelin Hardhat Upgrades (for UUPS validation)
- Chainlink Contracts (Functions)

**Development & Testing**:
- Hardhat 2.26+
- @openzeppelin/hardhat-upgrades (validates storage layout)
- TypeChain 8.3+
- Viem 2.38+
- Chai for testing

**Deployment & Upgrades**:
- Hardhat scripts with viem
- UUPS Proxy (ERC1967Proxy)
- Multi-sig: Gnosis Safe (recommended for mainnet owner)
- Verification: Etherscan API

### Solana Stack

**Smart Contracts**:
- Anchor 0.28+
- Rust 1.70+
- Solana CLI 1.17+

**Development & Testing**:
- Anchor test framework
- Solana Program Test
- @solana/web3.js 1.95+

**Deployment**:
- Anchor deploy
- Multi-sig: Squads
- Native USDC: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

### TypeScript Client Stack

**Core Dependencies**:
- TypeScript 5.9+
- Viem 2.38+ (EVM)
- @solana/web3.js 1.95+ (Solana)
- @solana/spl-token 0.4+ (Solana)

**Build & Test**:
- ts-node for scripts
- Mocha for unified tests
- Chai for assertions

**Type Generation**:
- TypeChain (EVM)
- Anchor IDL (Solana)

---

## Testing Strategy

### Test-Driven Development Approach

**Core Principle**: Write tests before or alongside implementation, not after.

**Benefits**:
- Catches bugs earlier in development
- Ensures all code is testable
- Documents expected behavior
- Provides confidence in refactoring
- Achieves higher test coverage naturally

**Workflow for Each Feature**:
1. **Write Test**: Define expected behavior with a failing test
2. **Implement**: Write minimum code to make test pass
3. **Refactor**: Improve code while tests remain green
4. **Repeat**: Move to next feature

**Example Flow**:
```
✍️  Write test: "Should place prediction with valid parameters"
❌ Test fails (not implemented)
🔨 Implement placePrediction() function
✅ Test passes
🔧 Refactor for clarity/efficiency
✅ Tests still pass
📝 Commit
```

**Test Coverage Targets**:
- **Phase 2-6** (Contracts): >95% coverage for each module
- **Phase 7** (EVM Client): >90% coverage
- **Phase 8** (Integration): >95% overall coverage
- **Phase 9** (Unified Client): >90% coverage

### EVM Tests (`test/evm/`)

**Test Files**:
- `DealerNFT.test.ts` - NFT contract tests
- `PredictionMarket.test.ts` - Core market functionality
- `Equilibrium.test.ts` - Equilibrium algorithm tests
- `Payout.test.ts` - Payout calculations
- `Oracle.test.ts` - Oracle integration
- `Security.test.ts` - Attack vectors
- `Upgrade.test.ts` - UUPS upgrade scenarios
- `Integration.test.ts` - Full lifecycle

**Upgrade Tests** (`Upgrade.test.ts`):
- Initialize upgradeable contracts correctly
- Only owner can upgrade
- Upgrade preserves state and storage
- Upgrade to new implementation works
- Storage layout compatibility checks
- Re-initialization prevention
- Upgrade events emitted correctly

**Expected Test Counts**:
- `DealerNFT.test.ts`: ~20 tests
- `PredictionMarket.test.ts`: ~25 tests
- `Equilibrium.test.ts`: ~25 tests
- `Payout.test.ts`: ~25 tests
- `Oracle.test.ts`: ~15 tests
- `Security.test.ts`: ~30 tests
- `Upgrade.test.ts`: ~6 tests
- `Integration.test.ts`: ~15 tests
- **Total EVM Contract Tests**: ~160 tests

**Coverage Target**: >95%

### Solana Tests (`programs/*/src/tests/`)

**Test Files**:
- Unit tests in Rust
- Integration tests with Anchor
- Compute unit optimization tests

**Coverage Target**: >90%

### Unified Client Tests (`test/unified/`)

**Test Files**:
- `evm-client.test.ts` - EVM client tests
- `unified-client.test.ts` - Unified interface tests
- `solana-client.test.ts` - Solana client tests (Phase 11)

**Expected Test Counts**:
- `evm-client.test.ts`: ~30 tests
- `unified-client.test.ts`: ~20 tests
- `solana-client.test.ts`: ~30 tests (Solana phase)
- **Total Client Tests (EVM only)**: ~50 tests
- **Total Client Tests (with Solana)**: ~80 tests

**Coverage Target**: >90%

### Total Test Count Summary

**By Phase 8** (EVM Complete):
- EVM Contract Tests: ~160 tests
- EVM Client Tests: ~50 tests
- **Total: ~210 tests**

**By Phase 12** (Full Project):
- EVM Contract Tests: ~160 tests
- EVM + Unified Client Tests: ~80 tests
- Solana Tests: ~50 tests (estimate)
- **Total: ~290 tests**

---

## UUPS Upgradeable Proxy Pattern

### Why UUPS for This Project

Unlike mail_box_contracts which uses immutable contracts, this prediction market system uses **UUPS (Universal Upgradeable Proxy Standard)** because:

1. **Complex Logic**: The equilibrium algorithm and payout calculations may need refinement post-launch
2. **Bug Fixes**: Critical bugs in market resolution or payouts can be fixed without redeployment
3. **Feature Additions**: New features (e.g., multi-oracle support, new market types) can be added
4. **Gas Efficiency**: UUPS is more gas-efficient than Transparent Proxy pattern
5. **Security**: Upgrade logic is in implementation (not proxy), reducing attack surface

### UUPS Architecture

```
┌─────────────────────────┐
│   ERC1967Proxy          │  ← User interacts with this address (never changes)
│   (Storage Layer)       │
│                         │
│   delegatecall ↓        │
│                         │
│   ┌─────────────────┐   │
│   │ Implementation  │   │  ← Logic contract (can be upgraded)
│   │ (DealerNFT or   │   │
│   │  PredictionMkt) │   │
│   │                 │   │
│   │ - Business      │   │
│   │   logic         │   │
│   │ - upgradeTo()   │   │
│   └─────────────────┘   │
└─────────────────────────┘
```

### Key UUPS Patterns in Contracts

**Initialization** (instead of constructor):
```solidity
function initialize(address _usdc, address _nft) public initializer {
    __Ownable_init(msg.sender);
    __ReentrancyGuard_init();
    __Pausable_init();
    __UUPSUpgradeable_init();

    usdcToken = IERC20(_usdc);
    dealerNFT = IERC721(_nft);
}
```

**Upgrade Authorization**:
```solidity
function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
    // Only owner can upgrade
}
```

**Storage Layout Rules**:
- Never remove or reorder existing storage variables
- Only add new variables at the end
- Use storage gaps for future-proofing:
```solidity
uint256[50] private __gap; // Reserve storage slots for future versions
```

### Upgrade Safety Checklist

Before each upgrade:
- [ ] Run `prepare-upgrade` script to validate
- [ ] Verify storage layout compatibility
- [ ] Test on testnet first
- [ ] Ensure no storage variables removed/reordered
- [ ] Check new implementation compiles
- [ ] Verify upgrade authorization (only owner)
- [ ] Review initialization guards (prevent re-init)
- [ ] Test state preservation after upgrade

### Upgrade Process

1. **Prepare**: `npm run prepare-upgrade:evm`
   - Validates upgrade safety
   - Estimates gas costs
   - Deploys new implementation for testing

2. **Test on Testnet**: `npm run upgrade:evm:sepolia`
   - Upgrade on Sepolia
   - Verify state preserved
   - Test all functions work

3. **Upgrade Mainnet**: `npm run upgrade:evm:mainnet`
   - Deploy new implementation
   - Call `upgradeTo()` on proxy
   - Verify upgrade successful
   - Update DEPLOYED.json

---

## Deployment Process

### EVM Deployment

**Script**: `scripts/evm/deploy.ts`

```typescript
import { viem } from 'hardhat';
import fs from 'fs';

async function main() {
  console.log('Deploying to', hre.network.name);

  // 1. Deploy NFT Implementation
  const nftImpl = await viem.deployContract('DealerNFT');
  console.log('NFT Implementation:', nftImpl.address);

  // 2. Deploy NFT Proxy
  const nftProxy = await viem.deployContract('ERC1967Proxy', [
    nftImpl.address,
    nftImpl.interface.encodeFunctionData('initialize', [])
  ]);
  console.log('NFT Proxy:', nftProxy.address);

  // 3. Deploy Prediction Market Implementation
  const pmImpl = await viem.deployContract('PredictionMarket');
  console.log('Prediction Market Implementation:', pmImpl.address);

  // 4. Deploy Prediction Market Proxy
  const usdcAddress = process.env.USDC_ADDRESS;
  const pmProxy = await viem.deployContract('ERC1967Proxy', [
    pmImpl.address,
    pmImpl.interface.encodeFunctionData('initialize', [
      usdcAddress,
      nftProxy.address
    ])
  ]);
  console.log('Prediction Market Proxy:', pmProxy.address);

  // 5. Update DEPLOYED.json
  updateDeployedJson({
    network: hre.network.name,
    nft: nftProxy.address,
    predictionMarket: pmProxy.address,
    usdc: usdcAddress
  });
}

main().catch(console.error);
```

**Verification**: `scripts/evm/verify.ts`

```typescript
import { run } from 'hardhat';

async function main() {
  const deployed = JSON.parse(fs.readFileSync('DEPLOYED.json'));
  const network = hre.network.name;
  const config = deployed[network];

  await run('verify:verify', {
    address: config.nft,
    constructorArguments: []
  });

  await run('verify:verify', {
    address: config.predictionMarket,
    constructorArguments: []
  });
}

main().catch(console.error);
```

**Upgrade Script**: `scripts/evm/upgrade.ts`

```typescript
import { viem } from 'hardhat';
import fs from 'fs';

async function main() {
  console.log('Upgrading contracts on', hre.network.name);

  const deployed = JSON.parse(fs.readFileSync('DEPLOYED.json'));
  const network = hre.network.name;
  const config = deployed[network];

  if (!config) {
    throw new Error(`No deployment found for network ${network}`);
  }

  // 1. Deploy new NFT implementation
  console.log('Deploying new DealerNFT implementation...');
  const newNftImpl = await viem.deployContract('DealerNFT');
  console.log('New NFT Implementation:', newNftImpl.address);

  // 2. Upgrade NFT proxy to new implementation
  console.log('Upgrading NFT proxy...');
  const nftProxy = await viem.getContractAt('DealerNFT', config.nft);
  const nftUpgradeTx = await nftProxy.write.upgradeTo([newNftImpl.address]);
  console.log('NFT upgrade tx:', nftUpgradeTx);

  // 3. Deploy new PredictionMarket implementation
  console.log('Deploying new PredictionMarket implementation...');
  const newPmImpl = await viem.deployContract('PredictionMarket');
  console.log('New Prediction Market Implementation:', newPmImpl.address);

  // 4. Upgrade PredictionMarket proxy to new implementation
  console.log('Upgrading PredictionMarket proxy...');
  const pmProxy = await viem.getContractAt('PredictionMarket', config.predictionMarket);
  const pmUpgradeTx = await pmProxy.write.upgradeTo([newPmImpl.address]);
  console.log('Prediction Market upgrade tx:', pmUpgradeTx);

  // 5. Update DEPLOYED.json with new implementation addresses
  config.nftImplementation = newNftImpl.address;
  config.predictionMarketImplementation = newPmImpl.address;
  config.lastUpgrade = new Date().toISOString();

  fs.writeFileSync('DEPLOYED.json', JSON.stringify(deployed, null, 2));
  console.log('DEPLOYED.json updated');

  console.log('\n✅ Upgrade complete!');
  console.log('NFT Proxy (unchanged):', config.nft);
  console.log('NFT Implementation (new):', newNftImpl.address);
  console.log('Prediction Market Proxy (unchanged):', config.predictionMarket);
  console.log('Prediction Market Implementation (new):', newPmImpl.address);
}

main().catch(console.error);
```

**Prepare Upgrade Script**: `scripts/evm/prepare-upgrade.ts`

```typescript
import { viem } from 'hardhat';
import fs from 'fs';

/**
 * Validates upgrade safety before actual upgrade
 * Checks storage layout compatibility
 */
async function main() {
  console.log('Validating upgrade safety...\n');

  const deployed = JSON.parse(fs.readFileSync('DEPLOYED.json'));
  const network = hre.network.name;
  const config = deployed[network];

  // 1. Check current implementation versions
  const nftProxy = await viem.getContractAt('DealerNFT', config.nft);
  const pmProxy = await viem.getContractAt('PredictionMarket', config.predictionMarket);

  console.log('Current NFT implementation:', config.nftImplementation || 'N/A');
  console.log('Current PM implementation:', config.predictionMarketImplementation || 'N/A');

  // 2. Compile new versions
  console.log('\nCompiling new implementations...');
  await hre.run('compile');

  // 3. Deploy new implementations (without upgrading)
  console.log('\nDeploying new implementations for testing...');
  const newNftImpl = await viem.deployContract('DealerNFT');
  const newPmImpl = await viem.deployContract('PredictionMarket');

  console.log('New NFT implementation:', newNftImpl.address);
  console.log('New PM implementation:', newPmImpl.address);

  // 4. Verify storage layout compatibility
  console.log('\n⚠️  IMPORTANT: Verify storage layout compatibility manually');
  console.log('Compare the storage layout of old vs new implementations');
  console.log('Ensure no storage variables were removed or reordered');
  console.log('New variables should only be added at the end');

  // 5. Estimate gas costs
  console.log('\nEstimating upgrade gas costs...');

  try {
    const nftGasEstimate = await nftProxy.estimateGas.upgradeTo([newNftImpl.address]);
    const pmGasEstimate = await pmProxy.estimateGas.upgradeTo([newPmImpl.address]);

    console.log('NFT upgrade gas estimate:', nftGasEstimate.toString());
    console.log('PM upgrade gas estimate:', pmGasEstimate.toString());
  } catch (error) {
    console.error('Gas estimation failed:', error.message);
    console.log('This might indicate incompatibility or access control issues');
  }

  console.log('\n✅ Preparation complete');
  console.log('Review the output above before running the actual upgrade');
  console.log('To upgrade, run: npm run upgrade:evm:' + network);
}

main().catch(console.error);
```

### Solana Deployment

**Anchor Deploy**:
```bash
# Devnet
anchor deploy --provider.cluster devnet

# Mainnet
anchor deploy --provider.cluster mainnet-beta
```

**Solana Upgrade**:
Solana programs can be upgraded if the upgrade authority is set:
```bash
# Build new version
anchor build

# Upgrade (requires upgrade authority)
anchor upgrade <PROGRAM_ID> target/deploy/prediction_market.so --provider.cluster devnet
```

**Update DEPLOYED.json**:
```typescript
{
  "eth-sepolia": {
    "network": "eth-sepolia",
    "nft": "0x...",                           // Proxy address (never changes)
    "nftImplementation": "0x...",              // Implementation address (changes on upgrade)
    "predictionMarket": "0x...",               // Proxy address (never changes)
    "predictionMarketImplementation": "0x...", // Implementation address (changes on upgrade)
    "usdc": "0x...",
    "deployedAt": "2025-01-13T...",
    "lastUpgrade": "2025-02-15T..."           // Track upgrade date
  },
  "solana-devnet": {
    "network": "solana-devnet",
    "programId": "...",
    "usdc": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "deployedAt": "2025-01-13T..."
  }
}
```

---

## Package Publishing

### Build Process

```bash
# Build all
npm run build

# Build individual components
npm run build:evm      # Compile contracts + generate types
npm run build:solana   # Build Anchor programs
npm run build:unified  # Compile TypeScript clients
```

### Package Structure

```
dist/
├── unified/
│   └── src/
│       ├── evm/
│       ├── solana/
│       ├── unified/
│       └── utils/
typechain-types/
target/
│   ├── idl/
│   └── types/
```

### Publishing

```json
{
  "files": [
    "dist/",
    "typechain-types/",
    "target/idl/",
    "target/types/",
    "README.md",
    "LICENSE"
  ]
}
```

---

## Documentation Requirements

### README.md

- Overview of prediction market system
- Installation instructions
- Quick start guide
- API reference links
- Examples for both chains

### API Documentation

- TypeDoc for TypeScript
- NatSpec for Solidity
- Anchor doc comments for Rust

### Guides

- Dealer guide (NFT management, market creation)
- Predictor guide (placing predictions, claiming payouts)
- Developer guide (client integration)
- Deployment guide (both chains)

---

## Security Considerations

All security considerations from previous version remain valid. Key additions for infrastructure:

### Smart Contract Security

**UUPS Upgrade Security**:
- Only contract owner can upgrade via `_authorizeUpgrade()`
- Initialization can only be called once (initializer modifier)
- Storage layout must be preserved across upgrades
- Storage gaps protect against future variable additions
- Implementation address validation before upgrade
- Test upgrades on testnet before mainnet
- Multi-sig recommended for upgrade authority on mainnet

**Storage Layout Safety**:
- Never remove storage variables
- Never change order of existing variables
- Only add new variables at the end
- Use `uint256[N] private __gap` for future-proofing
- Document storage layout in comments
- Use OpenZeppelin's storage layout validation tools

**Access Control**:
- Only owner can upgrade contracts
- Only owner can pause/unpause
- Only owner can configure fees
- Only NFT holder can create markets
- Only oracle can resolve markets
- Only predictor can claim their own payout

### Client Security

- Proper wallet validation
- Transaction simulation before sending
- Gas/compute limits
- Error handling and user feedback

### Infrastructure Security

- Environment variable management
- Private key handling
- Multi-sig for mainnet ownership
- Deployment verification

---

## Timeline Summary

**EVM Implementation**: 7-8 weeks
- Week 1: Project setup & infrastructure
- Week 1-2: Core contracts
- Week 2-3: Equilibrium algorithm
- Week 3-4: Oracle integration
- Week 4-5: Payout & fees
- Week 5-6: Security & admin
- Week 6: EVM TypeScript client
- Week 7: Testing & deployment
- Week 7-8: Unified client

**Solana Implementation**: 5-6 weeks
- Week 8-12: Solana contracts
- Week 12-13: Solana TypeScript client
- Week 13-14: Final testing & documentation

**Total**: 13-14 weeks for complete implementation

---

## Next Steps

1. ✅ Review and approve this updated plan
2. ⏭️ Initialize project structure (Week 1 starts here)
3. ⏭️ Set up development environment
4. ⏭️ Install all dependencies (including @openzeppelin/hardhat-upgrades)
5. ⏭️ Begin Phase 1: Project Setup & Infrastructure
6. ⏭️ Set up CI/CD pipeline
7. ⏭️ Implement UUPS contracts (Phase 2)

---

## Summary: Key Differences from mail_box_contracts

This project follows mail_box_contracts' architecture but with important differences:

### Infrastructure (Same as mail_box_contracts)
✅ Hardhat for EVM deployment
✅ Cargo/Anchor for Solana
✅ Unified TypeScript client architecture
✅ Three-layer client (EVM, Solana, Unified)
✅ Viem for EVM interactions
✅ @solana/web3.js for Solana
✅ DEPLOYED.json for deployment tracking
✅ Same build/test/deploy script patterns

### Smart Contracts (Different - Uses UUPS)
🔄 **UUPS Upgradeable Pattern** (mail_box_contracts are immutable)
🔄 **Proxy + Implementation** architecture
🔄 `initialize()` instead of `constructor`
🔄 Upgrade scripts and validation
🔄 Storage layout management
🔄 Multi-sig recommended for owner

### Why UUPS for This Project?
The prediction market system is more complex than a simple messaging system:
- Complex equilibrium algorithm may need refinement
- Payout calculations are critical and may need fixes
- Oracle integration may need updates
- Fee structures may need adjustment
- New features can be added post-launch

### Developer Experience
Developers familiar with mail_box_contracts will find:
- Same project structure
- Same client API patterns
- Same deployment commands
- Additional upgrade commands
- Storage layout considerations for upgrades

---

## Document Information

**Document Version**: 5.0 (Updated with Test-Driven Development)
**Last Updated**: 2025-11-13
**Status**: Ready for Implementation
**Reference Architecture**: ~/0xmail/mail_box_contracts (infrastructure only)
**Upgrade Pattern**: UUPS (differs from reference)
**Development Approach**: Test-Driven Development (TDD)

**Key Changes in v5.0**:
- Added test-first approach to all implementation phases
- Detailed test tasks for each feature
- Expected test counts per module
- Test-driven workflow documentation
- Total test count summary: ~210 tests (EVM), ~290 tests (Full)

---

**End of Plan Document**
