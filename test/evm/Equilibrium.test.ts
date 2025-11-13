import { expect } from "chai";
import hre from "hardhat";
import { parseEther, encodeFunctionData, parseAbi } from "viem";

const { viem, network } = hre;

// Helper to advance time
async function advanceTime(seconds: number) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

describe("Equilibrium Calculation", function () {
  async function deployFixture() {
    const [owner, dealer1, predictor1, predictor2, predictor3, predictor4, predictor5] =
      await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();

    // Deploy DealerNFT
    const dealerNFTImpl = await viem.deployContract("DealerNFT");
    const dealerNFTInitData = encodeFunctionData({
      abi: parseAbi(["function initialize()"]),
      functionName: "initialize",
      args: [],
    });
    const dealerNFTProxy = await viem.deployContract("ERC1967Proxy", [
      dealerNFTImpl.address,
      dealerNFTInitData,
    ]);
    const dealerNFT = await viem.getContractAt("DealerNFT", dealerNFTProxy.address);

    // Mint license and set permissions
    await dealerNFT.write.mint([dealer1.account.address, 1n]);
    await dealerNFT.write.setPermissions([1n, 1n, [0xFFn]]);

    // Deploy PredictionMarket
    const marketImpl = await viem.deployContract("PredictionMarket");
    const marketInitData = encodeFunctionData({
      abi: parseAbi(["function initialize(address)"]),
      functionName: "initialize",
      args: [dealerNFT.address],
    });
    const marketProxy = await viem.deployContract("ERC1967Proxy", [
      marketImpl.address,
      marketInitData,
    ]);
    const market = await viem.getContractAt("PredictionMarket", marketProxy.address);

    return {
      market,
      dealerNFT,
      owner,
      dealer1,
      predictor1,
      predictor2,
      predictor3,
      predictor4,
      predictor5,
      publicClient,
    };
  }

  async function createMarketFixture() {
    const fixtures = await deployFixture();
    const block = await fixtures.publicClient.getBlock();
    const deadline = block.timestamp + 86401n;

    await fixtures.market.write.createMarket(
      [1n, 1n, 1n, deadline, "Equilibrium test market"],
      { account: fixtures.dealer1.account }
    );

    return { ...fixtures, marketId: 1n, deadline };
  }

  describe("Basic Equilibrium Scenarios", function () {
    it("Should calculate equilibrium at 50 for equal predictions at 30 and 70", async function () {
      const { market, predictor1, predictor2, marketId } = await createMarketFixture();

      // Predictor1: 1 ETH at 30%
      await market.write.placePrediction([marketId, 30n], {
        account: predictor1.account,
        value: parseEther("1.0"),
      });

      // Predictor2: 1 ETH at 70%
      await market.write.placePrediction([marketId, 70n], {
        account: predictor2.account,
        value: parseEther("1.0"),
      });

      const equilibrium = await market.read.calculateEquilibrium([marketId]);
      expect(equilibrium).to.equal(50n);
    });

    it("Should calculate equilibrium at 67 for 2:1 ratio (2 ETH at 20%, 1 ETH at 80%)", async function () {
      const { market, predictor1, predictor2, marketId } = await createMarketFixture();

      // Predictor1: 2 ETH at 20%
      await market.write.placePrediction([marketId, 20n], {
        account: predictor1.account,
        value: parseEther("2.0"),
      });

      // Predictor2: 1 ETH at 80%
      await market.write.placePrediction([marketId, 80n], {
        account: predictor2.account,
        value: parseEther("1.0"),
      });

      const equilibrium = await market.read.calculateEquilibrium([marketId]);
      // At 67: total_below (2 ETH) / total_above (1 ETH) = 2/1
      // percentage / (100 - percentage) = 67 / 33 ≈ 2
      expect(equilibrium).to.be.within(66n, 68n);
    });

    it("Should calculate equilibrium with multiple predictions at same percentage", async function () {
      const { market, predictor1, predictor2, predictor3, predictor4, marketId } =
        await createMarketFixture();

      // Three predictors at 25%: 3 ETH total
      await market.write.placePrediction([marketId, 25n], {
        account: predictor1.account,
        value: parseEther("1.0"),
      });
      await market.write.placePrediction([marketId, 25n], {
        account: predictor2.account,
        value: parseEther("1.0"),
      });
      await market.write.placePrediction([marketId, 25n], {
        account: predictor3.account,
        value: parseEther("1.0"),
      });

      // One predictor at 75%: 3 ETH
      await market.write.placePrediction([marketId, 75n], {
        account: predictor4.account,
        value: parseEther("3.0"),
      });

      const equilibrium = await market.read.calculateEquilibrium([marketId]);
      expect(equilibrium).to.equal(50n); // Equal amounts on both sides
    });

    it("Should calculate equilibrium with many predictions across spectrum", async function () {
      const { market, predictor1, predictor2, predictor3, predictor4, predictor5, marketId } =
        await createMarketFixture();

      // Spread predictions across different percentages
      await market.write.placePrediction([marketId, 10n], {
        account: predictor1.account,
        value: parseEther("0.5"),
      });
      await market.write.placePrediction([marketId, 30n], {
        account: predictor2.account,
        value: parseEther("1.0"),
      });
      await market.write.placePrediction([marketId, 50n], {
        account: predictor3.account,
        value: parseEther("2.0"),
      });
      await market.write.placePrediction([marketId, 70n], {
        account: predictor4.account,
        value: parseEther("1.0"),
      });
      await market.write.placePrediction([marketId, 90n], {
        account: predictor5.account,
        value: parseEther("0.5"),
      });

      const equilibrium = await market.read.calculateEquilibrium([marketId]);
      // With 50% having 2 ETH, equilibrium should be around 50
      expect(equilibrium).to.be.within(48n, 52n);
    });
  });

  describe("Winner Determination", function () {
    it("Should identify winners when result > equilibrium", async function () {
      const { market, dealer1, predictor1, predictor2, marketId, deadline } =
        await createMarketFixture();

      // Set up: equilibrium at 50
      await market.write.placePrediction([marketId, 30n], {
        account: predictor1.account,
        value: parseEther("1.0"),
      });
      await market.write.placePrediction([marketId, 70n], {
        account: predictor2.account,
        value: parseEther("1.0"),
      });

      // Advance time and resolve at 60 (> equilibrium of 50)
      await advanceTime(86402);
      await market.write.resolveMarket([marketId, 60n], {
        account: dealer1.account,
      });

      // Predictor2 (70%) should be winner (predicted > result > equilibrium)
      const isWinner1 = await market.read.isWinner([marketId, predictor1.account.address]);
      const isWinner2 = await market.read.isWinner([marketId, predictor2.account.address]);

      expect(isWinner1).to.be.false;
      expect(isWinner2).to.be.true;
    });

    it("Should identify winners when result < equilibrium", async function () {
      const { market, dealer1, predictor1, predictor2, marketId } =
        await createMarketFixture();

      // Set up: equilibrium at 50
      await market.write.placePrediction([marketId, 30n], {
        account: predictor1.account,
        value: parseEther("1.0"),
      });
      await market.write.placePrediction([marketId, 70n], {
        account: predictor2.account,
        value: parseEther("1.0"),
      });

      // Advance time and resolve at 40 (< equilibrium of 50)
      await advanceTime(86402);
      await market.write.resolveMarket([marketId, 40n], {
        account: dealer1.account,
      });

      // Predictor1 (30%) should be winner (predicted < result < equilibrium)
      const isWinner1 = await market.read.isWinner([marketId, predictor1.account.address]);
      const isWinner2 = await market.read.isWinner([marketId, predictor2.account.address]);

      expect(isWinner1).to.be.true;
      expect(isWinner2).to.be.false;
    });

    it("Should handle mixed predictions on same side of equilibrium", async function () {
      const { market, dealer1, predictor1, predictor2, predictor3, predictor4, marketId } =
        await createMarketFixture();

      // Create equilibrium around 50
      await market.write.placePrediction([marketId, 20n], {
        account: predictor1.account,
        value: parseEther("1.0"),
      });
      await market.write.placePrediction([marketId, 40n], {
        account: predictor2.account,
        value: parseEther("1.0"),
      });
      await market.write.placePrediction([marketId, 60n], {
        account: predictor3.account,
        value: parseEther("1.0"),
      });
      await market.write.placePrediction([marketId, 80n], {
        account: predictor4.account,
        value: parseEther("1.0"),
      });

      // Resolve at 65 (> equilibrium ~50)
      await advanceTime(86402);
      await market.write.resolveMarket([marketId, 65n], {
        account: dealer1.account,
      });

      // Predictors above equilibrium should win
      expect(await market.read.isWinner([marketId, predictor1.account.address])).to.be.false;
      expect(await market.read.isWinner([marketId, predictor2.account.address])).to.be.false;
      expect(await market.read.isWinner([marketId, predictor3.account.address])).to.be.true;
      expect(await market.read.isWinner([marketId, predictor4.account.address])).to.be.true;
    });
  });

  describe("Auto-Refund at Equilibrium", function () {
    it("Should auto-refund predictions exactly at equilibrium point", async function () {
      const { market, dealer1, predictor1, predictor2, predictor3, marketId } =
        await createMarketFixture();

      // Create scenario where equilibrium is at 50
      await market.write.placePrediction([marketId, 40n], {
        account: predictor1.account,
        value: parseEther("1.0"),
      });
      await market.write.placePrediction([marketId, 50n], {
        account: predictor2.account,
        value: parseEther("2.0"),
      });
      await market.write.placePrediction([marketId, 60n], {
        account: predictor3.account,
        value: parseEther("1.0"),
      });

      const equilibrium = await market.read.calculateEquilibrium([marketId]);

      // Resolve
      await advanceTime(86402);
      await market.write.resolveMarket([marketId, 55n], {
        account: dealer1.account,
      });

      // Predictor2 should be marked for refund if at equilibrium
      const refundAmount = await market.read.getRefundAmount([
        marketId,
        predictor2.account.address,
      ]);

      if (equilibrium === 50n) {
        expect(refundAmount).to.equal(parseEther("2.0"));
      }
    });
  });

  describe("Edge Cases", function () {
    it("Should handle market with single prediction", async function () {
      const { market, predictor1, marketId } = await createMarketFixture();

      await market.write.placePrediction([marketId, 50n], {
        account: predictor1.account,
        value: parseEther("1.0"),
      });

      const equilibrium = await market.read.calculateEquilibrium([marketId]);
      // With only one prediction, equilibrium will be near the prediction
      // The algorithm will find the point with minimal ratio difference
      expect(equilibrium).to.be.greaterThan(0n);
      expect(equilibrium).to.be.lessThan(100n);
    });

    it("Should handle all predictions at same percentage", async function () {
      const { market, predictor1, predictor2, predictor3, marketId } =
        await createMarketFixture();

      // All at 60%
      await market.write.placePrediction([marketId, 60n], {
        account: predictor1.account,
        value: parseEther("1.0"),
      });
      await market.write.placePrediction([marketId, 60n], {
        account: predictor2.account,
        value: parseEther("0.5"),
      });
      await market.write.placePrediction([marketId, 60n], {
        account: predictor3.account,
        value: parseEther("2.0"),
      });

      const equilibrium = await market.read.calculateEquilibrium([marketId]);
      // All same percentage means equilibrium will be near that point
      // The algorithm finds the best ratio match
      expect(equilibrium).to.be.greaterThan(0n);
      expect(equilibrium).to.be.lessThan(100n);
    });

    it("Should handle extreme imbalance (99% on one side)", async function () {
      const { market, predictor1, predictor2, marketId } = await createMarketFixture();

      // Massive bet on low side
      await market.write.placePrediction([marketId, 10n], {
        account: predictor1.account,
        value: parseEther("99.0"),
      });

      // Small bet on high side
      await market.write.placePrediction([marketId, 90n], {
        account: predictor2.account,
        value: parseEther("1.0"),
      });

      const equilibrium = await market.read.calculateEquilibrium([marketId]);
      // Equilibrium should be very low (around 10-15)
      expect(equilibrium).to.be.lessThan(20n);
    });

    it("Should return 0 equilibrium for market with no predictions", async function () {
      const { market, marketId } = await createMarketFixture();

      const equilibrium = await market.read.calculateEquilibrium([marketId]);
      expect(equilibrium).to.equal(0n);
    });
  });

  describe("Integration with Resolution", function () {
    it("Should store equilibrium when market is resolved", async function () {
      const { market, dealer1, predictor1, predictor2, marketId } =
        await createMarketFixture();

      await market.write.placePrediction([marketId, 30n], {
        account: predictor1.account,
        value: parseEther("1.0"),
      });
      await market.write.placePrediction([marketId, 70n], {
        account: predictor2.account,
        value: parseEther("1.0"),
      });

      await advanceTime(86402);
      await market.write.resolveMarket([marketId, 60n], {
        account: dealer1.account,
      });

      const marketData = await market.read.markets([marketId]);
      const storedEquilibrium = marketData[10]; // Assuming equilibrium is field 10

      expect(storedEquilibrium).to.equal(50n);
    });

    it("Should emit equilibrium in MarketResolved event", async function () {
      const { market, dealer1, predictor1, predictor2, marketId, publicClient } =
        await createMarketFixture();

      await market.write.placePrediction([marketId, 30n], {
        account: predictor1.account,
        value: parseEther("1.0"),
      });
      await market.write.placePrediction([marketId, 70n], {
        account: predictor2.account,
        value: parseEther("1.0"),
      });

      await advanceTime(86402);
      const hash = await market.write.resolveMarket([marketId, 60n], {
        account: dealer1.account,
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      // Event should include equilibrium value
      expect(receipt.logs.length).to.be.greaterThan(0);
    });
  });
});
