import { expect } from "chai";
import hre from "hardhat";
import { parseEther, encodeFunctionData, parseAbi, keccak256, toHex } from "viem";

const { viem, network } = hre;

// Helper to advance time
async function advanceTime(seconds: number) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

describe("Oracle Integration", function () {
  async function deployFixture() {
    const [owner, dealer1, updater1, predictor1, predictor2] =
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
    const oracleResolver = await viem.getContractAt(
      "OracleResolver",
      oracleProxy.address
    );

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
      updater1,
      predictor1,
      predictor2,
      publicClient,
    };
  }

  describe("OracleResolver Contract", function () {
    it("Should register a new oracle", async function () {
      const { oracleResolver } = await deployFixture();

      const oracleId = keccak256(toHex("BTCUSD"));
      await oracleResolver.write.registerOracle([
        oracleId,
        2n, // CustomData
        "0x0000000000000000000000000000000000000000",
        20000n, // min: $20k
        100000n, // max: $100k
        3600n, // 1 hour stale period
      ]);

      const config = await oracleResolver.read.oracles([oracleId]);
      expect(config[0]).to.equal(2); // OracleType.CustomData
      expect(config[5]).to.be.true; // isActive
    });

    it("Should authorize updaters", async function () {
      const { oracleResolver, updater1 } = await deployFixture();

      await oracleResolver.write.setAuthorizedUpdater([
        updater1.account.address,
        true,
      ]);

      const isAuthorized = await oracleResolver.read.authorizedUpdaters([
        updater1.account.address,
      ]);
      expect(isAuthorized).to.be.true;
    });

    it("Should update oracle data", async function () {
      const { oracleResolver, updater1 } = await deployFixture();

      const oracleId = keccak256(toHex("BTCUSD"));
      await oracleResolver.write.registerOracle([
        oracleId,
        2n, // CustomData
        "0x0000000000000000000000000000000000000000",
        20000n,
        100000n,
        3600n,
      ]);

      await oracleResolver.write.setAuthorizedUpdater([
        updater1.account.address,
        true,
      ]);

      // Update with value of 60k (should normalize to 50%)
      await oracleResolver.write.updateOracleData([oracleId, 60000n], {
        account: updater1.account,
      });

      const data = await oracleResolver.read.latestData([oracleId]);
      expect(data[0]).to.equal(60000n); // raw value
      expect(data[1]).to.equal(50n); // normalized percentage
    });

    it("Should normalize oracle data to 0-100 range", async function () {
      const { oracleResolver } = await deployFixture();

      const oracleId = keccak256(toHex("TEMP"));
      await oracleResolver.write.registerOracle([
        oracleId,
        2n,
        "0x0000000000000000000000000000000000000000",
        0n, // min: 0°C
        100n, // max: 100°C
        3600n,
      ]);

      // Test exact min
      await oracleResolver.write.updateOracleData([oracleId, 0n]);
      let data = await oracleResolver.read.latestData([oracleId]);
      expect(data[1]).to.equal(0n); // 0%

      // Test exact max
      await oracleResolver.write.updateOracleData([oracleId, 100n]);
      data = await oracleResolver.read.latestData([oracleId]);
      expect(data[1]).to.equal(100n); // 100%

      // Test mid-range
      await oracleResolver.write.updateOracleData([oracleId, 50n]);
      data = await oracleResolver.read.latestData([oracleId]);
      expect(data[1]).to.equal(50n); // 50%
    });

    it("Should detect stale oracle data", async function () {
      const { oracleResolver } = await deployFixture();

      const oracleId = keccak256(toHex("WEATHER"));
      await oracleResolver.write.registerOracle([
        oracleId,
        2n,
        "0x0000000000000000000000000000000000000000",
        0n,
        100n,
        60n, // 60 second stale period
      ]);

      // Update data
      await oracleResolver.write.updateOracleData([oracleId, 50n]);

      // Data should be valid immediately
      let [percentage, timestamp, isValid] = await oracleResolver.read.getOracleData([
        oracleId,
      ]);
      expect(isValid).to.be.true;

      // Advance time past stale period
      await advanceTime(61);

      // Data should now be stale
      [percentage, timestamp, isValid] = await oracleResolver.read.getOracleData([
        oracleId,
      ]);
      expect(isValid).to.be.false;
    });
  });

  describe("Oracle-Based Market Resolution", function () {
    it("Should create market with oracle configuration", async function () {
      const { market, dealer1, oracleResolver, publicClient } =
        await deployFixture();

      const oracleId = keccak256(toHex("BTCUSD"));
      await oracleResolver.write.registerOracle([
        oracleId,
        2n,
        "0x0000000000000000000000000000000000000000",
        20000n,
        100000n,
        3600n,
      ]);

      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;

      await market.write.createMarket(
        [1n, 1n, 1n, deadline, "BTC Price Market", oracleId],
        { account: dealer1.account }
      );

      const marketData = await market.read.markets([1n]);
      expect(marketData[11]).to.equal(oracleId); // oracleId field
    });

    it("Should resolve market using oracle data", async function () {
      const { market, dealer1, oracleResolver, predictor1, predictor2, publicClient } =
        await deployFixture();

      // Register oracle with long stale period
      const oracleId = keccak256(toHex("BTCUSD"));
      await oracleResolver.write.registerOracle([
        oracleId,
        2n,
        "0x0000000000000000000000000000000000000000",
        20000n,
        100000n,
        172800n, // 48 hours stale period
      ]);

      // Create market
      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;
      await market.write.createMarket(
        [1n, 1n, 1n, deadline, "BTC Price Market", oracleId],
        { account: dealer1.account }
      );

      // Place predictions
      await market.write.placePrediction([1n, 30n], {
        account: predictor1.account,
        value: parseEther("1.0"),
      });
      await market.write.placePrediction([1n, 70n], {
        account: predictor2.account,
        value: parseEther("1.0"),
      });

      // Update oracle with BTC price of $60k (normalizes to 50%)
      await oracleResolver.write.updateOracleData([oracleId, 60000n]);

      // Advance time past deadline
      await advanceTime(86402);

      // Resolve market with oracle
      await market.write.resolveMarketWithOracle([1n]);

      const marketData = await market.read.markets([1n]);
      expect(marketData[8]).to.equal(2); // MarketStatus.Resolved
      expect(marketData[9]).to.equal(50n); // resolution percentage
    });

    it("Should reject oracle resolution if no oracle configured", async function () {
      const { market, dealer1, predictor1, publicClient } = await deployFixture();

      // Create market without oracle
      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;
      await market.write.createMarket(
        [
          1n,
          1n,
          1n,
          deadline,
          "Manual Market",
          "0x0000000000000000000000000000000000000000000000000000000000000000",
        ],
        { account: dealer1.account }
      );

      // Place prediction
      await market.write.placePrediction([1n, 50n], {
        account: predictor1.account,
        value: parseEther("1.0"),
      });

      // Advance time
      await advanceTime(86402);

      // Try to resolve with oracle
      try {
        await market.write.resolveMarketWithOracle([1n]);
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("No oracle configured");
      }
    });

    it("Should reject oracle resolution with stale data", async function () {
      const { market, dealer1, oracleResolver, predictor1, publicClient } =
        await deployFixture();

      // Register oracle with short stale period
      const oracleId = keccak256(toHex("WEATHER"));
      await oracleResolver.write.registerOracle([
        oracleId,
        2n,
        "0x0000000000000000000000000000000000000000",
        0n,
        100n,
        60n, // 60 second stale period
      ]);

      // Create market
      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;
      await market.write.createMarket(
        [1n, 1n, 1n, deadline, "Weather Market", oracleId],
        { account: dealer1.account }
      );

      // Place prediction
      await market.write.placePrediction([1n, 50n], {
        account: predictor1.account,
        value: parseEther("1.0"),
      });

      // Update oracle
      await oracleResolver.write.updateOracleData([oracleId, 50n]);

      // Advance time past deadline AND stale period
      await advanceTime(86500);

      // Try to resolve - should fail because data is stale
      try {
        await market.write.resolveMarketWithOracle([1n]);
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("Oracle data stale");
      }
    });

    it("Should allow anyone to resolve market with oracle after deadline", async function () {
      const { market, dealer1, oracleResolver, predictor1, predictor2, publicClient } =
        await deployFixture();

      // Register oracle with long stale period
      const oracleId = keccak256(toHex("SPORTS"));
      await oracleResolver.write.registerOracle([
        oracleId,
        2n,
        "0x0000000000000000000000000000000000000000",
        0n,
        100n,
        172800n, // 48 hours stale period
      ]);

      // Create market
      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;
      await market.write.createMarket(
        [1n, 1n, 1n, deadline, "Sports Market", oracleId],
        { account: dealer1.account }
      );

      // Place predictions
      await market.write.placePrediction([1n, 40n], {
        account: predictor1.account,
        value: parseEther("1.0"),
      });

      // Update oracle
      await oracleResolver.write.updateOracleData([oracleId, 75n]);

      // Advance time
      await advanceTime(86402);

      // predictor2 (not dealer) can resolve with oracle
      await market.write.resolveMarketWithOracle([1n], {
        account: predictor2.account,
      });

      const marketData = await market.read.markets([1n]);
      expect(marketData[8]).to.equal(2); // MarketStatus.Resolved
    });

    it("Should still allow manual resolution for oracle markets", async function () {
      const { market, dealer1, oracleResolver, predictor1, publicClient } =
        await deployFixture();

      // Register oracle with long stale period
      const oracleId = keccak256(toHex("MANUAL"));
      await oracleResolver.write.registerOracle([
        oracleId,
        2n,
        "0x0000000000000000000000000000000000000000",
        0n,
        100n,
        172800n, // 48 hours stale period
      ]);

      // Create market with oracle
      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;
      await market.write.createMarket(
        [1n, 1n, 1n, deadline, "Hybrid Market", oracleId],
        { account: dealer1.account }
      );

      // Place prediction
      await market.write.placePrediction([1n, 50n], {
        account: predictor1.account,
        value: parseEther("1.0"),
      });

      // Advance time
      await advanceTime(86402);

      // Dealer can still manually resolve
      await market.write.resolveMarket([1n, 60n], { account: dealer1.account });

      const marketData = await market.read.markets([1n]);
      expect(marketData[8]).to.equal(2); // MarketStatus.Resolved
      expect(marketData[9]).to.equal(60n); // manual resolution
    });
  });

  describe("Oracle Data Edge Cases", function () {
    it("Should clamp values below minimum to 0%", async function () {
      const { oracleResolver } = await deployFixture();

      const oracleId = keccak256(toHex("CLAMP"));
      await oracleResolver.write.registerOracle([
        oracleId,
        2n,
        "0x0000000000000000000000000000000000000000",
        100n,
        1000n,
        3600n,
      ]);

      // Update with value below minimum
      await oracleResolver.write.updateOracleData([oracleId, 50n]);

      const data = await oracleResolver.read.latestData([oracleId]);
      expect(data[1]).to.equal(0n); // clamped to 0%
    });

    it("Should clamp values above maximum to 100%", async function () {
      const { oracleResolver } = await deployFixture();

      const oracleId = keccak256(toHex("CLAMP2"));
      await oracleResolver.write.registerOracle([
        oracleId,
        2n,
        "0x0000000000000000000000000000000000000000",
        100n,
        1000n,
        3600n,
      ]);

      // Update with value above maximum
      await oracleResolver.write.updateOracleData([oracleId, 2000n]);

      const data = await oracleResolver.read.latestData([oracleId]);
      expect(data[1]).to.equal(100n); // clamped to 100%
    });

    it("Should only allow authorized updaters to update data", async function () {
      const { oracleResolver, updater1, predictor1 } = await deployFixture();

      const oracleId = keccak256(toHex("AUTH"));
      await oracleResolver.write.registerOracle([
        oracleId,
        2n,
        "0x0000000000000000000000000000000000000000",
        0n,
        100n,
        3600n,
      ]);

      // Unauthorized user tries to update
      try {
        await oracleResolver.write.updateOracleData([oracleId, 50n], {
          account: predictor1.account,
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("Not authorized");
      }

      // Authorize updater
      await oracleResolver.write.setAuthorizedUpdater([
        updater1.account.address,
        true,
      ]);

      // Now it should work
      await oracleResolver.write.updateOracleData([oracleId, 50n], {
        account: updater1.account,
      });

      const data = await oracleResolver.read.latestData([oracleId]);
      expect(data[0]).to.equal(50n);
    });
  });
});
