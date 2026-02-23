# Improvement Plans for @sudobility/heavymath_contracts

## Priority 1 - High Impact

### 1. Add JSDoc to EVMPredictionClient Methods and Private Helpers
- The `EVMPredictionClient` class in `src/evm/index.ts` has 13 write methods and 2 read methods with no JSDoc comments on any of them.
- Critical parameters lack documentation: `percentage` accepts 0-100 but this is not documented at the TypeScript level; `amount` is in raw token units (6 decimals for USDC) but not noted; `feeBps` range (10-200) is only documented in the Solidity contract.
- Private helpers like `ensureAllowance`, `resolveStakeToken`, and `execute` contain important behavioral details (e.g., automatic ERC20 approval, caching of stakeToken address) that should be documented.
- The `formatMarket` function uses positional array indexing with `unknown[]` casts, which would benefit from inline documentation mapping each index to the Solidity struct field.

### 2. Add Error Handling and Custom Error Types to the SDK
- The `EVMPredictionClient` methods propagate raw viem errors without wrapping or enriching them.
- `ensureAccount` throws a generic `Error("Wallet client is not configured with an account")` with no error code or type discrimination.
- `getPublicClient` throws a generic `Error` when no public client is provided.
- There is no way for consumers to programmatically distinguish between "wallet not configured", "insufficient allowance", "contract revert", or "network error" without string-matching error messages.
- Adding a custom error hierarchy (e.g., `ContractError`, `WalletError`, `AllowanceError`) with error codes would improve the consumer experience, especially for the app layer that needs to show user-friendly messages.

### 3. Add Unit Tests for the TypeScript SDK
- The `test/evm/` directory contains Hardhat integration tests for the Solidity contracts but no unit tests for the TypeScript SDK classes (`EVMPredictionClient`, `PredictionClient`).
- The `EVMPredictionClient` has testable logic: `ensureAllowance` (allowance check + conditional approve), `resolveStakeToken` (caching behavior), `formatMarket` (tuple parsing), and parameter validation.
- These can be tested with mocked `PublicClient`/`WalletClient` objects without requiring a Hardhat node.
- The unified `PredictionClient` wrapper should also have basic instantiation and delegation tests.

## Priority 2 - Medium Impact

### 3. Add Access Control to OracleResolver.markResolved()
- The CLAUDE.md explicitly notes: "`OracleResolver.markResolved()` currently has no access control - it should be restricted to the PredictionMarket contract in production."
- Currently, any address can call `markResolved(oracleId)`, which could allow marking oracles as resolved prematurely or without an actual resolution.
- This should store the PredictionMarket address (set during initialization or via a setter) and require `msg.sender == predictionMarket` on `markResolved`.

### 4. Implement Placeholder Scripts (upgrade.ts, verify.ts, prepare-upgrade.ts)
- Three deployment scripts are stubs that print "not yet implemented" and exit: `upgrade.ts`, `verify.ts`, and `prepare-upgrade.ts`.
- These are marked as "Phase 8" but represent critical operational capabilities for a production deployment: UUPS proxy upgrades, Etherscan verification, and pre-upgrade safety checks.
- At minimum, `verify.ts` should be implemented first since contract verification is needed immediately after any deployment and is the simplest to implement using `@nomicfoundation/hardhat-verify`.

### 5. Clean Up Empty Placeholder Modules and Fix Package Export Inconsistencies
- `src/solana/index.ts` contains only `export {};` with no implementation path.
- `src/react/hooks/` is an empty directory with a package.json export pointing to non-existent files.
- `src/react-native/` has a build config and package export but no source files.
- `publishConfig.access` in `package.json` is set to `"restricted"` while CI/CD is configured for `"public"` access, creating a potential publishing conflict.
- These should either be removed entirely (reducing confusion for contributors) or documented with clear timelines and TODOs in the source files.

## Priority 3 - Nice to Have

### 6. Add TypeScript Return Type Annotations to `getPrediction`
- The `getPrediction` method in `EVMPredictionClient` lacks an explicit return type annotation, relying on inference from the tuple destructuring.
- While `getMarket` explicitly uses `Promise<ReturnType<typeof formatMarket>>`, `getPrediction` returns an inline anonymous object type.
- Extracting a named `PredictionState` type (analogous to the existing `MarketState`) would improve API discoverability and enable re-use.

### 7. Add Gas Estimation Methods to the SDK
- Currently, all write methods call `writeContract` directly without offering gas estimation.
- Adding `estimateGas` variants (or an `estimate: boolean` option) for expensive operations like `placePrediction` and `resolveMarket` would help the app layer show gas cost previews to users.
- This is particularly relevant for the equilibrium calculation in `resolveMarket`, which involves an O(101) on-chain loop.

### 8. Add Event Parsing Utilities to the SDK
- The SDK handles transaction submission and receipt waiting but does not parse emitted events from transaction receipts.
- Consumers need to manually decode events from receipts to extract data like `marketId` from `MarketCreated` events or `amount` from `WinningsClaimed` events.
- Adding a `parseEvents` utility or extending `TransactionResult` with parsed event data would simplify the consumer workflow, especially for `createMarket` where the returned `marketId` is only available in the event log.
