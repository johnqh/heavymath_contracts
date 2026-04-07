# Chainlink Oracle Resolution Setup

This guide covers setting up the full Chainlink Any API flow for automated oracle resolution of prediction markets.

## Architecture Overview

```
User clicks "Resolve"
        |
        v
PredictionMarket.requestOracleResolution(marketId)
        |
        v
OracleResolver.requestResolution(marketId, oracleId)
        |
        v
Chainlink Node fetches: {apiBaseUrl}{chainId}-{marketId}/resolve
        |  (e.g. https://api.heavymath.io/api/markets/11155111-5/resolve)
        |
        v
Chainlink Node extracts "result" field (0 or 1)
        |
        v
OracleResolver.fulfillResolution(requestId, result)   [Chainlink callback]
        |  stores result in latestData[oracleId]
        v
User clicks "Complete Resolution"
        |
        v
PredictionMarket.completeOracleResolution(marketId)
        |  reads latestData from OracleResolver
        |  percentage=100 (positive wins) or percentage=0 (negative wins)
        v
Market Resolved
```

## Prerequisites

### 1. Publicly accessible indexer

The Chainlink node must be able to fetch the resolve endpoint over HTTPS. The indexer cannot be on localhost.

**Options:**
- Deploy the indexer to a cloud server (recommended for production)
- Use a tunnel for development:
  ```bash
  # Cloudflare Tunnel (recommended)
  cloudflared tunnel --url http://localhost:42079

  # Or ngrok
  ngrok http 42079
  ```

The resolve endpoint returns:
```json
{
  "result": 0,
  "gameFinished": true,
  "score": "1-2",
  "description": "Manchester City won (1-2)"
}
```

Where `result` is `0` (negative team won) or `1` (positive team won). The Chainlink job extracts the `result` field.

### 2. LINK tokens

The OracleResolver needs LINK tokens to pay for Chainlink requests.

| Network | LINK Token Address | Faucet |
|---------|-------------------|--------|
| Sepolia | `0x779877A7B0D9E8603169DdbD7836e478b4624789` | https://faucets.chain.link/sepolia |
| Ethereum Mainnet | `0x514910771AF9Ca656af840dff83E8264EcF986CA` | N/A (purchase) |
| Polygon | `0xb0897686c545045aFc77CF20eC7A532E3120E0F1` | https://faucets.chain.link/polygon |
| Arbitrum | `0xf97f4df75117a78c1A5a0DBb814Af92458539FB4` | N/A |

### 3. Chainlink operator and job ID

You need a Chainlink oracle node that supports **HTTP GET > uint256** jobs.

**Sepolia testnet options:**

| Provider | Operator Address | Job ID (HTTP GET > uint256) | Fee |
|----------|-----------------|----------------------------|-----|
| [LinkWell Nodes](https://docs.linkwellnodes.io/services/direct-request-jobs/testnets/Sepolia-Testnet-Jobs) | `0x0FaCf846af22BCE1C7f88D1d55A038F27747eD2B` | `a8356f48569c434eaa4ac5fcb4db5cc0` | 0 LINK |

**Mainnet:** Use [Chainlink Market](https://market.link/) to find operators, or run your own node.

## Setup Steps

### Step 1: Set environment variables

Add to `.env.local` in the heavymath_contracts project:

```bash
# Chainlink Configuration
LINK_TOKEN_ADDRESS=0x779877A7B0D9E8603169DdbD7836e478b4624789
CHAINLINK_ORACLE_ADDRESS=0x0FaCf846af22BCE1C7f88D1d55A038F27747eD2B
CHAINLINK_JOB_ID=0xa8356f48569c434eaa4ac5fcb4db5cc000000000000000000000000000000000
CHAINLINK_FEE=0
CHAINLINK_API_BASE_URL=https://your-indexer-domain.com/api/markets/
```

**Note on Job ID:** The Chainlink job ID must be a `bytes32` hex string. Convert the UUID-style job ID to bytes32 by removing dashes and right-padding with zeros:
```
a8356f48569c434eaa4ac5fcb4db5cc0  (UUID without dashes, 32 hex chars)
→ 0xa8356f48569c434eaa4ac5fcb4db5cc000000000000000000000000000000000  (bytes32)
```

### Step 2: Configure OracleResolver

If Chainlink was not configured during initial deployment, run the configuration manually.

**Using Hardhat console:**
```bash
npx hardhat console --network sepolia
```

```javascript
const [signer] = await ethers.getSigners();

const oracleResolver = await ethers.getContractAt(
  "OracleResolver",
  "0xa926f2087c7fa88542674fd75204d3c6e146d9d2",  // OracleResolver proxy
  signer
);

// Configure Chainlink
await oracleResolver.setChainlinkConfig(
  "0x779877A7B0D9E8603169DdbD7836e478b4624789",  // LINK token (Sepolia)
  "0x0FaCf846af22BCE1C7f88D1d55A038F27747eD2B",  // Operator (LinkWell Sepolia)
  "0xa8356f48569c434eaa4ac5fcb4db5cc000000000000000000000000000000000",  // Job ID
  0,  // Fee (0 LINK on testnet)
  "https://your-indexer-domain.com/api/markets/"  // Public indexer URL
);
```

**Or during deployment:** Set the env vars before running `bun run deploy:evm:sepolia`. The deploy script automatically calls `setChainlinkConfig` when all Chainlink env vars are present.

### Step 3: Register oracle IDs

Each market's `oracleId` must be registered on the OracleResolver before it can be resolved. This is because `getOracleData()` checks `oracles[oracleId].isActive`.

Register as `CustomData` type (type `2`), which allows Chainlink to write data to it:

```javascript
// Register oracle for a specific market
const market = await predictionMarket.markets(5);  // market ID 5
const oracleId = market.oracleId;

await oracleResolver.registerOracle(
  oracleId,
  2,                      // OracleType.CustomData
  ethers.ZeroAddress,     // no external data source
  0,                      // minValue
  1,                      // maxValue
  365 * 24 * 60 * 60      // stalePeriod: 1 year
);
```

**Automating registration:** Oracle registration should be done when a market is created. The app's `InlineCreateMarketForm` saves oracle config to the indexer after market creation. A backend job or the deploy script can batch-register oracle IDs on-chain.

### Step 4: Fund OracleResolver with LINK

Transfer LINK tokens to the OracleResolver proxy address:

```javascript
const linkToken = await ethers.getContractAt(
  "IERC20",
  "0x779877A7B0D9E8603169DdbD7836e478b4624789",
  signer
);

// Transfer 1 LINK (enough for many testnet requests at 0 fee)
await linkToken.transfer(
  "0xa926f2087c7fa88542674fd75204d3c6e146d9d2",  // OracleResolver proxy
  ethers.parseEther("1")
);
```

On testnet with LinkWell (0 fee), you still need at least a small LINK balance for the contract to work. On mainnet, estimate based on fee per request.

### Step 5: Set up oracle config in the indexer

The indexer needs to know which team is positive/negative for each market. This is done via the indexer API:

```bash
curl -X POST "https://your-indexer-domain.com/api/markets/11155111-5/oracle-config" \
  -H "Content-Type: application/json" \
  -d '{
    "positiveTeamId": "157",
    "positiveTeamName": "Bayern Munich",
    "negativeTeamName": "Manchester City"
  }'
```

The app's `InlineCreateMarketForm` automatically saves this after market creation. For existing markets, save it manually via the API.

## Resolution Flow (User-facing)

Once everything is configured:

1. **Market is locked** (after deadline, anyone calls `lockMarket`)
2. **User clicks "Resolve Market"** in the UI
   - App calls `PredictionMarket.requestOracleResolution(marketId)`
   - Chainlink node picks up the request, fetches the indexer endpoint
   - Chainlink callback writes the result to OracleResolver
3. **User clicks "Complete Resolution"** (after callback)
   - App calls `PredictionMarket.completeOracleResolution(marketId)`
   - Market is resolved based on the oracle result

The UI shows the indexer's pre-check result (game score, winner) before the user initiates the on-chain resolution.

## Troubleshooting

### "Oracle not active"
The oracle ID is not registered on OracleResolver. Register it with `registerOracle()`.

### "Chainlink not configured"
`setChainlinkConfig` has not been called on OracleResolver. Run Step 2.

### "Oracle data not available" / "Oracle data stale"
The Chainlink callback hasn't been received yet, or the data is older than `stalePeriod`. Wait for the callback or check if the Chainlink request was sent successfully.

### "Oracle data too early"
The oracle data timestamp is before the market's deadline. The game result was fetched too early. Wait until after the deadline and request again.

### "Resolution already pending"
A Chainlink request is already in flight for this market. Wait for the callback.

### "Failed to check resolution status" (UI)
The indexer's oracle config is missing for this market. Save it via `POST /api/markets/:id/oracle-config`.

### Checking Chainlink request status
Use [Chainlink Explorer](https://sepolia.etherscan.io) to check the OracleResolver's events:
- `ResolutionRequested` — request was sent
- `ResolutionFulfilled` — callback was received

## Contract Addresses (Sepolia)

| Contract | Proxy Address |
|----------|--------------|
| PredictionMarket | `0x409464d2e712ffc7e64baa191cac65c731581f05` |
| OracleResolver | `0xa926f2087c7fa88542674fd75204d3c6e146d9d2` |
| DealerNFT | `0x62d545189b5caa014de27787f3d996e10c437e35` |
| LINK Token | `0x779877A7B0D9E8603169DdbD7836e478b4624789` |
| USDC (Stake Token) | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |

## Environment Variables Reference

| Variable | Description | Example |
|----------|------------|---------|
| `LINK_TOKEN_ADDRESS` | LINK token contract address | `0x779877A7B0D9E8603169DdbD7836e478b4624789` |
| `CHAINLINK_ORACLE_ADDRESS` | Chainlink operator/node address | `0x0FaCf846af22BCE1C7f88D1d55A038F27747eD2B` |
| `CHAINLINK_JOB_ID` | Job ID as bytes32 hex (HTTP GET > uint256) | `0xa8356f48...` |
| `CHAINLINK_FEE` | LINK fee per request in wei | `0` (testnet) |
| `CHAINLINK_API_BASE_URL` | Public indexer URL ending with `/api/markets/` | `https://api.heavymath.io/api/markets/` |
