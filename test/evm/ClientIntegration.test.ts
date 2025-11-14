import { expect } from "chai";
import { EVMPredictionClient } from "../../src/evm/index.ts";
import {
  advanceTime,
  deployPredictionFixture,
  toUSDC,
} from "./utils/fixture.ts";

const ZERO_ORACLE_ID =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

describe("EVMPredictionClient integration", function () {
  it("handles ERC20 approvals, placement, and withdrawals", async function () {
    const {
      market,
      stakeToken,
      dealer1,
      predictor1,
      publicClient,
    } = await deployPredictionFixture();

    const block = await publicClient.getBlock();
    const deadline = block.timestamp + 86401n;
    await market.write.createMarket(
      [1n, 1n, 1n, deadline, "Client integration", ZERO_ORACLE_ID],
      { account: dealer1.account }
    );

    // Reset allowance to verify client auto-approves
    await stakeToken.write.approve([market.address, 0n], {
      account: predictor1.account,
    });

    const client = new EVMPredictionClient({
      predictionMarket: market.address,
      stakeToken: stakeToken.address,
    });

    await client.placePrediction(
      { walletClient: predictor1, publicClient },
      1n,
      55,
      toUSDC("25")
    );

    const prediction = await market.read.predictions([
      1n,
      predictor1.account.address,
    ]);
    expect(prediction[0]).to.equal(toUSDC("25"));

    await client.withdrawPrediction({ walletClient: predictor1 }, 1n);
    const cleared = await market.read.predictions([
      1n,
      predictor1.account.address,
    ]);
    expect(cleared[0]).to.equal(0n);
  });

  it("cancels and abandons markets through the client", async function () {
    const {
      market,
      dealer1,
      predictor1,
      publicClient,
    } = await deployPredictionFixture();

    const block = await publicClient.getBlock();
    const deadline = block.timestamp + 86401n;
    await market.write.createMarket(
      [1n, 1n, 1n, deadline, "Lifecycle client", ZERO_ORACLE_ID],
      { account: dealer1.account }
    );

    const client = new EVMPredictionClient({
      predictionMarket: market.address,
    });

    await client.cancelMarket({ walletClient: dealer1 }, 1n);
    let marketData = await market.read.markets([1n]);
    expect(marketData[8]).to.equal(1); // Cancelled

    // Create new market to test abandonment
    const freshBlock = await publicClient.getBlock();
    const newDeadline = freshBlock.timestamp + 86401n;
    await market.write.createMarket(
      [1n, 1n, 1n, newDeadline, "Abandon via client", ZERO_ORACLE_ID],
      { account: dealer1.account }
    );
    const newMarketId = await market.read.marketCounter();
    await market.write.placePrediction([newMarketId, 60n, toUSDC("10")], {
      account: predictor1.account,
    });

    await advanceTime(86401 + 86401);
    await client.abandonMarket({ walletClient: predictor1 }, newMarketId);

    marketData = await market.read.markets([newMarketId]);
    expect(marketData[8]).to.equal(3); // Abandoned
  });
});
