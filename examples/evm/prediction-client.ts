import { createWalletClient, createPublicClient, http, parseAbi } from "viem";
import { sepolia } from "viem/chains";
import { PredictionClient } from "../../src/unified/index.js";

async function main() {
  if (!process.env.PRIVATE_KEY) {
    throw new Error("PRIVATE_KEY env var is required");
  }
  if (!process.env.PREDICTION_MARKET || !process.env.USDC_ADDRESS) {
    throw new Error("PREDICTION_MARKET and USDC_ADDRESS env vars are required");
  }

  const walletClient = createWalletClient({
    chain: sepolia,
    transport: http(),
    account: process.env.PRIVATE_KEY as `0x${string}`,
  });
  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(),
  });

  const client = new PredictionClient({
    predictionMarket: process.env.PREDICTION_MARKET as `0x${string}`,
    stakeToken: process.env.USDC_ADDRESS as `0x${string}`,
  });

  // Query market
  const market = await client.evm.getMarket(publicClient, 1n);
  console.log("Market", market);

  // Place prediction (ensure you have USDC balance)
  const receipt = await client.evm.placePrediction(
    { walletClient, publicClient },
    1n,
    55,
    1_000_000n
  );
  console.log("Placed prediction tx:", receipt.hash);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
