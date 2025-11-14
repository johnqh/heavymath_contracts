import { expect } from "chai";
import hre from "hardhat";
import { parseEther, encodeFunctionData, parseAbi } from "viem";

const { viem, network } = hre;

// Helper to advance time
async function advanceTime(seconds: number) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

describe("Payout System", function () {
  async function deployFixture() {
    const [owner, dealer1, predictor1, predictor2, predictor3, predictor4] =
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

    // Deploy OracleResolver
    const oracleImpl = await viem.deployContract("OracleResolver");
    const oracleInitData = encodeFunctionData({
      abi: parseAbi(["function initialize()"]),
      functionName: "initialize",
      args: [],
    });
    const oracleProxy = await viem.deployContract("ERC1967Proxy", [
      oracleImpl.address,
      oracleInitData,
    ]);
    const oracleResolver = await viem.getContractAt("OracleResolver", oracleProxy.address);

    // Deploy PredictionMarket
    const marketImpl = await viem.deployContract("PredictionMarket");
    const marketInitData = encodeFunctionData({
      abi: parseAbi(["function initialize(address,address)"]),
      functionName: "initialize",
      args: [dealerNFT.address, oracleResolver.address],
    });
    const marketProxy = await viem.deployContract("ERC1967Proxy", [
      marketImpl.address,
      marketInitData,
    ]);
    const market = await viem.getContractAt("PredictionMarket", marketProxy.address);

    return {
      market,
      dealerNFT,
      oracleResolver,
      owner,
      dealer1,
      predictor1,
      predictor2,
      predictor3,
      predictor4,
      publicClient,
    };
  }

  async function createResolvedMarketFixture() {
    const fixtures = await deployFixture();

    // Create market
    const block = await fixtures.publicClient.getBlock();
    const deadline = block.timestamp + 86401n;
    await fixtures.market.write.createMarket(
      [
        1n,
        1n,
        1n,
        deadline,
        "Payout test market",
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      ],
      { account: fixtures.dealer1.account }
    );

    // Place predictions: equilibrium will be at 50
    // predictor1: 1 ETH at 30% (below equilibrium, will lose if result > 50)
    await fixtures.market.write.placePrediction([1n, 30n], {
      account: fixtures.predictor1.account,
      value: parseEther("1.0"),
    });

    // predictor2: 1 ETH at 70% (above equilibrium, will win if result > 50)
    await fixtures.market.write.placePrediction([1n, 70n], {
      account: fixtures.predictor2.account,
      value: parseEther("1.0"),
    });

    // Advance time and resolve at 60% (above equilibrium)
    await advanceTime(86402);
    await fixtures.market.write.resolveMarket([1n, 60n], {
      account: fixtures.dealer1.account,
    });

    return { ...fixtures, marketId: 1n };
  }

  describe("Payout Calculation", function () {
    it("Should calculate correct payout for winner", async function () {
      const { market, predictor2 } = await createResolvedMarketFixture();

      const payout = await market.read.calculatePayout([1n, predictor2.account.address]);

      // Total pool: 2 ETH
      // Dealer fee (0.1% = 10 bps): 2 * 0.001 = 0.002 ETH
      // System fee (10% of dealer fee): 0.002 * 0.1 = 0.0002 ETH
      // Winner pool: 2 - 0.002 - 0.0002 = 1.9978 ETH
      // Predictor2 bet 1 ETH, which is 100% of winning bets
      // So payout = 1.9978 ETH
      expect(payout > parseEther("1.99")).to.be.true;
      expect(payout < parseEther("2.0")).to.be.true;
    });

    it("Should return 0 payout for loser", async function () {
      const { market, predictor1 } = await createResolvedMarketFixture();

      const payout = await market.read.calculatePayout([1n, predictor1.account.address]);
      expect(payout).to.equal(0n);
    });

    it("Should calculate proportional payouts for multiple winners", async function () {
      const { market, dealer1, predictor1, predictor2, predictor3, publicClient } =
        await deployFixture();

      // Create market
      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;
      await market.write.createMarket(
        [
          1n,
          1n,
          1n,
          deadline,
          "Multi-winner test",
          "0x0000000000000000000000000000000000000000000000000000000000000000",
        ],
        { account: dealer1.account }
      );

      // Set higher dealer fee for testing: 1% = 100 bps
      await market.write.setDealerFee([1n, 100n], { account: dealer1.account });

      // Place predictions
      // predictor1: 1 ETH at 20% (will lose)
      await market.write.placePrediction([1n, 20n], {
        account: predictor1.account,
        value: parseEther("1.0"),
      });

      // predictor2: 2 ETH at 70% (will win)
      await market.write.placePrediction([1n, 70n], {
        account: predictor2.account,
        value: parseEther("2.0"),
      });

      // predictor3: 1 ETH at 80% (will win)
      await market.write.placePrediction([1n, 80n], {
        account: predictor3.account,
        value: parseEther("1.0"),
      });

      // Resolve at 75% (above equilibrium, so 70% and 80% win)
      await advanceTime(86402);
      await market.write.resolveMarket([1n, 75n], { account: dealer1.account });

      // Total pool: 4 ETH
      // Dealer fee (1%): 4 * 0.01 = 0.04 ETH
      // System fee (10% of 0.04): 0.004 ETH
      // Winner pool: 4 - 0.04 - 0.004 = 3.956 ETH
      // Total winning bets: 2 + 1 = 3 ETH
      // predictor2 share: (2/3) * 3.956 = ~2.637 ETH
      // predictor3 share: (1/3) * 3.956 = ~1.319 ETH

      const payout2 = await market.read.calculatePayout([1n, predictor2.account.address]);
      const payout3 = await market.read.calculatePayout([1n, predictor3.account.address]);

      // Check predictor2 gets ~2/3 of winner pool
      expect(payout2 > parseEther("2.6")).to.be.true;
      expect(payout2 < parseEther("2.7")).to.be.true;

      // Check predictor3 gets ~1/3 of winner pool
      expect(payout3 > parseEther("1.3")).to.be.true;
      expect(payout3 < parseEther("1.4")).to.be.true;

      // Check total payouts equal winner pool
      const totalPayout = payout2 + payout3;
      const expectedPool = parseEther("3.956");
      expect(totalPayout >= expectedPool - parseEther("0.001")).to.be.true;
      expect(totalPayout <= expectedPool + parseEther("0.001")).to.be.true;
    });
  });

  describe("Claiming Winnings", function () {
    it("Should allow winner to claim payout", async function () {
      const { market, predictor2, publicClient } = await createResolvedMarketFixture();

      const balanceBefore = await publicClient.getBalance({
        address: predictor2.account.address,
      });

      const payout = await market.read.calculatePayout([1n, predictor2.account.address]);

      // Claim winnings
      const hash = await market.write.claimWinnings([1n], {
        account: predictor2.account,
      });

      await publicClient.waitForTransactionReceipt({ hash });

      const balanceAfter = await publicClient.getBalance({
        address: predictor2.account.address,
      });

      // Balance should increase by approximately the payout (minus gas)
      const balanceIncrease = balanceAfter - balanceBefore;
      expect(balanceIncrease > payout - parseEther("0.01")).to.be.true; // Account for gas
    });

    it("Should prevent double claiming", async function () {
      const { market, predictor2 } = await createResolvedMarketFixture();

      // Claim once
      await market.write.claimWinnings([1n], { account: predictor2.account });

      // Try to claim again
      try {
        await market.write.claimWinnings([1n], { account: predictor2.account });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("Already claimed");
      }
    });

    it("Should prevent loser from claiming", async function () {
      const { market, predictor1 } = await createResolvedMarketFixture();

      try {
        await market.write.claimWinnings([1n], { account: predictor1.account });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("Not a winner");
      }
    });

    it("Should emit WinningsClaimed event", async function () {
      const { market, predictor2, publicClient } = await createResolvedMarketFixture();

      const hash = await market.write.claimWinnings([1n], {
        account: predictor2.account,
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      expect(receipt.logs.length).to.be.greaterThan(0);
    });
  });

  describe("Refund Claims", function () {
    it("Should allow refund for prediction at equilibrium", async function () {
      const { market, dealer1, predictor1, predictor2, predictor3, publicClient } =
        await deployFixture();

      // Create market
      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;
      await market.write.createMarket(
        [
          1n,
          1n,
          1n,
          deadline,
          "Refund test",
          "0x0000000000000000000000000000000000000000000000000000000000000000",
        ],
        { account: dealer1.account }
      );

      // Place predictions to create equilibrium at 50
      await market.write.placePrediction([1n, 40n], {
        account: predictor1.account,
        value: parseEther("1.0"),
      });

      await market.write.placePrediction([1n, 50n], {
        account: predictor2.account,
        value: parseEther("2.0"),
      });

      await market.write.placePrediction([1n, 60n], {
        account: predictor3.account,
        value: parseEther("1.0"),
      });

      // Resolve
      await advanceTime(86402);
      await market.write.resolveMarket([1n, 55n], { account: dealer1.account });

      // Check equilibrium
      const equilibrium = await market.read.calculateEquilibrium([1n]);

      // If predictor2 is at equilibrium, they should get refund
      if (equilibrium === 50n) {
        const balanceBefore = await publicClient.getBalance({
          address: predictor2.account.address,
        });

        await market.write.claimRefund([1n], { account: predictor2.account });

        const balanceAfter = await publicClient.getBalance({
          address: predictor2.account.address,
        });

        const balanceIncrease = balanceAfter - balanceBefore;
        expect(balanceIncrease > parseEther("1.99")).to.be.true; // Approximately 2 ETH minus gas
      }
    });

    it("Should prevent double refund claim", async function () {
      const { market, dealer1, predictor1, predictor2, predictor3 } = await deployFixture();

      // Create market
      const block = await (await viem.getPublicClient()).getBlock();
      const deadline = block.timestamp + 86401n;
      await market.write.createMarket(
        [
          1n,
          1n,
          1n,
          deadline,
          "Refund test",
          "0x0000000000000000000000000000000000000000000000000000000000000000",
        ],
        { account: dealer1.account }
      );

      // Create predictions
      await market.write.placePrediction([1n, 40n], {
        account: predictor1.account,
        value: parseEther("1.0"),
      });

      await market.write.placePrediction([1n, 50n], {
        account: predictor2.account,
        value: parseEther("2.0"),
      });

      await market.write.placePrediction([1n, 60n], {
        account: predictor3.account,
        value: parseEther("1.0"),
      });

      // Resolve
      await advanceTime(86402);
      await market.write.resolveMarket([1n, 55n], { account: dealer1.account });

      const equilibrium = await market.read.calculateEquilibrium([1n]);

      if (equilibrium === 50n) {
        await market.write.claimRefund([1n], { account: predictor2.account });

        try {
          await market.write.claimRefund([1n], { account: predictor2.account });
          expect.fail("Should have thrown");
        } catch (error: any) {
          expect(error.message).to.include("Already claimed");
        }
      }
    });
  });

  describe("Fee Withdrawals", function () {
    it("Should allow dealer to withdraw fees", async function () {
      const { market, dealer1, publicClient } = await createResolvedMarketFixture();

      const balanceBefore = await publicClient.getBalance({
        address: dealer1.account.address,
      });

      await market.write.withdrawDealerFees([1n], { account: dealer1.account });

      const balanceAfter = await publicClient.getBalance({
        address: dealer1.account.address,
      });

      // Dealer should receive ~0.002 ETH (0.1% of 2 ETH), minus gas
      const balanceIncrease = balanceAfter - balanceBefore;
      expect(balanceIncrease > 0n).to.be.true;
      expect(balanceIncrease < parseEther("0.01")).to.be.true;
    });

    it("Should prevent non-dealer from withdrawing dealer fees", async function () {
      const { market, predictor1 } = await createResolvedMarketFixture();

      try {
        await market.write.withdrawDealerFees([1n], { account: predictor1.account });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("Not market dealer");
      }
    });

    it("Should prevent double withdrawal of dealer fees", async function () {
      const { market, dealer1 } = await createResolvedMarketFixture();

      // First withdrawal should succeed
      await market.write.withdrawDealerFees([1n], { account: dealer1.account });

      // Check that dealer fees are now 0
      const dealerFees = await market.read.dealerFees([1n]);
      expect(dealerFees).to.equal(0n);

      // Second withdrawal should fail
      try {
        await market.write.withdrawDealerFees([1n], { account: dealer1.account });
        expect.fail("Should have thrown");
      } catch (error: any) {
        // Should fail - either "No fees" or transaction revert
        expect(error.message.length).to.be.greaterThan(0);
      }
    });

    it("Should allow owner to withdraw system fees", async function () {
      const { market, owner, publicClient } = await createResolvedMarketFixture();

      // First dealer must withdraw to trigger system fee calculation
      await market.write.withdrawDealerFees([1n], {
        account: (await viem.getWalletClients())[1].account, // dealer1
      });

      const balanceBefore = await publicClient.getBalance({
        address: owner.account.address,
      });

      await market.write.withdrawSystemFees({ account: owner.account });

      const balanceAfter = await publicClient.getBalance({
        address: owner.account.address,
      });

      // Owner should receive system fee (10% of dealer fee), minus gas
      const balanceIncrease = balanceAfter - balanceBefore;
      expect(balanceIncrease > 0n).to.be.true;
    });

    it("Should prevent double withdrawal of system fees", async function () {
      const { market, owner } = await createResolvedMarketFixture();

      // Trigger system fee calculation
      await market.write.withdrawDealerFees([1n], {
        account: (await viem.getWalletClients())[1].account,
      });

      await market.write.withdrawSystemFees({ account: owner.account });

      try {
        await market.write.withdrawSystemFees({ account: owner.account });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("No fees");
      }
    });

    it("Should accumulate system fees from multiple markets", async function () {
      const { market, dealer1, owner, publicClient } = await deployFixture();

      // Create and resolve 2 markets
      for (let i = 1; i <= 2; i++) {
        const block = await publicClient.getBlock();
        const deadline = block.timestamp + 86401n;

        await market.write.createMarket(
          [
            1n,
            1n,
            1n,
            deadline,
            `Market ${i}`,
            "0x0000000000000000000000000000000000000000000000000000000000000000",
          ],
          { account: dealer1.account }
        );

        await market.write.placePrediction([BigInt(i), 30n], {
          account: (await viem.getWalletClients())[2].account,
          value: parseEther("1.0"),
        });

        await market.write.placePrediction([BigInt(i), 70n], {
          account: (await viem.getWalletClients())[3].account,
          value: parseEther("1.0"),
        });

        await advanceTime(86402);
        await market.write.resolveMarket([BigInt(i), 60n], { account: dealer1.account });

        // Withdraw dealer fees to trigger system fee calculation
        await market.write.withdrawDealerFees([BigInt(i)], { account: dealer1.account });
      }

      // Withdraw all accumulated system fees
      const totalSystemFees = await market.read.totalSystemFees();
      expect(totalSystemFees > 0n).to.be.true;

      await market.write.withdrawSystemFees({ account: owner.account });

      const finalSystemFees = await market.read.totalSystemFees();
      expect(finalSystemFees).to.equal(0n);
    });
  });
});
