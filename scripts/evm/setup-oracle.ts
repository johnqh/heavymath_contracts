/**
 * Setup oracle for a market and resolve it.
 *
 * Usage:
 *   MARKET_ID=5 RESULT=0 bun run setup-oracle:sepolia
 *
 * Env vars:
 *   MARKET_ID - On-chain market ID (required)
 *   RESULT    - Resolution result: 0 = negative wins, 1 = positive wins (required)
 *
 * Steps:
 *   1. Register oracle (CustomData type) on OracleResolver if not already active
 *   2. Authorize deployer as updater if not already
 *   3. Push the result via updateOracleData
 *   4. Complete resolution on PredictionMarket via completeOracleResolution
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const marketId = process.env.MARKET_ID;
  const result = process.env.RESULT;

  if (!marketId || result === undefined) {
    console.error("Usage: MARKET_ID=5 RESULT=0 bun run setup-oracle:sepolia");
    console.error("  RESULT: 0 = negative wins, 1 = positive wins");
    process.exit(1);
  }

  const resultValue = parseInt(result);
  if (resultValue !== 0 && resultValue !== 1) {
    console.error("RESULT must be 0 or 1");
    process.exit(1);
  }

  // Load deployed addresses
  const deployedPath = path.join(__dirname, "../../DEPLOYED.json");
  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));
  const network = await ethers.provider.getNetwork();
  const chainName =
    network.chainId === 11155111n
      ? "sepolia"
      : network.chainId === 1n
        ? "mainnet"
        : "unknown";
  const addresses = deployed.networks[chainName];

  if (!addresses) {
    console.error(`No deployment found for network: ${chainName}`);
    process.exit(1);
  }

  const [signer] = await ethers.getSigners();
  console.log(`Signer: ${signer.address}`);
  console.log(`Network: ${chainName} (${network.chainId})`);

  // Get contract instances
  const predictionMarket = await ethers.getContractAt(
    "PredictionMarket",
    addresses.predictionMarket.proxy,
    signer
  );
  const oracleResolver = await ethers.getContractAt(
    "OracleResolver",
    addresses.oracleResolver.proxy,
    signer
  );

  // Read the market's oracleId
  const market = await predictionMarket.markets(marketId);
  const oracleId = market.oracleId;
  console.log(`\nMarket ${marketId}:`);
  console.log(`  Status: ${market.status} (4=Locked)`);
  console.log(`  OracleId: ${oracleId}`);
  console.log(`  Equilibrium: ${market.equilibrium}`);

  if (
    oracleId ===
    "0x0000000000000000000000000000000000000000000000000000000000000000"
  ) {
    console.error("Market has no oracle ID");
    process.exit(1);
  }

  // Step 1: Check if oracle is registered, if not register it
  const oracleConfig = await oracleResolver.oracles(oracleId);
  if (!oracleConfig.isActive) {
    console.log("\nStep 1: Registering oracle (CustomData type)...");
    const tx = await oracleResolver.registerOracle(
      oracleId,
      2, // OracleType.CustomData
      ethers.ZeroAddress, // no data source needed
      0, // minValue
      1, // maxValue (0 or 1 for binary)
      365 * 24 * 60 * 60 // 1 year stale period
    );
    await tx.wait();
    console.log(`  Registered: ${tx.hash}`);
  } else {
    console.log("\nStep 1: Oracle already registered ✓");
  }

  // Step 2: Authorize deployer as updater if not already
  const isAuthorized = await oracleResolver.authorizedUpdaters(signer.address);
  if (!isAuthorized) {
    console.log("\nStep 2: Authorizing deployer as updater...");
    const tx = await oracleResolver.setAuthorizedUpdater(
      signer.address,
      true
    );
    await tx.wait();
    console.log(`  Authorized: ${tx.hash}`);
  } else {
    console.log("\nStep 2: Deployer already authorized ✓");
  }

  // Step 3: Push the resolution result
  console.log(
    `\nStep 3: Pushing result ${resultValue} (${resultValue === 1 ? "POSITIVE" : "NEGATIVE"})...`
  );
  const tx3 = await oracleResolver.updateOracleData(oracleId, resultValue);
  await tx3.wait();
  console.log(`  Updated: ${tx3.hash}`);

  // Step 4: Complete resolution on PredictionMarket
  console.log("\nStep 4: Completing oracle resolution on PredictionMarket...");
  const tx4 = await predictionMarket.completeOracleResolution(marketId);
  await tx4.wait();
  console.log(`  Resolved: ${tx4.hash}`);

  // Verify
  const updatedMarket = await predictionMarket.markets(marketId);
  console.log(
    `\n✅ Market ${marketId} resolved: status=${updatedMarket.status} (2=Resolved), positiveOutcome=${updatedMarket.positiveOutcome}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
