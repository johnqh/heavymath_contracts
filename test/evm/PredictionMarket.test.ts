import { expect } from "chai";
import hre from "hardhat";
import { getAddress, parseEther, encodeFunctionData, parseAbi } from "viem";

const { viem, network } = hre;

// Helper to advance time
async function advanceTime(seconds: number) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

describe("PredictionMarket", function () {
  async function deployFixture() {
    const [owner, dealer1, dealer2, predictor1, predictor2, predictor3] =
      await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();

    // Deploy DealerNFT first
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
    const dealerNFT = await viem.getContractAt(
      "DealerNFT",
      dealerNFTProxy.address
    );

    // Mint licenses to dealers
    await dealerNFT.write.mint([dealer1.account.address, 1n]);
    await dealerNFT.write.mint([dealer2.account.address, 2n]);

    // Set permissions for dealer1: category 1, all subcategories
    await dealerNFT.write.setPermissions([1n, 1n, [0xFFn]]);
    // Set permissions for dealer2: category 1, specific subcategories
    await dealerNFT.write.setPermissions([2n, 1n, [1n, 2n]]);

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
    const market = await viem.getContractAt(
      "PredictionMarket",
      marketProxy.address
    );

    // Get current block timestamp for creating deadlines
    const block = await publicClient.getBlock();
    const now = block.timestamp;

    return {
      market,
      marketImpl,
      marketProxy,
      dealerNFT,
      owner,
      dealer1,
      dealer2,
      predictor1,
      predictor2,
      predictor3,
      publicClient,
      now,
    };
  }

  describe("Deployment & Initialization", function () {
    it("Should initialize with correct owner", async function () {
      const { market, owner } = await deployFixture();
      const contractOwner = await market.read.owner();
      expect(contractOwner.toLowerCase()).to.equal(
        owner.account.address.toLowerCase()
      );
    });

    it("Should prevent re-initialization", async function () {
      const { market, dealerNFT } = await deployFixture();
      try {
        await market.write.initialize([dealerNFT.address]);
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("InvalidInitialization");
      }
    });

    it("Should store correct DealerNFT address", async function () {
      const { market, dealerNFT } = await deployFixture();
      const storedAddress = await market.read.dealerNFT();
      expect(storedAddress.toLowerCase()).to.equal(
        dealerNFT.address.toLowerCase()
      );
    });

    it("Should have initial market counter at 0", async function () {
      const { market } = await deployFixture();
      const counter = await market.read.marketCounter();
      expect(counter).to.equal(0n);
    });
  });

  describe("Market Creation", function () {
    it("Should create market with valid dealer license", async function () {
      const { market, dealer1, publicClient } = await deployFixture();
      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n; // 24 hours

      await market.write.createMarket(
        [
          1n, // tokenId
          1n, // category
          1n, // subCategory
          deadline,
          "Will it rain tomorrow?",
        ],
        { account: dealer1.account }
      );

      const counter = await market.read.marketCounter();
      expect(counter).to.equal(1n);
    });

    it("Should enforce minimum 24 hour duration", async function () {
      const { market, dealer1, publicClient } = await deployFixture();
      const block = await publicClient.getBlock();
      const tooSoonDeadline = block.timestamp + 3600n; // 1 hour

      try {
        await market.write.createMarket(
          [1n, 1n, 1n, tooSoonDeadline, "Will it rain?"],
          { account: dealer1.account }
        );
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("Deadline too soon");
      }
    });

    it("Should validate dealer permissions for category/subCategory", async function () {
      const { market, dealer2, publicClient } = await deployFixture();
      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;

      // dealer2 has permissions for category 1, subcategories [1, 2] only
      await market.write.createMarket(
        [2n, 1n, 1n, deadline, "Valid market"],
        { account: dealer2.account }
      );

      // Should fail for subcategory 3
      try {
        await market.write.createMarket(
          [2n, 1n, 3n, deadline, "Invalid subcategory"],
          { account: dealer2.account }
        );
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("No permission");
      }
    });

    it("Should require caller to own the dealer NFT", async function () {
      const { market, dealer2, publicClient } = await deployFixture();
      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;

      // dealer2 doesn't own tokenId 1
      try {
        await market.write.createMarket(
          [1n, 1n, 1n, deadline, "Not my token"],
          { account: dealer2.account }
        );
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("Not token owner");
      }
    });

    it("Should emit MarketCreated event", async function () {
      const { market, dealer1, publicClient } = await deployFixture();
      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;

      const hash = await market.write.createMarket(
        [1n, 1n, 1n, deadline, "Event test"],
        { account: dealer1.account }
      );

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      expect(receipt.logs.length).to.be.greaterThan(0);
    });

    it("Should set dealer fee within bounds (0.1% - 2%)", async function () {
      const { market, dealer1, publicClient } = await deployFixture();
      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;

      // Create market
      await market.write.createMarket(
        [1n, 1n, 1n, deadline, "Fee test"],
        { account: dealer1.account }
      );

      // Set fee to 1% (100 basis points)
      await market.write.setDealerFee([1n, 100n], { account: dealer1.account });

      const marketData = await market.read.markets([1n]);
      expect(marketData[7]).to.equal(100n); // dealerFeeBps field
    });

    it("Should reject dealer fee outside bounds", async function () {
      const { market, dealer1, publicClient } = await deployFixture();
      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;

      await market.write.createMarket(
        [1n, 1n, 1n, deadline, "Fee bounds test"],
        { account: dealer1.account }
      );

      // Too low (< 0.1% = 10 bps)
      try {
        await market.write.setDealerFee([1n, 5n], { account: dealer1.account });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("Fee out of bounds");
      }

      // Too high (> 2% = 200 bps)
      try {
        await market.write.setDealerFee([1n, 250n], { account: dealer1.account });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("Fee out of bounds");
      }
    });
  });

  describe("Prediction Management", function () {
    async function createMarketFixture() {
      const fixtures = await deployFixture();

      // Get fresh timestamp
      const block = await fixtures.publicClient.getBlock();
      const deadline = block.timestamp + 86401n;

      await fixtures.market.write.createMarket(
        [1n, 1n, 1n, deadline, "Test market"],
        { account: fixtures.dealer1.account }
      );

      return { ...fixtures, marketId: 1n };
    }

    it("Should place prediction with valid percentage (0-100)", async function () {
      const { market, predictor1, marketId } = await createMarketFixture();

      await market.write.placePrediction([marketId, 50n], {
        account: predictor1.account,
        value: parseEther("1.0"),
      });

      const prediction = await market.read.predictions([marketId, predictor1.account.address]);
      expect(prediction[0]).to.equal(parseEther("1.0")); // amount
      expect(prediction[1]).to.equal(50n); // percentage
    });

    it("Should reject percentage outside 0-100 range", async function () {
      const { market, predictor1, marketId } = await createMarketFixture();

      try {
        await market.write.placePrediction([marketId, 101n], {
          account: predictor1.account,
          value: parseEther("1.0"),
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("Invalid percentage");
      }
    });

    it("Should enforce minimum bet amount", async function () {
      const { market, predictor1, marketId } = await createMarketFixture();

      try {
        await market.write.placePrediction([marketId, 50n], {
          account: predictor1.account,
          value: parseEther("0.0001"), // Too small
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("Below minimum");
      }
    });

    it("Should allow only one prediction per predictor per market", async function () {
      const { market, predictor1, marketId } = await createMarketFixture();

      // First prediction
      await market.write.placePrediction([marketId, 50n], {
        account: predictor1.account,
        value: parseEther("1.0"),
      });

      // Second prediction should fail
      try {
        await market.write.placePrediction([marketId, 60n], {
          account: predictor1.account,
          value: parseEther("0.5"),
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("Already predicted");
      }
    });

    it("Should allow updating prediction within grace period", async function () {
      const { market, predictor1, marketId } = await createMarketFixture();

      // Place initial prediction
      await market.write.placePrediction([marketId, 50n], {
        account: predictor1.account,
        value: parseEther("1.0"),
      });

      // Update within grace period (5 minutes)
      await market.write.updatePrediction([marketId, 60n, parseEther("0.5")], {
        account: predictor1.account,
        value: parseEther("0.5"),
      });

      const prediction = await market.read.predictions([marketId, predictor1.account.address]);
      expect(prediction[0]).to.equal(parseEther("1.5")); // total amount
      expect(prediction[1]).to.equal(60n); // updated percentage
    });

    it("Should prevent updating after grace period", async function () {
      const { market, predictor1, marketId } = await createMarketFixture();

      await market.write.placePrediction([marketId, 50n], {
        account: predictor1.account,
        value: parseEther("1.0"),
      });

      // Advance time past grace period (5 minutes = 300 seconds)
      await advanceTime(301);

      try {
        await market.write.updatePrediction([marketId, 60n, parseEther("0.5")], {
          account: predictor1.account,
          value: parseEther("0.5"),
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("Grace period expired");
      }
    });

    it("Should prevent predictions after deadline", async function () {
      const { market, predictor1, marketId } = await createMarketFixture();

      // Advance time past deadline (24 hours = 86400 seconds)
      await advanceTime(86401);

      try {
        await market.write.placePrediction([marketId, 50n], {
          account: predictor1.account,
          value: parseEther("1.0"),
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("Market closed");
      }
    });
  });

  describe("Market Resolution", function () {
    async function createMarketWithPredictionsFixture() {
      const fixtures = await deployFixture();

      // Get fresh timestamp after all the deployments
      const block = await fixtures.publicClient.getBlock();
      const deadline = block.timestamp + 86401n;

      await fixtures.market.write.createMarket(
        [1n, 1n, 1n, deadline, "Resolution test"],
        { account: fixtures.dealer1.account }
      );

      // Place predictions
      await fixtures.market.write.placePrediction([1n, 30n], {
        account: fixtures.predictor1.account,
        value: parseEther("1.0"),
      });

      await fixtures.market.write.placePrediction([1n, 70n], {
        account: fixtures.predictor2.account,
        value: parseEther("2.0"),
      });

      return { ...fixtures, marketId: 1n };
    }

    it("Should only allow dealer to resolve market", async function () {
      const { market, dealer1, predictor1, marketId } =
        await createMarketWithPredictionsFixture();

      // Advance past deadline
      await advanceTime(86401);

      // Non-dealer should fail
      try {
        await market.write.resolveMarket([marketId, 50n], {
          account: predictor1.account,
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("Not market dealer");
      }

      // Dealer should succeed
      await market.write.resolveMarket([marketId, 50n], {
        account: dealer1.account,
      });

      const marketData = await market.read.markets([marketId]);
      expect(marketData[8]).to.equal(2); // MarketStatus.Resolved
    });

    it("Should prevent resolution before deadline", async function () {
      const { market, dealer1, marketId } =
        await createMarketWithPredictionsFixture();

      try {
        await market.write.resolveMarket([marketId, 50n], {
          account: dealer1.account,
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("Market still active");
      }
    });

    it("Should emit MarketResolved event", async function () {
      const { market, dealer1, marketId, publicClient } =
        await createMarketWithPredictionsFixture();

      await advanceTime(86401);

      const hash = await market.write.resolveMarket([marketId, 50n], {
        account: dealer1.account,
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      expect(receipt.logs.length).to.be.greaterThan(0);
    });
  });

  describe("Upgrade", function () {
    it("Should only allow owner to upgrade", async function () {
      const { market, dealer1 } = await deployFixture();

      const newImpl = await viem.deployContract("PredictionMarket");

      try {
        await market.write.upgradeToAndCall([newImpl.address, "0x"], {
          account: dealer1.account,
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("OwnableUnauthorizedAccount");
      }
    });

    it("Should preserve state after upgrade", async function () {
      const { market, dealer1, dealerNFT, publicClient } = await deployFixture();

      // Get fresh timestamp
      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;

      // Create market before upgrade
      await market.write.createMarket(
        [1n, 1n, 1n, deadline, "Upgrade test"],
        { account: dealer1.account }
      );

      const counterBefore = await market.read.marketCounter();

      // Upgrade
      const newImpl = await viem.deployContract("PredictionMarket");
      await market.write.upgradeToAndCall([newImpl.address, "0x"]);

      // Verify state preserved
      const counterAfter = await market.read.marketCounter();
      expect(counterAfter).to.equal(counterBefore);

      const storedDealerNFT = await market.read.dealerNFT();
      expect(storedDealerNFT.toLowerCase()).to.equal(
        dealerNFT.address.toLowerCase()
      );
    });
  });

  describe("Access Control", function () {
    it("Should only allow owner to pause", async function () {
      const { market, dealer1 } = await deployFixture();

      try {
        await market.write.pause({ account: dealer1.account });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("OwnableUnauthorizedAccount");
      }

      // Owner can pause
      await market.write.pause();
      const paused = await market.read.paused();
      expect(paused).to.be.true;
    });

    it("Should prevent operations when paused", async function () {
      const { market, dealer1, publicClient } = await deployFixture();

      await market.write.pause();

      // Get fresh timestamp
      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;

      try {
        await market.write.createMarket(
          [1n, 1n, 1n, deadline, "Paused test"],
          { account: dealer1.account }
        );
        expect.fail("Should have thrown");
      } catch (error: any) {
        // Check for pause-related error (could be "paused" or "EnforcedPause")
        expect(error.message.toLowerCase()).to.match(/pause/);
      }
    });
  });
});
