# CLAUDE.md - Heavymath Contracts

This file provides context for Claude Code when working on this project.

## Project Overview

Multi-chain prediction market smart contracts for EVM chains (with planned Solana support) and a TypeScript SDK. Features a novel percentage-based prediction mechanism with dual-boundary market split settlement.

- **Package**: `@sudobility/heavymath_contracts`
- **Stack**: Solidity 0.8.24, Hardhat, Viem 2, TypeScript
- **License**: See LICENSE.md (BUSL-1.1)
- **Package manager**: Bun (required)
- **Node**: >=20.18.0

## Quick Commands

```bash
# Build
bun run build                  # Build everything (evm compile + unified TS + react-native TS)
bun run build:ci               # CI build (compile EVM + unified + react-native)
bun run build:evm              # Compile Solidity + build EVM TypeScript (tsconfig.evm.json)
bun run build:unified          # Build unified TS client (tsconfig.unified.json)
bun run build:react-native     # Build react-native TS client (tsconfig.react-native.json)
bun run build:solana           # Build Solana Rust program + TS bindings (NOT IMPLEMENTED - no programs/ dir)

# Test
bun run test                   # Alias for test:evm
bun run test:evm               # Run Hardhat tests via tsx (node --import tsx/esm)
bun run test:ci                # Build unified then run unified tests directly
bun run test:solana            # Run Solana Rust tests (NOT IMPLEMENTED - no programs/ dir)

# Compile
bun run compile                # Alias for compile:evm
bun run compile:evm            # npx hardhat compile

# Lint / Format / Typecheck
bun run lint                   # ESLint check (.ts, .js)
bun run lint:fix               # ESLint autofix
bun run typecheck              # tsc --noEmit (runs hardhat compile first via pretypecheck)
bun run format                 # Prettier write
bun run format:check           # Prettier check

# Deploy (only deploy.ts is fully implemented)
bun run deploy:evm:local       # Deploy to Hardhat in-process network
bun run deploy:evm:localhost   # Deploy to local Hardhat node (http://127.0.0.1:8545)
bun run deploy:evm:sepolia     # Deploy to Sepolia testnet
bun run deploy:evm:mainnet     # Deploy to Ethereum mainnet

# NOT YET IMPLEMENTED (placeholder scripts that print warnings):
bun run upgrade:evm:sepolia    # UUPS upgrade - placeholder, prints "not yet implemented"
bun run upgrade:evm:mainnet    # UUPS upgrade - placeholder, prints "not yet implemented"
bun run verify:evm:sepolia     # Etherscan verify - placeholder, prints "not yet implemented"
bun run verify:evm:mainnet     # Etherscan verify - placeholder, prints "not yet implemented"
bun run prepare-upgrade:evm    # Pre-upgrade validation - placeholder, prints "not yet implemented"

# Clean
bun run clean                  # npx hardhat clean
```

## Project Structure

```
heavymath_contracts/
├── contracts/                       # Solidity source
│   ├── PredictionMarket.sol             # Core market logic (~1293 lines, UUPS upgradeable)
│   ├── DealerNFT.sol                    # ERC721 license system (~306 lines, UUPS upgradeable)
│   ├── OracleResolver.sol               # Oracle + Chainlink integration (~466 lines, UUPS upgradeable)
│   ├── MockUSDC.sol                     # Test ERC20 token (6 decimals, 21 lines)
│   ├── ERC1967Proxy.sol                 # Re-exports OZ ERC1967Proxy for deploy/test use
│   └── interfaces/                      # Empty - reserved for future interface extractions
├── calculate.ts                     # TypeScript reference implementation of market split algorithm
├── src/                             # TypeScript SDK
│   ├── evm/index.ts                     # EVMPredictionClient (full implementation)
│   ├── unified/index.ts                 # PredictionClient (wraps EVMPredictionClient)
│   ├── solana/index.ts                  # Empty shell ("Will be implemented in Phase 11")
│   ├── react/hooks/                     # Empty directory - reserved for React hooks
│   └── utils/                           # Empty directory - reserved for shared utilities
├── test/evm/                        # Hardhat/Mocha test suites
│   ├── PredictionMarket.test.ts         # Market lifecycle tests
│   ├── DealerNFT.test.ts               # NFT permission tests
│   ├── SplitUSDC.test.ts                # Market split algorithm tests
│   ├── ClientIntegration.test.ts        # SDK integration tests
│   └── utils/fixture.ts                # Shared test fixture (deployPredictionFixture)
├── scripts/evm/                     # Deployment & upgrade scripts
│   ├── deploy.ts                        # IMPLEMENTED: Deploy all 3 proxies, save DEPLOYED.json
│   ├── upgrade.ts                       # PLACEHOLDER: Prints "not yet implemented" (Phase 8)
│   ├── verify.ts                        # PLACEHOLDER: Prints "not yet implemented" (Phase 8)
│   └── prepare-upgrade.ts              # PLACEHOLDER: Prints "not yet implemented" (Phase 8)
├── typechain-types/                 # Generated contract types (ethers-v6 target)
├── hardhat.config.cts               # Hardhat configuration
├── tsconfig.json                    # Base TS config
├── tsconfig.evm.json                # EVM-only build (dist/evm)
├── tsconfig.unified.json            # Unified build (dist/unified) - includes evm, solana, react
├── tsconfig.react-native.json       # React Native build (dist/react-native) - jsx: react-native
├── tsconfig.test.json               # Test build config
├── DEPLOYED.json                    # Live deployment addresses by network (sepolia, arbitrumSepolia, hardhat)
├── LICENSE.md                       # License file
└── .env.example                     # Environment template (20+ variables)
```

## NPM Package Exports

The package has multiple entry points for different environments:

| Import path                                    | Condition            | Output directory                      |
| ---------------------------------------------- | -------------------- | ------------------------------------- |
| `@sudobility/heavymath_contracts`              | node/browser/default | `dist/unified/src/unified/`           |
| `@sudobility/heavymath_contracts`              | react-native         | `dist/react-native/src/react-native/` |
| `@sudobility/heavymath_contracts/evm`          | any                  | `dist/unified/src/evm/`               |
| `@sudobility/heavymath_contracts/solana`       | any                  | `dist/unified/src/solana/` (empty)    |
| `@sudobility/heavymath_contracts/react-native` | any                  | `dist/react-native/src/react-native/` |

## Smart Contracts

### PredictionMarket.sol (Core - ~1293 lines)

**Inheritance chain:**
`Initializable` -> `OwnableUpgradeable` -> `PausableUpgradeable` -> `UUPSUpgradeable` -> `ReentrancyGuardUpgradeable`

**Constants:**

- `MIN_DURATION` = 24 hours (minimum market duration)
- `RESOLUTION_GRACE_PERIOD` = 24 hours (time after deadline before market can be abandoned)

**Fee state variables (contract-level, owner-configurable):**

- `winnerFeeBps` = 100 (1% default, max 1000 = 10%) — fee on the distributable pool
- `dealerSharePercent` = 50 (50% default) — dealer's share of the fee; remainder goes to platform

**Market status enum:** `Active` (0), `Cancelled` (1), `Resolved` (2), `Abandoned` (3), `Locked` (4)

**Market lifecycle:**

1. Dealer creates market (must own DealerNFT with valid permissions) -> status = `Active`
   - `createMarket()` for basic markets, `createMarketWithCondition()` for markets with oracle condition data
2. Predictors place predictions with percentage (0-100) and USDC amount before deadline
3. Predictors can update or withdraw their predictions any time before the market deadline
4. After deadline, **locking** must occur before resolution:
   - `lockMarket(marketId)` - anyone can call after deadline; calculates market split, refunds middle-zone, trims boundary stakes -> status = `Locked`
   - Reverts if no valid two-sided market split exists
5. After locking, resolution occurs via one of:
   - `resolveMarket()` - manual by dealer (only for non-oracle markets, oracleId == bytes32(0))
   - `resolveMarketByResolver()` - by authorized resolver address
   - `resolveMarketWithOracle()` - anyone can call (uses oracle data directly)
   - `requestOracleResolution()` + `completeOracleResolution()` - async Chainlink flow
6. After resolution: winners call `claimWinnings()`, lock-refunded predictors call `claimLockRefund()`, cancelled/abandoned predictors call `claimRefund()`
7. If unresolved after deadline + 24h RESOLUTION_GRACE_PERIOD: anyone can call `abandonMarket()` -> full refunds

**All external/public functions:**

- `initialize(dealerNFT, oracleResolver, stakeToken)` - proxy initializer
- `setTestMode(testMode)` - owner only, enables test mode (bypasses time checks)
- `setAuthorizedResolver(resolver)` - owner only, sets authorized resolver address
- `setWinnerFeeBps(feeBps)` - owner sets global winner fee (max 1000 = 10%)
- `setDealerSharePercent(percent)` - owner sets dealer's share of fee (0-100%)
- `createMarket(tokenId, category, subCategory, deadline, description, oracleId)` -> returns marketId
- `createMarketWithCondition(tokenId, category, subCategory, deadline, description, oracleId, conditionData)` -> returns marketId
- `placePrediction(marketId, percentage, amount)` - percentage 0-100, transfers ERC20 via SafeERC20
- `updatePrediction(marketId, newPercentage, additionalAmount)` - update prediction before deadline
- `withdrawPrediction(marketId)` - full withdrawal before deadline
- `lockMarket(marketId)` - anyone can call after deadline, calculates split + processes refunds -> status `Locked`
- `claimLockRefund(marketId)` - claim partial/full refund from lock (middle-zone or boundary trimming)
- `getLockRefundAmount(marketId, predictor)` - view, returns lock refund amount for a predictor
- `resolveMarket(marketId, positiveOutcome)` - manual resolution by dealer (non-oracle markets only)
- `resolveMarketByResolver(marketId, positiveOutcome)` - resolution by authorized resolver address
- `resolveMarketWithOracle(marketId)` - automated oracle resolution (anyone can call)
- `requestOracleResolution(marketId)` - initiates async Chainlink resolution request
- `completeOracleResolution(marketId)` - completes resolution after Chainlink callback
- `cancelMarket(marketId)` - dealer or owner, only if no predictions exist (pool == 0)
- `abandonMarket(marketId)` - anyone, after deadline + 24h grace
- `claimWinnings(marketId)` - winners claim proportional share of winner pool
- `claimRefund(marketId)` - cancelled/abandoned predictors get full refund
- `withdrawDealerFees(marketId)` - dealer withdraws fees from resolved market
- `withdrawSystemFees()` - owner withdraws accumulated system fees
- `pause()` / `unpause()` - owner only, affects createMarket, placePrediction, updatePrediction
- `calculateMarketSplit(marketId)` - view, O(101) scan across occupied percentage points
- `isWinner(marketId, predictor)` - view, checks if predictor is on winning side
- `getRefundAmount(marketId, predictor)` - view, returns refund amount
- `calculatePayout(marketId, predictor)` - view, returns payout for a winner

**Storage gap:** `uint256[48] private __gap` at end of contract for upgrade safety.

**State variables:**

- `winnerFeeBps` (uint256), `dealerSharePercent` (uint256) — fee configuration
- `dealerNFT` (DealerNFT), `oracleResolver` (OracleResolver), `stakeToken` (IERC20)
- `marketCounter` (uint256)
- `markets` (mapping uint256 => Market)
- `predictions` (mapping uint256 => mapping address => Prediction)
- `percentageTotals` (mapping uint256 => mapping uint256 => uint256)
- `marketPools` (mapping uint256 => uint256)
- `dealerFees`, `systemFees` (mapping uint256 => uint256)
- `totalSystemFees` (uint256)

### DealerNFT.sol (~306 lines)

**Inheritance chain:**
`Initializable` -> `ERC721Upgradeable` -> `ERC721EnumerableUpgradeable` -> `OwnableUpgradeable` -> `UUPSUpgradeable`

- ERC721 NFT-based licensing for market creation (name: "DealerLicense", symbol: "DLICENSE")
- **Public minting**: anyone can mint by paying `mintPrice` in the stake token (USDC)
- Permission system with category/subcategory validation
- Wildcard constant: `WILDCARD = 0xFF` means "all categories" or "all subcategories"
- `initialize(mintPrice)` - proxy initializer, sets initial mint price
- `setDefaultPermissions(category, subCategories[])` - owner only, sets permissions auto-granted on mint
- `setStakeToken(stakeToken)` - owner only, sets ERC20 token used for minting payment
- `mint()` - anyone can call, pays `mintPrice` in stake token, auto-assigns next tokenId + default permissions
- `setMintPrice(mintPrice)` - owner only, updates mint price
- `withdrawPayments()` - owner only, withdraws collected mint payments
- `setPermissions(tokenId, category, subCategories[])` - owner only, additive
- `hasPermissions(tokenId)` - view, checks if any permissions set
- `validatePermission(tokenId, category, subCategory)` - view, checks specific permission

**Permission resolution order:**

1. If `category=0xFF` with `subCategory=0xFF` -> allow all (full wildcard)
2. If specific category matches and has `subCategory=0xFF` -> allow all subcategories for that category
3. If specific category matches and subCategory is in the array -> allow that specific combination

**Storage gap:** `uint256[48] private __gap`

### OracleResolver.sol (~466 lines)

**Inheritance chain:**
`Initializable` -> `OwnableUpgradeable` -> `UUPSUpgradeable`

- Oracle types enum: `Manual` (0), `PriceFeed` (1), `CustomData` (2)
- `registerOracle(oracleId, oracleType, dataSource, minValue, maxValue, stalePeriod)` - owner only
- `updateOracleData(oracleId, value)` - authorized updaters or owner, CustomData type only
- `getOracleData(oracleId)` -> (percentage, timestamp, isValid) - staleness check
- `setPredictionMarket(predictionMarket)` - owner only, sets authorized PredictionMarket contract
- `markResolved(oracleId)` - called by PredictionMarket or owner after resolution (access-controlled via `predictionMarket` address)
- `registerOracleForMarket(oracleId)` - registers an oracle specifically for a market
- `setAuthorizedUpdater(updater, authorized)` - owner only
- `deactivateOracle(oracleId)` - owner only
- Normalizes raw values to 0-100 percentage range: `(value - min) * 100 / (max - min)`

**Chainlink Functions integration:**

- `setChainlinkConfig(token, oracle, jobId, fee, apiBaseUrl)` - owner only, configures Chainlink parameters
- `requestResolution(marketId, oracleId)` - sends Chainlink HTTP request to `{apiBaseUrl}{chainId}-{marketId}/resolve`; returns requestId
- `fulfillResolution(requestId, result)` - Chainlink callback, stores result as percentage (0 = negative, 100 = positive)
- `withdrawLink(to, amount)` - owner only, withdraws LINK tokens

**Storage gap:** `uint256[50] private __gap`

### MockUSDC.sol (21 lines)

- Simple ERC20 with 6 decimals for testing
- `mint(to, amount)` - owner only
- Not upgradeable (plain ERC20 + Ownable)

### ERC1967Proxy.sol (8 lines)

- Re-exports OpenZeppelin's ERC1967Proxy so Hardhat/viem can deploy it by name

## Core Algorithm: Market Split Calculation

The prediction mechanism uses percentage-based odds (0-100), not binary bets.

**Algorithm** (`calculateMarketSplit`): O(101) scan across occupied percentage points

1. Build the ordered set of occupied percentage points
2. Scan adjacent candidate boundaries while tracking negative-side and positive-side capital
3. Apply the bidirectional capital-adequacy constraints
4. Return the two split boundaries plus any capped boundary amounts

**Reference implementation:** `calculate.ts` at project root is a TypeScript reference-only implementation of the same algorithm, useful for off-chain simulation and understanding the logic. It is NOT used by the Solidity contracts or the SDK — the authoritative implementation lives in `PredictionMarket.sol`.

**Locking** (`lockMarket` -> `_processLockRefunds`):

1. Calculate the market split boundaries
2. Refund middle-zone predictions (between boundaries) in full
3. Trim overweight boundary stakes (partial refunds via `claimLockRefund()`)
4. Market transitions to `Locked` status

**Settlement** (`resolveMarket` / `resolveMarketWithOracle` / etc.):

1. Market must be in `Locked` status
2. If outcome resolves positive -> predictors at or above the positive boundary win
3. If outcome resolves negative -> predictors at or below the negative boundary win

**Fee calculation** (in `_calculateFees` / `calculatePayout`):

- `distributablePool` = totalPool after middle-zone refunds and boundary trimming
- `totalFee` = distributablePool \* winnerFeeBps / 10000 (default 1%)
- `dealerFee` = totalFee \* dealerSharePercent / 100 (default 50% of totalFee)
- `systemFee` = totalFee - dealerFee (remainder goes to platform)
- `winnerPool` = distributablePool - totalFee
- Each winner gets: `(their_bet / total_winning_bets) * winnerPool`

## TypeScript SDK

### EVMPredictionClient (src/evm/index.ts)

Full implementation wrapping PredictionMarket contract via viem.

```typescript
import { EVMPredictionClient } from '@sudobility/heavymath_contracts/evm';

const client = new EVMPredictionClient({
  predictionMarket: '0x...',
  stakeToken: '0x...', // optional, will be read from contract if omitted
});
```

**All methods (19 write + 6 read):**

| Method                                                                | Description                                                            |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `createMarket(wallet, params)`                                        | Create a new prediction market                                         |
| `setTestMode(wallet, testMode)`                                       | Enable/disable test mode (owner)                                       |
| `setWinnerFeeBps(wallet, feeBps)`                                     | Set global winner fee in basis points (owner)                          |
| `setDealerSharePercent(wallet, percent)`                              | Set dealer's share of fee as percentage (owner)                        |
| `placePrediction(wallet, marketId, percentage, amount)`               | Place prediction (auto-approves ERC20, validates 0-100)                |
| `updatePrediction(wallet, marketId, newPercentage, additionalAmount)` | Update prediction before deadline (auto-approves if additional amount) |
| `withdrawPrediction(wallet, marketId)`                                | Withdraw prediction before deadline                                    |
| `lockMarket(wallet, marketId)`                                        | Lock market after deadline (calculates split, processes refunds)       |
| `cancelMarket(wallet, marketId)`                                      | Cancel market (no predictions)                                         |
| `abandonMarket(wallet, marketId)`                                     | Abandon unresolved market after grace                                  |
| `resolveMarket(wallet, marketId, positiveOutcome)`                    | Manual resolution by dealer                                            |
| `resolveMarketWithOracle(wallet, marketId)`                           | Oracle-based resolution (sync)                                         |
| `requestOracleResolution(wallet, marketId)`                           | Initiate async Chainlink resolution                                    |
| `completeOracleResolution(wallet, marketId)`                          | Complete resolution after Chainlink callback                           |
| `claimLockRefund(wallet, marketId)`                                   | Claim refund from lock (middle-zone/boundary trimming)                 |
| `claimWinnings(wallet, marketId)`                                     | Claim winnings from resolved market                                    |
| `claimRefund(wallet, marketId)`                                       | Claim refund (cancelled/abandoned)                                     |
| `withdrawDealerFees(wallet, marketId)`                                | Withdraw dealer fees                                                   |
| `withdrawSystemFees(wallet)`                                          | Withdraw system fees (owner)                                           |
| `calculateMarketSplit(publicClient, marketId)`                        | Read market split boundaries (view)                                    |
| `getLockRefundAmount(publicClient, marketId, predictor)`              | Read lock refund amount for predictor (view)                           |
| `getLockRefunds(publicClient, marketId)`                              | Read all lock refund data (view)                                       |
| `getMarket(publicClient, marketId)`                                   | Read market state (view)                                               |
| `getPrediction(publicClient, marketId, account)`                      | Read prediction (view)                                                 |

**Key behavior:**

- `placePrediction` and `updatePrediction` automatically check ERC20 allowance and call `approve` if needed (`ensureAllowance`)
- Write methods return `TransactionResult { hash, receiptHash? }` - receiptHash populated only if publicClient provided
- Constructor accepts `ContractAddresses { predictionMarket, stakeToken? }` - stakeToken is resolved on-chain and cached if not provided

**Exported types:** `EVMPredictionClient`, `WalletContext`, `ContractAddresses`, `TransactionResult`, `CreateMarketParams`, `MarketState`, `LockRefundState`, `PredictionMarket__factory`, `PredictionMarket` (typechain type)

**`LockRefundState`** (returned by `getLockRefunds`): `{ negativeBoundary: bigint, positiveBoundary: bigint, negativeAllowedAmount: bigint, positiveAllowedAmount: bigint }` — the market split boundaries and allowed amounts after lock processing.

### PredictionClient (src/unified/index.ts)

Thin wrapper that exposes `evm: EVMPredictionClient` as a property. Placeholder for future multi-chain routing.

```typescript
import { PredictionClient } from "@sudobility/heavymath_contracts";

const client = new PredictionClient({ predictionMarket: "0x..." });
client.evm.placePrediction(wallet, marketId, 50, amount);
// or
client.getEvmClient().placePrediction(...);
```

**Re-exports:** `ContractAddresses`, `WalletContext`, `TransactionResult`, `CreateMarketParams`, `MarketState`, `LockRefundState`

### Solana Client (src/solana/index.ts)

**Empty shell.** Contains only `export {};` with a comment "Will be implemented in Phase 11". No Solana programs exist in the repository (no `programs/` directory, no `Anchor.toml`, no `.rs` files). The `build:solana`, `test:solana`, and `deploy:solana:*` scripts in package.json reference non-existent Cargo/Anchor infrastructure.

### React Hooks (src/react/)

**Empty Phase N placeholder.** The `src/react/hooks/` directory exists but contains no files. No package.json export exists for `./react` (removed — will be added when hooks are implemented). Do not add hooks here until a phase plan is defined.

### React Native (src/react-native/)

**Empty Phase N placeholder.** No source files exist yet. The build target `tsconfig.react-native.json` is configured but the source directory is empty. The react-native export in package.json points to `dist/react-native/src/react-native/index.js`. Do not add source files here until a phase plan is defined.

## Deployment

### deploy.ts (FULLY IMPLEMENTED)

Deploys all three contracts as UUPS proxies behind ERC1967Proxy:

1. Deploy DealerNFT implementation + proxy (calls `initialize()`)
2. Deploy OracleResolver implementation + proxy (calls `initialize()`)
3. Deploy PredictionMarket implementation + proxy (calls `initialize(dealerNFT, oracle, usdc)`)
4. Optionally transfers ownership to `OWNER_MULTISIG` (if set)
5. Saves all addresses (implementations + proxies) to `DEPLOYED.json`

```bash
# Required env vars for deployment:
USDC_ADDRESS=0x...           # ERC20 stake token address (required)
PRIVATE_KEY=0x...            # Deployer private key (required for non-local)
OWNER_MULTISIG=0x...         # Optional: transfer ownership after deploy

bun run deploy:evm:sepolia
```

### upgrade.ts, verify.ts, prepare-upgrade.ts (PLACEHOLDERS)

All three scripts are stubs that log a warning and exit. They are marked for "Phase 8" implementation. Running them will print "not yet implemented" and exit successfully. Do not rely on these scripts for actual upgrades or verification.

## Environment Variables (.env.example)

All environment variables (copy `.env.example` to `.env` or `.env.local`):

| Variable                       | Required   | Description                                               |
| ------------------------------ | ---------- | --------------------------------------------------------- |
| `PRIVATE_KEY`                  | For deploy | Deployer wallet private key                               |
| `SEPOLIA_RPC_URL`              | No         | Override Sepolia RPC (defaults to Alchemy or public node) |
| `MAINNET_RPC_URL`              | No         | Override mainnet RPC                                      |
| `ALCHEMY_API_KEY`              | No         | Alchemy key for building RPC URLs for all networks        |
| `ETHERSCAN_API_KEY`            | No         | Etherscan verification (mainnet/sepolia)                  |
| `ETHERSCAN_MULTICHAIN_API_KEY` | No         | Overrides per-chain keys if set                           |
| `POLYGONSCAN_API_KEY`          | No         | Polygon verification                                      |
| `ARBISCAN_API_KEY`             | No         | Arbitrum verification                                     |
| `BASESCAN_API_KEY`             | No         | Base verification                                         |
| `OPTIMISTIC_ETHERSCAN_API_KEY` | No         | Optimism verification                                     |
| `USDC_ADDRESS_MAINNET`         | No         | Mainnet USDC (default: 0xA0b8...eB48)                     |
| `USDC_ADDRESS_SEPOLIA`         | No         | Sepolia MockUSDC address                                  |
| `USDC_ADDRESS_POLYGON`         | No         | Polygon USDC (default: 0x2791...4174)                     |
| `USDC_ADDRESS_ARBITRUM`        | No         | Arbitrum USDC (default: 0xaf88...5831)                    |
| `USDC_ADDRESS_BASE`            | No         | Base USDC (default: 0x8335...2913)                        |
| `CHAINLINK_SUBSCRIPTION_ID`    | No         | Chainlink oracle config                                   |
| `CHAINLINK_DON_ID`             | No         | Chainlink oracle config                                   |
| `REPORT_GAS`                   | No         | Enable gas reporter (true/false)                          |
| `COINMARKETCAP_API_KEY`        | No         | For gas cost in USD                                       |
| `SOLANA_PRIVATE_KEY`           | No         | Future Solana deploy key                                  |
| `SOLANA_RPC_URL`               | No         | Solana RPC (default: devnet)                              |
| `USDC_ADDRESS`                 | For deploy | Used by deploy.ts directly                                |
| `OWNER_MULTISIG`               | No         | Transfer ownership after deploy                           |

The hardhat config loads `.env` first, then `.env.local` as fallback (override: false).

## Supported Networks (hardhat.config.cts)

| Network   | Chain ID | RPC Source                                         |
| --------- | -------- | -------------------------------------------------- |
| hardhat   | 1337     | In-process                                         |
| localhost | 1337     | http://127.0.0.1:8545                              |
| mainnet   | 1        | Alchemy (eth-mainnet)                              |
| sepolia   | 11155111 | SEPOLIA_RPC_URL or Alchemy or public node fallback |
| polygon   | 137      | Alchemy (polygon-mainnet)                          |
| optimism  | 10       | Alchemy (opt-mainnet)                              |
| arbitrum  | 42161    | Alchemy (arb-mainnet)                              |
| base      | 8453     | Alchemy (base-mainnet)                             |

Solidity compiler: 0.8.24 with optimizer enabled (200 runs).
TypeChain target: ethers-v6.
Note: `@openzeppelin/hardhat-upgrades` and `hardhat-chai-matchers` are commented out (require ethers; project uses viem).

## Test Fixture (test/evm/utils/fixture.ts)

`deployPredictionFixture()` sets up the full test environment:

1. Gets 6 wallet clients from Hardhat: `[owner, dealer1, dealer2, predictor1, predictor2, predictor3]`
2. Deploys DealerNFT as UUPS proxy with free minting (mintPrice = 0)
3. Deploys MockUSDC (6 decimals), sets as DealerNFT stake token
4. Mints dealer licenses for dealer1 and dealer2
5. Sets permissions: token #1 gets category 1 with wildcard subcategories (0xFF); token #2 gets category 1 with subcategories [1, 2]
6. Deploys OracleResolver as UUPS proxy
7. Deploys PredictionMarket as UUPS proxy (initialized with dealerNFT, oracleResolver, mockUSDC)
8. Registers PredictionMarket as authorized caller on OracleResolver (`setPredictionMarket()`)
9. Mints 100,000 USDC to each of [dealer1, dealer2, predictor1, predictor2, predictor3]
10. Approves PredictionMarket to spend 100,000 USDC for each wallet

Returns: `{ market, dealerNFT, oracleResolver, stakeToken, owner, dealer1, dealer2, predictor1, predictor2, predictor3, publicClient }`

Also exports:

- `USDC_DECIMALS = 6`
- `toUSDC(value: string)` - helper using `parseUnits(value, 6)`
- `advanceTime(seconds: number)` - helper to mine blocks with time increase

## Dependencies

**Runtime (dependencies):**

- `@openzeppelin/contracts-upgradeable` ^5.0.0

**Peer dependencies (all optional except viem for EVM usage):**

- `viem` >=2.0.0
- `@solana/web3.js` >=1.95.0, `@solana/spl-token` >=0.4.0
- `@sudobility/configs` ^0.0.73, `@sudobility/heavymath_types` ^0.0.31, `@sudobility/types` ^1.9.62
- `@tanstack/react-query` >=5.0.0
- `react` ^18 || ^19, `react-native` >=0.70.0
- `buffer` >=6.0.0, `text-encoding` >=0.7.0, `react-native-get-random-values` >=1.8.0, `react-native-url-polyfill` >=2.0.0

**Key dev dependencies:**

- `hardhat` ^2.26.3
- `@nomicfoundation/hardhat-viem` ^2.0.0
- `@nomicfoundation/hardhat-verify` ^2.0.0
- `@openzeppelin/contracts` ^5.4.0 (non-upgradeable imports: IERC20, SafeERC20, ERC20, Ownable, ERC1967Proxy)
- `viem` ^2.38.4
- `ethers` ^6.16.0 (for typechain only)
- `typescript` ^5.9.3
- `tsx` ^4.21.0 (for running tests)
- `@coral-xyz/anchor` ^0.30.1 (for future Solana)

## CI/CD

`.github/workflows/ci-cd.yml` uses reusable workflow `johnqh/workflows/.github/workflows/unified-cicd.yml@main`:

- Triggers on push/PR to `main` and `develop` branches
- npm-access: "public"
- Passes all repository secrets
- Permissions: contents write, id-token write (NPM provenance), deployments write

## Important Notes

- The project uses **viem** (not ethers) for all contract interactions in the SDK and deployment scripts. The ethers dependency exists only for TypeChain type generation.
- UUPS proxy deployment is manual (encodes `initialize` calldata and deploys `ERC1967Proxy`), not via `@openzeppelin/hardhat-upgrades` plugin.
- All three contracts have storage gaps (`__gap`) for upgrade safety: PredictionMarket[48], DealerNFT[48], OracleResolver[50].
- All three contracts disable initializers in their constructors (`_disableInitializers()`).
- `OracleResolver.markResolved()` is access-controlled: only the PredictionMarket contract or owner can call it. The PredictionMarket address must be set via `setPredictionMarket()` after deployment.
- `DEPLOYED.json` contains live deployment addresses for three networks:
  - **sepolia** (deployed 2026-04-21): DealerNFT `0x995...`, OracleResolver `0x8a5...`, PredictionMarket `0x43a...` (upgraded 2026-04-21)
  - **arbitrumSepolia** (deployed 2026-05-15): includes MockUSDC `0x132...` as stake token, DealerNFT, OracleResolver, PredictionMarket
  - **hardhat** (deployed 2026-04-20): local test deployment with Hardhat default accounts
  - The deploy script (`scripts/evm/deploy.ts`) writes/updates this file on each deployment.

## Ecosystem Context

This package is the **foundation** of the Heavymath prediction market platform. Changes here cascade downstream:

```text
heavymath_contracts  ← YOU ARE HERE
       ↓ ABIs, types, EVMPredictionClient SDK
heavymath_indexer    (indexes contract events into PostgreSQL)
       ↓ REST/GraphQL/SSE API
heavymath_indexer_client  (React hooks + IndexerClient HTTP class)
       ↓ hooks + types
heavymath_lib        (sports+favorites hooks, off-chain market-split calc)
       ↓ business logic
heavymath_app        (React + Vite web frontend)
```

### Downstream Impact of Changes

| What Changed                   | Who Must Update                                                           |
| ------------------------------ | ------------------------------------------------------------------------- |
| New/modified event in Solidity | indexer (handler + DB migration), indexer_client (types), heavymath_types |
| New contract function          | EVMPredictionClient SDK (this repo), app hooks if user-facing             |
| ABI change                     | indexer (abis/ JSON files), contracts SDK re-publish                      |
| New contract deployed          | indexer (.env addresses), app (.env addresses)                            |
| Type changes in SDK exports    | indexer_client, lib, app (all consume these types)                        |

### Deployment Order

1. Deploy contracts on-chain (scripts/evm/deploy.ts)
2. Call `OracleResolver.setPredictionMarket(predictionMarketProxy)` post-deploy
3. Mint DealerNFTs and set permissions
4. Publish npm package (`@sudobility/heavymath_contracts`)
5. Update indexer env vars with new contract addresses + start blocks
6. Update app env vars with new contract addresses

### Why viem (not ethers)

The SDK (`src/evm/index.ts`) uses **viem** for all contract interactions because the downstream app uses wagmi (which is built on viem). The `ethers` dependency exists **only** for TypeChain type generation during the Hardhat build. Never add ethers-based code to the SDK.
