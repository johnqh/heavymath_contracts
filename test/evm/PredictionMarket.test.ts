import "@nomicfoundation/hardhat-viem";
import { expect } from "chai";
import hre from "hardhat";
import { getAddress } from "viem";
import {
  advanceTime,
  deployPredictionFixture,
  toUSDC,
} from "./utils/fixture.ts";

const ZERO_ORACLE_ID =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

describe("PredictionMarket (USDC)", function () {
  describe("Initialization", function () {
    it("sets core dependencies and owner", async function () {
      const { market, dealerNFT, oracleResolver, stakeToken } =
        await deployPredictionFixture();

      expect(getAddress(await market.read.dealerNFT())).to.equal(
        getAddress(dealerNFT.address)
      );
      expect(getAddress(await market.read.oracleResolver())).to.equal(
        getAddress(oracleResolver.address)
      );
      expect(getAddress(await market.read.stakeToken())).to.equal(
        getAddress(stakeToken.address)
      );
    });
  });

  describe("Market lifecycle", function () {
    it("allows licensed dealer to create, update fee, and cancel empty market", async function () {
      const { market, dealer1, owner, publicClient } = await deployPredictionFixture();
      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;

      await market.write.createMarket(
        [1n, 1n, 1n, deadline, "Rain tomorrow?", ZERO_ORACLE_ID],
        { account: dealer1.account }
      );

      await market.write.setDealerFee([1n, 150n], { account: dealer1.account });

      await market.write.cancelMarket([1n], { account: owner.account });
      const marketData = await market.read.markets([1n]);
      expect(marketData[8]).to.equal(1); // Cancelled
    });

    it("lets predictors place, update, withdraw, and respects deadlines", async function () {
      const { market, dealer1, predictor1, publicClient, stakeToken } =
        await deployPredictionFixture();
      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;

      await market.write.createMarket(
        [1n, 1n, 1n, deadline, "Launch success?", ZERO_ORACLE_ID],
        { account: dealer1.account }
      );

      const startBalance = await stakeToken.read.balanceOf([predictor1.account.address]);

      await market.write.placePrediction([1n, 40n, toUSDC("100")], {
        account: predictor1.account,
      });

      await market.write.updatePrediction([1n, 60n, toUSDC("50")], {
        account: predictor1.account,
      });

      await market.write.withdrawPrediction([1n], { account: predictor1.account });

      const endBalance = await stakeToken.read.balanceOf([predictor1.account.address]);
      expect(endBalance).to.equal(startBalance);
    });
  });

  describe("Resolution & refunds", function () {
    async function openBalancedMarket() {
      const fixtures = await deployPredictionFixture();
      const block = await fixtures.publicClient.getBlock();
      const deadline = block.timestamp + 86401n;

      await fixtures.market.write.createMarket(
        [1n, 1n, 1n, deadline, "Balanced market", ZERO_ORACLE_ID],
        { account: fixtures.dealer1.account }
      );

      await fixtures.market.write.placePrediction([1n, 30n, toUSDC("100")], {
        account: fixtures.predictor1.account,
      });
      await fixtures.market.write.placePrediction([1n, 70n, toUSDC("100")], {
        account: fixtures.predictor2.account,
      });

      return { ...fixtures };
    }

    it("only allows current NFT owner to resolve manually", async function () {
      const { market, dealer1, dealer2, predictor1, dealerNFT } = await openBalancedMarket();

      await advanceTime(86401);

      try {
        await market.write.resolveMarket([1n, 50n], { account: predictor1.account });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("Not dealer owner");
      }

      const nft = await hre.viem.getContractAt("DealerNFT", dealerNFT.address);
      await nft.write.transferFrom([dealer1.account.address, dealer2.account.address, 1n], {
        account: dealer1.account,
      });

      await market.write.resolveMarket([1n, 60n], { account: dealer2.account });
      const marketData = await market.read.markets([1n]);
      expect(marketData[8]).to.equal(2); // resolved
    });

    it("auto-cancels if only one side participated", async function () {
      const { market, dealer1, predictor1, publicClient } = await deployPredictionFixture();
      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;

      await market.write.createMarket(
        [1n, 1n, 1n, deadline, "One sided", ZERO_ORACLE_ID],
        { account: dealer1.account }
      );

      await market.write.placePrediction([1n, 20n, toUSDC("200")], {
        account: predictor1.account,
      });

      await advanceTime(86401);
      await market.write.resolveMarket([1n, 10n], { account: dealer1.account });

      const state = await market.read.markets([1n]);
      expect(state[8]).to.equal(1); // cancelled
      const refund = await market.read.getRefundAmount([1n, predictor1.account.address]);
      expect(refund).to.equal(toUSDC("200"));
    });

    it("allows abandonment with refunds when dealer/oracle stalled", async function () {
      const { market, dealer1, predictor1, publicClient } = await deployPredictionFixture();
      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;

      await market.write.createMarket(
        [1n, 1n, 1n, deadline, "Abandon me", ZERO_ORACLE_ID],
        { account: dealer1.account }
      );
      await market.write.placePrediction([1n, 55n, toUSDC("50")], {
        account: predictor1.account,
      });

      await advanceTime(Number(86401n + 86401n));
      await market.write.abandonMarket([1n]);

      const refund = await market.read.getRefundAmount([1n, predictor1.account.address]);
      expect(refund).to.equal(toUSDC("50"));
    });

    it("distributes payouts and fees in USDC", async function () {
      const { market, dealer1, predictor1, predictor2, publicClient, stakeToken, owner } =
        await deployPredictionFixture();
      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;

      await market.write.createMarket(
        [1n, 1n, 1n, deadline, "Winner payout", ZERO_ORACLE_ID],
        { account: dealer1.account }
      );
      await market.write.setDealerFee([1n, 100n], { account: dealer1.account }); // 1%

      await market.write.placePrediction([1n, 40n, toUSDC("100")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([1n, 80n, toUSDC("100")], {
        account: predictor2.account,
      });

      await advanceTime(86401);
      await market.write.resolveMarket([1n, 70n], { account: dealer1.account });

      const winnerBefore = await stakeToken.read.balanceOf([predictor2.account.address]);
      await market.write.claimWinnings([1n], { account: predictor2.account });
      const winnerAfter = await stakeToken.read.balanceOf([predictor2.account.address]);
      expect(winnerAfter - winnerBefore).to.equal(toUSDC("197.8"));

      const dealerBefore = await stakeToken.read.balanceOf([dealer1.account.address]);
      await market.write.withdrawDealerFees([1n], { account: dealer1.account });
      const dealerAfter = await stakeToken.read.balanceOf([dealer1.account.address]);
      expect(dealerAfter - dealerBefore).to.equal(toUSDC("2"));

      const ownerBefore = await stakeToken.read.balanceOf([owner.account.address]);
      await market.write.withdrawSystemFees({ account: owner.account });
      const ownerAfter = await stakeToken.read.balanceOf([owner.account.address]);
      expect(ownerAfter - ownerBefore).to.equal(toUSDC("0.2"));
    });

    it("validates oracle timestamps before resolving", async function () {
      const { market, dealer1, oracleResolver, owner, publicClient, predictor1, predictor2 } =
        await deployPredictionFixture();
      const oracleId =
        "0x0000000000000000000000000000000000000000000000000000000000000abc";

      await oracleResolver.write.registerOracle(
        [oracleId, 2, getAddress(owner.account.address), 0n, 100n, 86400n],
        { account: owner.account }
      );
      await oracleResolver.write.setAuthorizedUpdater([owner.account.address, true], {
        account: owner.account,
      });

      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;

      await market.write.createMarket(
        [1n, 1n, 1n, deadline, "Oracle market", oracleId],
        { account: dealer1.account }
      );

      await market.write.placePrediction([1n, 20n, toUSDC("50")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([1n, 80n, toUSDC("50")], {
        account: predictor2.account,
      });

      // Publish oracle data too early
      await oracleResolver.write.updateOracleData([oracleId, 80n], {
        account: owner.account,
      });

      await advanceTime(86401);
      let reverted = false;
      try {
        await market.write.resolveMarketWithOracle([1n]);
        expect.fail("Should revert on early data");
      } catch {
        reverted = true;
      }
      expect(reverted).to.be.true;

      let state = await market.read.markets([1n]);
      expect(state[8]).to.equal(0); // still Active

      // Publish fresh data
      await oracleResolver.write.updateOracleData([oracleId, 90n], {
        account: owner.account,
      });

      await market.write.resolveMarketWithOracle([1n]);
      state = await market.read.markets([1n]);
      expect(state[8]).to.equal(2);
    });
  });
});
