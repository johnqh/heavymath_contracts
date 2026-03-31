import { expect } from "chai";
import {
  advanceTime,
  deployPredictionFixture,
  toUSDC,
} from "./utils/fixture.ts";

const ZERO_ORACLE_ID =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

describe("Equilibrium algorithm (USDC)", function () {
  async function setupMarket() {
    const fixtures = await deployPredictionFixture();
    const block = await fixtures.publicClient.getBlock();
    const deadline = block.timestamp + 86401n;

    await fixtures.market.write.createMarket(
      [1n, 1n, 1n, deadline, "Equilibrium checks", ZERO_ORACLE_ID],
      { account: fixtures.dealer1.account }
    );

    return { ...fixtures, marketId: 1n };
  }

  // ========== GROUP A: Equilibrium Calculation ==========

  describe("Equilibrium calculation", function () {
    it("A1: finds 50% equilibrium for symmetric bets", async function () {
      const { market, dealer1, predictor1, predictor2, marketId } =
        await setupMarket();

      await market.write.placePrediction([marketId, 40n, toUSDC("150")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 60n, toUSDC("150")], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      const eq = await market.read.calculateEquilibrium([marketId]);
      expect(eq).to.equal(50n);

      await market.write.lockMarket([marketId]);
      await market.write.resolveMarket([marketId, true], {
        account: dealer1.account,
      });

      const [, , , , , , , , , , equilibrium] = await market.read.markets([
        marketId,
      ]);
      expect(equilibrium).to.equal(50n);
    });

    it("A2: finds asymmetric equilibrium for uneven amounts", async function () {
      // bet(20, $300) + bet(80, $100)
      // For p=75: below=300, above=100. 300*25=7500 vs 100*75=7500. Diff=0.
      const { market, predictor1, predictor2, marketId } =
        await setupMarket();

      await market.write.placePrediction([marketId, 20n, toUSDC("300")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 80n, toUSDC("100")], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      const eq = await market.read.calculateEquilibrium([marketId]);
      expect(eq).to.equal(75n);

      await market.write.lockMarket([marketId]);

      const [, , , , , , , , , , equilibrium] = await market.read.markets([marketId]);
      expect(equilibrium).to.equal(75n);
    });

    it("A3: handles multiple bettors per side", async function () {
      // bet(20,$100) + bet(30,$200) + bet(70,$150)
      // For p=22: below=100 (at 20), above=350 (at 30+70). |100*78-350*22|=|7800-7700|=100
      // This beats all other candidates including p=67 (diff=150) and p=1 (diff=450)
      const { market, predictor1, predictor2, predictor3, marketId } =
        await setupMarket();

      await market.write.placePrediction([marketId, 20n, toUSDC("100")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 30n, toUSDC("200")], {
        account: predictor2.account,
      });
      await market.write.placePrediction([marketId, 70n, toUSDC("150")], {
        account: predictor3.account,
      });

      await advanceTime(86401);

      const eq = await market.read.calculateEquilibrium([marketId]);
      expect(eq).to.equal(22n);
    });

    it("A4: adjacent bets at 49 and 51 give equilibrium 50", async function () {
      const { market, predictor1, predictor2, marketId } = await setupMarket();

      await market.write.placePrediction([marketId, 49n, toUSDC("100")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 51n, toUSDC("100")], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      const eq = await market.read.calculateEquilibrium([marketId]);
      expect(eq).to.equal(50n);
    });

    it("A5: bets at 0% and 100% give equilibrium 50", async function () {
      const { market, predictor1, predictor2, marketId } = await setupMarket();

      await market.write.placePrediction([marketId, 0n, toUSDC("200")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 100n, toUSDC("200")], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      const eq = await market.read.calculateEquilibrium([marketId]);
      expect(eq).to.equal(50n);
    });

    it("A6: calculateEquilibrium view matches lockMarket result", async function () {
      const { market, predictor1, predictor2, marketId } =
        await setupMarket();

      // bet(20, $200) + bet(80, $100) → equilibrium at 67
      // For p=67: below=200, above=100. |200*33 - 100*67| = |6600-6700| = 100 (minimum)
      await market.write.placePrediction([marketId, 20n, toUSDC("200")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 80n, toUSDC("100")], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      const eqView = await market.read.calculateEquilibrium([marketId]);
      expect(eqView).to.equal(67n);

      await market.write.lockMarket([marketId]);

      const [, , , , , , , , , , storedEq] = await market.read.markets([marketId]);
      expect(storedEq).to.equal(eqView);
    });
  });

  // ========== GROUP B: Lock Refund Mechanism ==========

  describe("Lock refund mechanism", function () {
    it("B1: below side overweight gets partial refund", async function () {
      // bet(20, $300) + bet(80, $100). Force equilibrium=50 via lockMarketWithEquilibrium.
      // below=300, above=100. leftSide=300*50=15000 > rightSide=100*50=5000
      // targetBelow = (100*50)/50 = 100. excess = 300-100 = 200.
      const { market, predictor1, predictor2, marketId } =
        await setupMarket();

      await market.write.placePrediction([marketId, 20n, toUSDC("300")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 80n, toUSDC("100")], {
        account: predictor2.account,
      });

      await advanceTime(86401);
      await market.write.lockMarketWithEquilibrium([marketId, 50n]);

      // predictor1 (below, overweight) should get lock refund of 200
      const refund = await market.read.getLockRefundAmount([
        marketId,
        predictor1.account.address,
      ]);
      expect(refund).to.equal(toUSDC("200"));

      // predictor2 (above, lighter side) gets no lock refund
      const refund2 = await market.read.getLockRefundAmount([
        marketId,
        predictor2.account.address,
      ]);
      expect(refund2).to.equal(0n);
    });

    it("B2: above side overweight gets partial refund", async function () {
      // bet(20, $100) + bet(80, $300). Force equilibrium=50.
      // below=100, above=300. rightSide=300*50=15000 > leftSide=100*50=5000
      // targetAbove = (100*50)/50 = 100. excess = 300-100 = 200.
      const { market, predictor1, predictor2, marketId } = await setupMarket();

      await market.write.placePrediction([marketId, 20n, toUSDC("100")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 80n, toUSDC("300")], {
        account: predictor2.account,
      });

      await advanceTime(86401);
      await market.write.lockMarketWithEquilibrium([marketId, 50n]);

      // predictor2 (above, overweight) should get lock refund of 200
      const refund2 = await market.read.getLockRefundAmount([
        marketId,
        predictor2.account.address,
      ]);
      expect(refund2).to.equal(toUSDC("200"));

      // predictor1 (below, lighter) gets nothing
      const refund1 = await market.read.getLockRefundAmount([
        marketId,
        predictor1.account.address,
      ]);
      expect(refund1).to.equal(0n);
    });

    it("B3: lock refund + winner payout combined", async function () {
      const { market, dealer1, predictor1, predictor2, stakeToken, marketId } =
        await setupMarket();

      // predictor1 (below, overweight): $300 at 20%
      // predictor2 (above, lighter): $100 at 80%
      // Force equilibrium=50 → below overweight, excess=200
      await market.write.placePrediction([marketId, 20n, toUSDC("300")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 80n, toUSDC("100")], {
        account: predictor2.account,
      });

      await advanceTime(86401);
      await market.write.lockMarketWithEquilibrium([marketId, 50n]);

      // Claim lock refund for predictor1 (overweight below side)
      const p1Before = await stakeToken.read.balanceOf([predictor1.account.address]);
      await market.write.claimLockRefund([marketId], { account: predictor1.account });
      const p1AfterRefund = await stakeToken.read.balanceOf([predictor1.account.address]);
      expect(p1AfterRefund - p1Before).to.equal(toUSDC("200"));

      // Resolve below equilibrium: predictor1 wins
      await market.write.resolveMarket([marketId, false], { account: dealer1.account });

      // Pool after lock refund: 400 - 200 = 200. Equilibrium stakes = 0.
      // distributablePool = 200. fee = 200*100/10000 = 2. winnerPool = 198.
      // predictor1 effective = 300 - 200 = 100. Total winning = 100. Payout = 198.
      const p1BeforeWin = await stakeToken.read.balanceOf([predictor1.account.address]);
      await market.write.claimWinnings([marketId], { account: predictor1.account });
      const p1AfterWin = await stakeToken.read.balanceOf([predictor1.account.address]);
      expect(p1AfterWin - p1BeforeWin).to.equal(toUSDC("198"));
    });

    it("B4: multiple bettors on overweight side get pro-rata refund", async function () {
      const { market, predictor1, predictor2, predictor3, marketId } =
        await setupMarket();

      // Two below bettors (overweight): $200 at 20%, $100 at 30%
      // One above bettor: $100 at 70%
      // Force equilibrium=50. below=300, above=100. excess=200.
      // p1 refund = (200*200)/300 = 133.333... → 133 (truncated)
      // p2 refund = (100*200)/300 = 66.666... → 66 (truncated)
      await market.write.placePrediction([marketId, 20n, toUSDC("200")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 30n, toUSDC("100")], {
        account: predictor2.account,
      });
      await market.write.placePrediction([marketId, 70n, toUSDC("100")], {
        account: predictor3.account,
      });

      await advanceTime(86401);
      await market.write.lockMarketWithEquilibrium([marketId, 50n]);

      const refund1 = await market.read.getLockRefundAmount([
        marketId,
        predictor1.account.address,
      ]);
      const refund2 = await market.read.getLockRefundAmount([
        marketId,
        predictor2.account.address,
      ]);
      const refund3 = await market.read.getLockRefundAmount([
        marketId,
        predictor3.account.address,
      ]);

      // Pro-rata: p1 gets 2x what p2 gets (200:100 stake ratio)
      expect(Number(refund1)).to.be.greaterThan(Number(refund2));
      expect(Number(refund1)).to.be.greaterThan(0);
      expect(Number(refund2)).to.be.greaterThan(0);

      // predictor3 (above side, lighter) should get no refund
      expect(refund3).to.equal(0n);
    });

    it("B5: cannot double-claim lock refund", async function () {
      const { market, predictor1, predictor2, marketId } = await setupMarket();

      await market.write.placePrediction([marketId, 20n, toUSDC("300")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 80n, toUSDC("100")], {
        account: predictor2.account,
      });

      await advanceTime(86401);
      await market.write.lockMarketWithEquilibrium([marketId, 50n]);

      // First claim succeeds
      await market.write.claimLockRefund([marketId], { account: predictor1.account });

      // Second claim reverts
      try {
        await market.write.claimLockRefund([marketId], { account: predictor1.account });
        expect.fail("Should have reverted");
      } catch (error: any) {
        expect(error.message).to.include("Already claimed");
      }
    });

    it("B6: no lock refund when sides are perfectly balanced", async function () {
      const { market, predictor1, predictor2, marketId } = await setupMarket();

      // Equal amounts on each side → no excess
      await market.write.placePrediction([marketId, 40n, toUSDC("100")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 60n, toUSDC("100")], {
        account: predictor2.account,
      });

      await advanceTime(86401);
      await market.write.lockMarket([marketId]);

      const refund1 = await market.read.getLockRefundAmount([
        marketId,
        predictor1.account.address,
      ]);
      const refund2 = await market.read.getLockRefundAmount([
        marketId,
        predictor2.account.address,
      ]);
      expect(refund1).to.equal(0n);
      expect(refund2).to.equal(0n);
    });
  });

  // ========== GROUP C: One-Sided Market ==========

  describe("One-sided market detection", function () {
    it("C1: all bets below — lockMarket reverts", async function () {
      const { market, predictor1, predictor2, marketId } = await setupMarket();

      await market.write.placePrediction([marketId, 20n, toUSDC("100")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 30n, toUSDC("100")], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      try {
        await market.write.lockMarket([marketId]);
        expect.fail("Should have reverted");
      } catch (error: any) {
        expect(error.message).to.match(/No valid equilibrium|One-sided market/);
      }
    });

    it("C2: all bets at same percentage — lockMarket reverts", async function () {
      const { market, predictor1, predictor2, marketId } = await setupMarket();

      await market.write.placePrediction([marketId, 50n, toUSDC("100")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 50n, toUSDC("200")], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      try {
        await market.write.lockMarket([marketId]);
        expect.fail("Should have reverted");
      } catch (error: any) {
        expect(error.message).to.match(/No valid equilibrium|One-sided market/);
      }
    });

    it("C3: lockMarketWithEquilibrium on one-sided market reverts", async function () {
      const { market, predictor1, marketId } = await setupMarket();

      await market.write.placePrediction([marketId, 20n, toUSDC("200")], {
        account: predictor1.account,
      });

      await advanceTime(86401);

      try {
        await market.write.lockMarketWithEquilibrium([marketId, 50n]);
        expect.fail("Should have reverted");
      } catch (error: any) {
        expect(error.message).to.include("One-sided market");
      }
    });
  });

  // ========== GROUP D: Resolution Edge Cases ==========

  describe("Resolution edge cases", function () {
    it("D1: negative resolution — below-side wins", async function () {
      const { market, dealer1, predictor1, predictor2, marketId } =
        await setupMarket();

      await market.write.placePrediction([marketId, 40n, toUSDC("100")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 60n, toUSDC("100")], {
        account: predictor2.account,
      });

      await advanceTime(86401);
      await market.write.lockMarket([marketId]);
      await market.write.resolveMarket([marketId, false], { account: dealer1.account });

      const isWinner1 = await market.read.isWinner([marketId, predictor1.account.address]);
      const isWinner2 = await market.read.isWinner([marketId, predictor2.account.address]);
      expect(isWinner1).to.be.true;
      expect(isWinner2).to.be.false;

      const payout1 = await market.read.calculatePayout([marketId, predictor1.account.address]);
      const payout2 = await market.read.calculatePayout([marketId, predictor2.account.address]);
      expect(payout1 > 0n).to.be.true;
      expect(payout2).to.equal(0n);
    });

    it("D2: resolution above equilibrium — above-side wins", async function () {
      const { market, dealer1, predictor1, predictor2, marketId } =
        await setupMarket();

      await market.write.placePrediction([marketId, 40n, toUSDC("100")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 60n, toUSDC("100")], {
        account: predictor2.account,
      });

      await advanceTime(86401);
      await market.write.lockMarket([marketId]);
      await market.write.resolveMarket([marketId, true], { account: dealer1.account });

      const isWinner1 = await market.read.isWinner([marketId, predictor1.account.address]);
      const isWinner2 = await market.read.isWinner([marketId, predictor2.account.address]);
      expect(isWinner1).to.be.false;
      expect(isWinner2).to.be.true;
    });

    it("D3: resolution below equilibrium — below-side wins", async function () {
      const { market, dealer1, predictor1, predictor2, marketId } =
        await setupMarket();

      await market.write.placePrediction([marketId, 40n, toUSDC("100")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 60n, toUSDC("100")], {
        account: predictor2.account,
      });

      await advanceTime(86401);
      await market.write.lockMarket([marketId]);
      await market.write.resolveMarket([marketId, false], { account: dealer1.account });

      const isWinner1 = await market.read.isWinner([marketId, predictor1.account.address]);
      const isWinner2 = await market.read.isWinner([marketId, predictor2.account.address]);
      expect(isWinner1).to.be.true;
      expect(isWinner2).to.be.false;
    });

    it("D4: equilibrium bettor gets full refund regardless of resolution", async function () {
      const { market, dealer1, predictor1, predictor2, predictor3, stakeToken, marketId } =
        await setupMarket();

      await market.write.placePrediction([marketId, 30n, toUSDC("100")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 50n, toUSDC("120")], {
        account: predictor2.account,
      });
      await market.write.placePrediction([marketId, 70n, toUSDC("100")], {
        account: predictor3.account,
      });

      await advanceTime(86401);
      await market.write.lockMarket([marketId]);
      await market.write.resolveMarket([marketId, true], {
        account: dealer1.account,
      });

      // predictor2 at equilibrium (50) gets full refund
      const refund = await market.read.getRefundAmount([
        marketId,
        predictor2.account.address,
      ]);
      expect(refund).to.equal(toUSDC("120"));

      const before = await stakeToken.read.balanceOf([predictor2.account.address]);
      await market.write.claimRefund([marketId], { account: predictor2.account });
      const after = await stakeToken.read.balanceOf([predictor2.account.address]);
      expect(after - before).to.equal(toUSDC("120"));
    });
  });

  // ========== GROUP E: Pre-Computed Equilibrium ==========

  describe("Pre-computed equilibrium", function () {
    it("E1: lockMarketWithEquilibrium matches lockMarket result", async function () {
      const fixtures1 = await deployPredictionFixture();
      const fixtures2 = await deployPredictionFixture();

      const block1 = await fixtures1.publicClient.getBlock();
      const deadline = block1.timestamp + 86401n;

      // Market 1: auto-computed equilibrium
      await fixtures1.market.write.createMarket(
        [1n, 1n, 1n, deadline, "Auto eq", ZERO_ORACLE_ID],
        { account: fixtures1.dealer1.account }
      );
      await fixtures1.market.write.placePrediction([1n, 40n, toUSDC("100")], {
        account: fixtures1.predictor1.account,
      });
      await fixtures1.market.write.placePrediction([1n, 80n, toUSDC("100")], {
        account: fixtures1.predictor2.account,
      });

      // Market 2: pre-computed equilibrium
      const block2 = await fixtures2.publicClient.getBlock();
      const deadline2 = block2.timestamp + 86401n;
      await fixtures2.market.write.createMarket(
        [1n, 1n, 1n, deadline2, "Pre eq", ZERO_ORACLE_ID],
        { account: fixtures2.dealer1.account }
      );
      await fixtures2.market.write.placePrediction([1n, 40n, toUSDC("100")], {
        account: fixtures2.predictor1.account,
      });
      await fixtures2.market.write.placePrediction([1n, 80n, toUSDC("100")], {
        account: fixtures2.predictor2.account,
      });

      await advanceTime(86401);

      await fixtures1.market.write.lockMarket([1n]);
      await fixtures2.market.write.lockMarketWithEquilibrium([1n, 50n]);

      const data1 = await fixtures1.market.read.markets([1n]);
      const data2 = await fixtures2.market.read.markets([1n]);

      expect(data1[10]).to.equal(data2[10]); // Same equilibrium
      expect(data1[8]).to.equal(4); // Locked
      expect(data2[8]).to.equal(4); // Locked
    });

    it("E2: rejects invalid pre-computed equilibrium (0 and 100)", async function () {
      const { market, predictor1, predictor2, marketId } = await setupMarket();

      await market.write.placePrediction([marketId, 30n, toUSDC("100")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 70n, toUSDC("100")], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      try {
        await market.write.lockMarketWithEquilibrium([marketId, 0n]);
        expect.fail("Should revert for 0");
      } catch (error: any) {
        expect(error.message).to.include("Invalid equilibrium");
      }

      try {
        await market.write.lockMarketWithEquilibrium([marketId, 100n]);
        expect.fail("Should revert for 100");
      } catch (error: any) {
        expect(error.message).to.include("Invalid equilibrium");
      }
    });

    it("E3: anyone can call lockMarketWithEquilibrium", async function () {
      const { market, predictor1, predictor2, predictor3, marketId } =
        await setupMarket();

      await market.write.placePrediction([marketId, 30n, toUSDC("100")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 70n, toUSDC("100")], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      // predictor3 (not dealer, not bettor) can lock
      await market.write.lockMarketWithEquilibrium([marketId, 50n], {
        account: predictor3.account,
      });

      const data = await market.read.markets([marketId]);
      expect(data[8]).to.equal(4); // Locked
    });
  });

  // ========== GROUP F: Fairness Verification ==========

  describe("Fairness verification", function () {
    it("F1: winners receive at least expected payout for E=50", async function () {
      const { market, dealer1, predictor1, predictor2, marketId } =
        await setupMarket();

      // Equal bets → E=50, no lock refund
      await market.write.placePrediction([marketId, 40n, toUSDC("100")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 60n, toUSDC("100")], {
        account: predictor2.account,
      });

      await advanceTime(86401);
      await market.write.lockMarket([marketId]);
      await market.write.resolveMarket([marketId, true], { account: dealer1.account });

      // predictor2 wins. Expected minimum payout ratio: (100-60)/60 = 40/60 = 0.667
      // Actual: pool=200, fee=2, winnerPool=198. Payout=198. Profit=98. Ratio=98/100=0.98
      // 0.98 >= 0.667 ✓
      const payout = await market.read.calculatePayout([marketId, predictor2.account.address]);
      const profit = payout - toUSDC("100");
      const minExpectedProfit = (toUSDC("100") * 40n) / 60n; // 66.66 USDC
      expect(profit > minExpectedProfit).to.be.true;
    });

    it("F2: equilibrium bettors receive exact full refund", async function () {
      const { market, dealer1, predictor1, predictor2, predictor3, marketId } =
        await setupMarket();

      await market.write.placePrediction([marketId, 30n, toUSDC("100")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 50n, toUSDC("250")], {
        account: predictor2.account,
      });
      await market.write.placePrediction([marketId, 70n, toUSDC("100")], {
        account: predictor3.account,
      });

      await advanceTime(86401);
      await market.write.lockMarket([marketId]);
      await market.write.resolveMarket([marketId, true], { account: dealer1.account });

      // predictor2 at equilibrium 50 gets full refund of 250 USDC
      const refund = await market.read.getRefundAmount([marketId, predictor2.account.address]);
      expect(refund).to.equal(toUSDC("250"));
    });
  });

  // ========== GROUP G: Equilibrium Excludes Stakes from Payouts ==========

  describe("Equilibrium stakes excluded from payouts", function () {
    it("G1: equilibrium stakes not counted in distributable pool", async function () {
      const { market, dealer1, predictor1, predictor2, predictor3, stakeToken, marketId } =
        await setupMarket();

      await market.write.placePrediction([marketId, 30n, toUSDC("150")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 50n, toUSDC("150")], {
        account: predictor2.account,
      });
      await market.write.placePrediction([marketId, 80n, toUSDC("150")], {
        account: predictor3.account,
      });

      await advanceTime(86401);
      await market.write.lockMarket([marketId]);
      await market.write.resolveMarket([marketId, true], {
        account: dealer1.account,
      });

      // Total pool = 450 USDC, but 150 USDC sits at equilibrium and should be refunded.
      // Winners split the 300 USDC pool minus 1% fee (3 USDC) = 297 USDC.
      const winnerBefore = await stakeToken.read.balanceOf([
        predictor3.account.address,
      ]);
      await market.write.claimWinnings([marketId], {
        account: predictor3.account,
      });
      const winnerAfter = await stakeToken.read.balanceOf([
        predictor3.account.address,
      ]);

      expect(winnerAfter - winnerBefore).to.equal(toUSDC("297"));
    });
  });

  // ========== GROUP H: Degenerate Cases ==========

  describe("Degenerate cases", function () {
    it("H1: single prediction — lockMarket reverts", async function () {
      const { market, predictor1, marketId } = await setupMarket();

      await market.write.placePrediction([marketId, 50n, toUSDC("100")], {
        account: predictor1.account,
      });

      await advanceTime(86401);

      try {
        await market.write.lockMarket([marketId]);
        expect.fail("Should have reverted");
      } catch (error: any) {
        expect(error.message).to.match(/No valid equilibrium|One-sided market/);
      }
    });

    it("H2: three predictions at same percentage — lockMarket reverts", async function () {
      const { market, predictor1, predictor2, predictor3, marketId } =
        await setupMarket();

      await market.write.placePrediction([marketId, 30n, toUSDC("100")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 30n, toUSDC("200")], {
        account: predictor2.account,
      });
      await market.write.placePrediction([marketId, 30n, toUSDC("50")], {
        account: predictor3.account,
      });

      await advanceTime(86401);

      try {
        await market.write.lockMarket([marketId]);
        expect.fail("Should have reverted");
      } catch (error: any) {
        expect(error.message).to.match(/No valid equilibrium|One-sided market/);
      }
    });

    it("H3: same percentage — lockMarketWithEquilibrium also reverts", async function () {
      const { market, predictor1, predictor2, marketId } = await setupMarket();

      await market.write.placePrediction([marketId, 50n, toUSDC("100")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 50n, toUSDC("200")], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      // Any forced equilibrium still fails — no bets on both sides
      try {
        await market.write.lockMarketWithEquilibrium([marketId, 25n]);
        expect.fail("Should have reverted");
      } catch (error: any) {
        expect(error.message).to.include("One-sided market");
      }

      try {
        await market.write.lockMarketWithEquilibrium([marketId, 75n]);
        expect.fail("Should have reverted");
      } catch (error: any) {
        expect(error.message).to.include("One-sided market");
      }
    });
  });

  // ========== GROUP I: Boundary Percentages (0% and 100%) ==========

  describe("Boundary percentages (0% and 100%)", function () {
    it("I1: bet at 0% and 50% — equilibrium near lower boundary", async function () {
      const { market, predictor1, predictor2, marketId } = await setupMarket();

      // bet(0,$100) + bet(50,$100) → eq=49
      // At p=49: below(0)=100, above(50)=100. diff=|100*51-100*49|=200 (minimum)
      await market.write.placePrediction([marketId, 0n, toUSDC("100")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 50n, toUSDC("100")], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      const eq = await market.read.calculateEquilibrium([marketId]);
      expect(eq).to.equal(49n);

      await market.write.lockMarket([marketId]);
      const data = await market.read.markets([marketId]);
      expect(data[8]).to.equal(4); // Locked
      expect(data[10]).to.equal(49n);
    });

    it("I2: bet at 50% and 100% — forced equilibrium=51", async function () {
      const { market, predictor1, predictor2, marketId } = await setupMarket();

      // bet(50,$100) + bet(100,$100). calculateEquilibrium returns 1 (ties with 51
      // at diff=200, but p=1 is found first — one-sided). Use forced eq=51 instead.
      await market.write.placePrediction([marketId, 50n, toUSDC("100")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 100n, toUSDC("100")], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      // lockMarket would revert (eq=1 is one-sided), so use forced equilibrium
      await market.write.lockMarketWithEquilibrium([marketId, 51n]);
      const data = await market.read.markets([marketId]);
      expect(data[8]).to.equal(4); // Locked
      expect(data[10]).to.equal(51n);
    });

    it("I3: bet at 0% and 100% — eq=50, full lifecycle with payouts", async function () {
      const { market, dealer1, predictor1, predictor2, stakeToken, marketId } =
        await setupMarket();

      await market.write.placePrediction([marketId, 0n, toUSDC("100")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 100n, toUSDC("100")], {
        account: predictor2.account,
      });

      await advanceTime(86401);
      await market.write.lockMarket([marketId]);

      const data = await market.read.markets([marketId]);
      expect(data[10]).to.equal(50n); // equilibrium=50

      // No lock refund (balanced: 100*50 == 100*50)
      const refund1 = await market.read.getLockRefundAmount([marketId, predictor1.account.address]);
      const refund2 = await market.read.getLockRefundAmount([marketId, predictor2.account.address]);
      expect(refund1).to.equal(0n);
      expect(refund2).to.equal(0n);

      // Resolve above eq: predictor2 (100%) wins
      await market.write.resolveMarket([marketId, true], { account: dealer1.account });

      // Pool=200, fee=2, winnerPool=198
      const before = await stakeToken.read.balanceOf([predictor2.account.address]);
      await market.write.claimWinnings([marketId], { account: predictor2.account });
      const after = await stakeToken.read.balanceOf([predictor2.account.address]);
      expect(after - before).to.equal(toUSDC("198"));
    });

    it("I4: bet(0,$100) + bet(100,$300) — equilibrium=25", async function () {
      const { market, dealer1, predictor1, predictor2, stakeToken, marketId } =
        await setupMarket();

      // At p=25: below=100, above=300. |100*75-300*25|=0
      await market.write.placePrediction([marketId, 0n, toUSDC("100")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 100n, toUSDC("300")], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      const eq = await market.read.calculateEquilibrium([marketId]);
      expect(eq).to.equal(25n);

      await market.write.lockMarket([marketId]);

      // Balanced → no lock refund
      expect(await market.read.getLockRefundAmount([marketId, predictor1.account.address])).to.equal(0n);
      expect(await market.read.getLockRefundAmount([marketId, predictor2.account.address])).to.equal(0n);

      // Resolve above eq=25: predictor2 wins
      await market.write.resolveMarket([marketId, true], { account: dealer1.account });

      // Pool=400, fee=4, winnerPool=396
      const before = await stakeToken.read.balanceOf([predictor2.account.address]);
      await market.write.claimWinnings([marketId], { account: predictor2.account });
      const after = await stakeToken.read.balanceOf([predictor2.account.address]);
      expect(after - before).to.equal(toUSDC("396"));
    });

    it("I5: bet(0,$300) + bet(100,$100) — equilibrium=75", async function () {
      const { market, dealer1, predictor1, predictor2, stakeToken, marketId } =
        await setupMarket();

      // At p=75: below=300, above=100. |300*25-100*75|=0
      await market.write.placePrediction([marketId, 0n, toUSDC("300")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 100n, toUSDC("100")], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      const eq = await market.read.calculateEquilibrium([marketId]);
      expect(eq).to.equal(75n);

      await market.write.lockMarket([marketId]);

      // Resolve below eq=75: predictor1 wins
      await market.write.resolveMarket([marketId, false], { account: dealer1.account });

      // Pool=400, fee=4, winnerPool=396
      const before = await stakeToken.read.balanceOf([predictor1.account.address]);
      await market.write.claimWinnings([marketId], { account: predictor1.account });
      const after = await stakeToken.read.balanceOf([predictor1.account.address]);
      expect(after - before).to.equal(toUSDC("396"));
    });

    it("I6: bets at 0%, 50%, 100% — middle bettor gets full refund", async function () {
      const { market, dealer1, predictor1, predictor2, predictor3, stakeToken, marketId } =
        await setupMarket();

      // At p=50: below(0)=100, above(100)=100. diff=0. Eq=50.
      // Bet at 50% is at equilibrium → full refund.
      await market.write.placePrediction([marketId, 0n, toUSDC("100")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 50n, toUSDC("100")], {
        account: predictor2.account,
      });
      await market.write.placePrediction([marketId, 100n, toUSDC("100")], {
        account: predictor3.account,
      });

      await advanceTime(86401);
      await market.write.lockMarket([marketId]);

      const data = await market.read.markets([marketId]);
      expect(data[10]).to.equal(50n);

      await market.write.resolveMarket([marketId, true], { account: dealer1.account });

      // predictor2 at eq=50 gets full refund
      const refund = await market.read.getRefundAmount([marketId, predictor2.account.address]);
      expect(refund).to.equal(toUSDC("100"));

      const p2Before = await stakeToken.read.balanceOf([predictor2.account.address]);
      await market.write.claimRefund([marketId], { account: predictor2.account });
      const p2After = await stakeToken.read.balanceOf([predictor2.account.address]);
      expect(p2After - p2Before).to.equal(toUSDC("100"));

      // predictor3 (100%, above eq) wins. Pool=300, eqStakes=100, distributable=200, fee=2, winnerPool=198.
      const p3Before = await stakeToken.read.balanceOf([predictor3.account.address]);
      await market.write.claimWinnings([marketId], { account: predictor3.account });
      const p3After = await stakeToken.read.balanceOf([predictor3.account.address]);
      expect(p3After - p3Before).to.equal(toUSDC("198"));
    });

    it("I7: bets at 0%, 1%, 99%, 100% — equilibrium=50", async function () {
      const { market, dealer1, predictor1, predictor2, predictor3, dealer2, stakeToken, marketId } =
        await setupMarket();

      // All $100. At p=50: below=200 (0+1), above=200 (99+100). diff=0.
      await market.write.placePrediction([marketId, 0n, toUSDC("100")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 1n, toUSDC("100")], {
        account: predictor2.account,
      });
      await market.write.placePrediction([marketId, 99n, toUSDC("100")], {
        account: predictor3.account,
      });
      await market.write.placePrediction([marketId, 100n, toUSDC("100")], {
        account: dealer2.account,
      });

      await advanceTime(86401);

      const eq = await market.read.calculateEquilibrium([marketId]);
      expect(eq).to.equal(50n);

      await market.write.lockMarket([marketId]);

      // Resolve positive: above-side winners (99, 100)
      await market.write.resolveMarket([marketId, true], { account: dealer1.account });

      // Pool=400, eqStakes=0, distributable=400, fee=4, winnerPool=396
      // Each winner: (100*396)/200 = 198
      const p3Before = await stakeToken.read.balanceOf([predictor3.account.address]);
      await market.write.claimWinnings([marketId], { account: predictor3.account });
      const p3After = await stakeToken.read.balanceOf([predictor3.account.address]);
      expect(p3After - p3Before).to.equal(toUSDC("198"));

      const d2Before = await stakeToken.read.balanceOf([dealer2.account.address]);
      await market.write.claimWinnings([marketId], { account: dealer2.account });
      const d2After = await stakeToken.read.balanceOf([dealer2.account.address]);
      expect(d2After - d2Before).to.equal(toUSDC("198"));
    });

    it("I8: multiple bettors at 0% vs one at 100%", async function () {
      const { market, dealer1, predictor1, predictor2, predictor3, stakeToken, marketId } =
        await setupMarket();

      // bet(0,$150) + bet(0,$150) + bet(100,$300) → eq=50, balanced
      await market.write.placePrediction([marketId, 0n, toUSDC("150")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 0n, toUSDC("150")], {
        account: predictor2.account,
      });
      await market.write.placePrediction([marketId, 100n, toUSDC("300")], {
        account: predictor3.account,
      });

      await advanceTime(86401);
      await market.write.lockMarket([marketId]);

      const data = await market.read.markets([marketId]);
      expect(data[10]).to.equal(50n);

      // Resolve below eq: predictors at 0% win
      await market.write.resolveMarket([marketId, false], { account: dealer1.account });

      // Pool=600, fee=6, winnerPool=594. Two winners: 150 each, total=300.
      // Each gets (150*594)/300 = 297
      const p1Before = await stakeToken.read.balanceOf([predictor1.account.address]);
      await market.write.claimWinnings([marketId], { account: predictor1.account });
      const p1After = await stakeToken.read.balanceOf([predictor1.account.address]);
      expect(p1After - p1Before).to.equal(toUSDC("297"));

      const p2Before = await stakeToken.read.balanceOf([predictor2.account.address]);
      await market.write.claimWinnings([marketId], { account: predictor2.account });
      const p2After = await stakeToken.read.balanceOf([predictor2.account.address]);
      expect(p2After - p2Before).to.equal(toUSDC("297"));
    });
  });

  // ========== GROUP J: Mass Refund (n-1 same percentage, overweight) ==========

  describe("Mass refund (n-1 same percentage)", function () {
    it("J1: 3 below bettors refunded, below side wins", async function () {
      const { market, dealer1, dealer2, predictor1, predictor2, predictor3, stakeToken, marketId } =
        await setupMarket();

      // 3 at 20% ($150 each = $450) + 1 at 80% ($150). Force eq=50.
      // below=450, above=150. targetBelow=(150*50)/50=150. excess=300.
      // Each below refund = (150*300)/450 = $100.
      await market.write.placePrediction([marketId, 20n, toUSDC("150")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 20n, toUSDC("150")], {
        account: predictor2.account,
      });
      await market.write.placePrediction([marketId, 20n, toUSDC("150")], {
        account: predictor3.account,
      });
      await market.write.placePrediction([marketId, 80n, toUSDC("150")], {
        account: dealer2.account,
      });

      await advanceTime(86401);
      await market.write.lockMarketWithEquilibrium([marketId, 50n]);

      // All 3 below bettors get $100 lock refund each
      const r1 = await market.read.getLockRefundAmount([marketId, predictor1.account.address]);
      const r2 = await market.read.getLockRefundAmount([marketId, predictor2.account.address]);
      const r3 = await market.read.getLockRefundAmount([marketId, predictor3.account.address]);
      expect(r1).to.equal(toUSDC("100"));
      expect(r2).to.equal(toUSDC("100"));
      expect(r3).to.equal(toUSDC("100"));

      // Above bettor gets no lock refund
      expect(await market.read.getLockRefundAmount([marketId, dealer2.account.address])).to.equal(0n);

      // Claim lock refunds
      await market.write.claimLockRefund([marketId], { account: predictor1.account });
      await market.write.claimLockRefund([marketId], { account: predictor2.account });
      await market.write.claimLockRefund([marketId], { account: predictor3.account });

      // Resolve below eq → below wins
      await market.write.resolveMarket([marketId, false], { account: dealer1.account });

      // Pool after excess: 600-300=300. eqStakes=0. distributable=300. fee=3. winnerPool=297.
      // Each winner effective=150-100=50. totalWinning=150. Each payout=(50*297)/150=99.
      const p1Before = await stakeToken.read.balanceOf([predictor1.account.address]);
      await market.write.claimWinnings([marketId], { account: predictor1.account });
      const p1After = await stakeToken.read.balanceOf([predictor1.account.address]);
      expect(p1After - p1Before).to.equal(toUSDC("99"));
    });

    it("J2: 3 below bettors refunded, above side wins", async function () {
      const { market, dealer1, dealer2, predictor1, predictor2, predictor3, stakeToken, marketId } =
        await setupMarket();

      // Same setup: 3 at 20% ($150) + 1 at 80% ($150). eq=50.
      await market.write.placePrediction([marketId, 20n, toUSDC("150")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 20n, toUSDC("150")], {
        account: predictor2.account,
      });
      await market.write.placePrediction([marketId, 20n, toUSDC("150")], {
        account: predictor3.account,
      });
      await market.write.placePrediction([marketId, 80n, toUSDC("150")], {
        account: dealer2.account,
      });

      await advanceTime(86401);
      await market.write.lockMarketWithEquilibrium([marketId, 50n]);

      // Resolve above eq → above wins
      await market.write.resolveMarket([marketId, true], { account: dealer1.account });

      // Above bettor effective=150 (lighter side, no refund). totalWinning=150. winnerPool=297.
      // Payout = (150*297)/150 = 297.
      const d2Before = await stakeToken.read.balanceOf([dealer2.account.address]);
      await market.write.claimWinnings([marketId], { account: dealer2.account });
      const d2After = await stakeToken.read.balanceOf([dealer2.account.address]);
      expect(d2After - d2Before).to.equal(toUSDC("297"));

      // Below bettors are losers, but can still claim lock refunds
      const p1Before = await stakeToken.read.balanceOf([predictor1.account.address]);
      await market.write.claimLockRefund([marketId], { account: predictor1.account });
      const p1After = await stakeToken.read.balanceOf([predictor1.account.address]);
      expect(p1After - p1Before).to.equal(toUSDC("100"));
    });

    it("J3: 3 above bettors refunded (mirrored)", async function () {
      const { market, dealer1, dealer2, predictor1, predictor2, predictor3, stakeToken, marketId } =
        await setupMarket();

      // 1 at 20% ($150) + 3 at 80% ($150 each = $450). Force eq=50.
      // above=450, below=150. targetAbove=(150*50)/50=150. excess=300. Each above refund=$100.
      await market.write.placePrediction([marketId, 20n, toUSDC("150")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 80n, toUSDC("150")], {
        account: predictor2.account,
      });
      await market.write.placePrediction([marketId, 80n, toUSDC("150")], {
        account: predictor3.account,
      });
      await market.write.placePrediction([marketId, 80n, toUSDC("150")], {
        account: dealer2.account,
      });

      await advanceTime(86401);
      await market.write.lockMarketWithEquilibrium([marketId, 50n]);

      // All 3 above bettors refunded $100
      expect(await market.read.getLockRefundAmount([marketId, predictor2.account.address])).to.equal(toUSDC("100"));
      expect(await market.read.getLockRefundAmount([marketId, predictor3.account.address])).to.equal(toUSDC("100"));
      expect(await market.read.getLockRefundAmount([marketId, dealer2.account.address])).to.equal(toUSDC("100"));

      // Below bettor gets no lock refund
      expect(await market.read.getLockRefundAmount([marketId, predictor1.account.address])).to.equal(0n);

      // Resolve above eq → above wins
      await market.write.resolveMarket([marketId, true], { account: dealer1.account });

      // Each above bettor effective=50. totalWinning=150. winnerPool=297. Each payout=99.
      const p2Before = await stakeToken.read.balanceOf([predictor2.account.address]);
      await market.write.claimWinnings([marketId], { account: predictor2.account });
      const p2After = await stakeToken.read.balanceOf([predictor2.account.address]);
      expect(p2After - p2Before).to.equal(toUSDC("99"));
    });
  });

  // ========== GROUP K: Complex Multi-Bettor Combinations ==========

  describe("Complex multi-bettor combinations", function () {
    it("K1: 4 bettors evenly spread — natural equilibrium=25", async function () {
      const { market, dealer1, dealer2, predictor1, predictor2, predictor3, stakeToken, marketId } =
        await setupMarket();

      // bet(20,$100) + bet(40,$100) + bet(60,$100) + bet(80,$100)
      // At p=25: below=100 (at 20), above=300 (40+60+80). |100*75-300*25|=0. Eq=25.
      await market.write.placePrediction([marketId, 20n, toUSDC("100")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 40n, toUSDC("100")], {
        account: predictor2.account,
      });
      await market.write.placePrediction([marketId, 60n, toUSDC("100")], {
        account: predictor3.account,
      });
      await market.write.placePrediction([marketId, 80n, toUSDC("100")], {
        account: dealer2.account,
      });

      await advanceTime(86401);

      const eq = await market.read.calculateEquilibrium([marketId]);
      expect(eq).to.equal(25n);

      await market.write.lockMarket([marketId]);

      // Balanced → no lock refund
      expect(await market.read.getLockRefundAmount([marketId, predictor1.account.address])).to.equal(0n);

      // Resolve above eq=25: 3 winners (40, 60, 80)
      await market.write.resolveMarket([marketId, true], { account: dealer1.account });

      // Pool=400, fee=4, winnerPool=396. 3 winners with $100 each. Each: (100*396)/300=132.
      const p2Before = await stakeToken.read.balanceOf([predictor2.account.address]);
      await market.write.claimWinnings([marketId], { account: predictor2.account });
      const p2After = await stakeToken.read.balanceOf([predictor2.account.address]);
      expect(p2After - p2Before).to.equal(toUSDC("132"));

      // Loser at 20% gets nothing
      const payout1 = await market.read.calculatePayout([marketId, predictor1.account.address]);
      expect(payout1).to.equal(0n);
    });

    it("K2: many small bets vs one large bet with forced equilibrium", async function () {
      const { market, dealer1, predictor1, predictor2, predictor3, stakeToken, marketId } =
        await setupMarket();

      // bet(20,$50) + bet(30,$50) + bet(70,$300). Force eq=50.
      // below=100, above=300. Above overweight.
      // targetAbove=(100*50)/50=100. excess=200. Refund for predictor3=(300*200)/300=$200.
      await market.write.placePrediction([marketId, 20n, toUSDC("50")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 30n, toUSDC("50")], {
        account: predictor2.account,
      });
      await market.write.placePrediction([marketId, 70n, toUSDC("300")], {
        account: predictor3.account,
      });

      await advanceTime(86401);
      await market.write.lockMarketWithEquilibrium([marketId, 50n]);

      // Large bettor gets $200 lock refund
      expect(await market.read.getLockRefundAmount([marketId, predictor3.account.address])).to.equal(toUSDC("200"));
      // Small bettors get nothing (lighter side)
      expect(await market.read.getLockRefundAmount([marketId, predictor1.account.address])).to.equal(0n);

      // Resolve above eq → predictor3 wins
      await market.write.resolveMarket([marketId, true], { account: dealer1.account });

      // Pool after excess: 400-200=200. distributable=200. fee=2. winnerPool=198.
      // predictor3 effective=300-200=100. totalWinning=100. Payout=198.
      const p3Before = await stakeToken.read.balanceOf([predictor3.account.address]);
      await market.write.claimWinnings([marketId], { account: predictor3.account });
      const p3After = await stakeToken.read.balanceOf([predictor3.account.address]);
      expect(p3After - p3Before).to.equal(toUSDC("198"));
    });

    it("K3: boundaries + equilibrium bettor + lock refund combined", async function () {
      const { market, dealer1, dealer2, predictor1, predictor2, predictor3, stakeToken, marketId } =
        await setupMarket();

      // bet(0,$100) + bet(25,$100) + bet(50,$100) + bet(75,$100). Force eq=50.
      // below=200 (0+25), above=100 (75). Bet at 50 is eq → full refund.
      // Below overweight: targetBelow=(100*50)/50=100. excess=100.
      // predictor1 refund=(100*100)/200=$50. predictor2 refund=(100*100)/200=$50.
      await market.write.placePrediction([marketId, 0n, toUSDC("100")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 25n, toUSDC("100")], {
        account: predictor2.account,
      });
      await market.write.placePrediction([marketId, 50n, toUSDC("100")], {
        account: predictor3.account,
      });
      await market.write.placePrediction([marketId, 75n, toUSDC("100")], {
        account: dealer2.account,
      });

      await advanceTime(86401);
      await market.write.lockMarketWithEquilibrium([marketId, 50n]);

      // Below bettors get lock refund
      expect(await market.read.getLockRefundAmount([marketId, predictor1.account.address])).to.equal(toUSDC("50"));
      expect(await market.read.getLockRefundAmount([marketId, predictor2.account.address])).to.equal(toUSDC("50"));
      // Equilibrium bettor: no lock refund (gets full refund via claimRefund)
      expect(await market.read.getLockRefundAmount([marketId, predictor3.account.address])).to.equal(0n);
      // Above bettor: no lock refund (lighter side)
      expect(await market.read.getLockRefundAmount([marketId, dealer2.account.address])).to.equal(0n);

      // Resolve above eq → dealer2 (75%) wins
      await market.write.resolveMarket([marketId, true], { account: dealer1.account });

      // Pool after excess: 400-100=300. eqStakes=100. distributable=200. fee=2. winnerPool=198.
      const d2Before = await stakeToken.read.balanceOf([dealer2.account.address]);
      await market.write.claimWinnings([marketId], { account: dealer2.account });
      const d2After = await stakeToken.read.balanceOf([dealer2.account.address]);
      expect(d2After - d2Before).to.equal(toUSDC("198"));

      // Equilibrium bettor gets full $100 refund
      const p3Before = await stakeToken.read.balanceOf([predictor3.account.address]);
      await market.write.claimRefund([marketId], { account: predictor3.account });
      const p3After = await stakeToken.read.balanceOf([predictor3.account.address]);
      expect(p3After - p3Before).to.equal(toUSDC("100"));

      // Below bettors can claim lock refund (losers, but still get partial back)
      const p1Before = await stakeToken.read.balanceOf([predictor1.account.address]);
      await market.write.claimLockRefund([marketId], { account: predictor1.account });
      const p1After = await stakeToken.read.balanceOf([predictor1.account.address]);
      expect(p1After - p1Before).to.equal(toUSDC("50"));
    });

    it("K4: conservation of value — all payouts + refunds + fees = total pool", async function () {
      const { market, dealer1, predictor1, predictor2, predictor3, stakeToken, owner, marketId } =
        await setupMarket();

      // bet(20,$200) + bet(50,$100) + bet(80,$200). Force eq=50.
      // below=200, above=200. Balanced! Eq bettor ($100) gets full refund.
      await market.write.placePrediction([marketId, 20n, toUSDC("200")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 50n, toUSDC("100")], {
        account: predictor2.account,
      });
      await market.write.placePrediction([marketId, 80n, toUSDC("200")], {
        account: predictor3.account,
      });

      await advanceTime(86401);
      await market.write.lockMarketWithEquilibrium([marketId, 50n]);

      await market.write.resolveMarket([marketId, true], { account: dealer1.account });

      // Collect all outputs
      // Winner: predictor3 (80%, above eq)
      const winnerBefore = await stakeToken.read.balanceOf([predictor3.account.address]);
      await market.write.claimWinnings([marketId], { account: predictor3.account });
      const winnerAfter = await stakeToken.read.balanceOf([predictor3.account.address]);
      const winnerPayout = winnerAfter - winnerBefore;

      // Eq refund: predictor2
      const eqBefore = await stakeToken.read.balanceOf([predictor2.account.address]);
      await market.write.claimRefund([marketId], { account: predictor2.account });
      const eqAfter = await stakeToken.read.balanceOf([predictor2.account.address]);
      const eqRefund = eqAfter - eqBefore;
      expect(eqRefund).to.equal(toUSDC("100"));

      // Dealer fees
      const dealerBefore = await stakeToken.read.balanceOf([dealer1.account.address]);
      await market.write.withdrawDealerFees([marketId], { account: dealer1.account });
      const dealerAfter = await stakeToken.read.balanceOf([dealer1.account.address]);
      const dealerFee = dealerAfter - dealerBefore;

      // System fees
      const ownerBefore = await stakeToken.read.balanceOf([owner.account.address]);
      await market.write.withdrawSystemFees({ account: owner.account });
      const ownerAfter = await stakeToken.read.balanceOf([owner.account.address]);
      const systemFee = ownerAfter - ownerBefore;

      // Total out = winnerPayout + eqRefund + dealerFee + systemFee
      // Loser (predictor1) gets nothing. Total pool was 500.
      const totalOut = winnerPayout + eqRefund + dealerFee + systemFee;
      expect(totalOut).to.equal(toUSDC("500"));
    });

    it("K5: 4 bettors at 0%, 0%, 100%, 100% — two winners split", async function () {
      const { market, dealer1, dealer2, predictor1, predictor2, predictor3, stakeToken, marketId } =
        await setupMarket();

      // eq=50 (symmetric). Pool=400, balanced.
      await market.write.placePrediction([marketId, 0n, toUSDC("100")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 0n, toUSDC("100")], {
        account: predictor2.account,
      });
      await market.write.placePrediction([marketId, 100n, toUSDC("100")], {
        account: predictor3.account,
      });
      await market.write.placePrediction([marketId, 100n, toUSDC("100")], {
        account: dealer2.account,
      });

      await advanceTime(86401);
      await market.write.lockMarket([marketId]);

      const data = await market.read.markets([marketId]);
      expect(data[10]).to.equal(50n);

      // Resolve above: 100% bettors win
      await market.write.resolveMarket([marketId, true], { account: dealer1.account });

      // Pool=400, fee=4, winnerPool=396. Two winners ($100 each). Each: 198.
      const p3Before = await stakeToken.read.balanceOf([predictor3.account.address]);
      await market.write.claimWinnings([marketId], { account: predictor3.account });
      const p3After = await stakeToken.read.balanceOf([predictor3.account.address]);
      expect(p3After - p3Before).to.equal(toUSDC("198"));

      const d2Before = await stakeToken.read.balanceOf([dealer2.account.address]);
      await market.write.claimWinnings([marketId], { account: dealer2.account });
      const d2After = await stakeToken.read.balanceOf([dealer2.account.address]);
      expect(d2After - d2Before).to.equal(toUSDC("198"));
    });

    it("K6: unequal amounts at 0% and 100% — asymmetric equilibrium", async function () {
      const { market, dealer1, predictor1, predictor2, marketId } =
        await setupMarket();

      // bet(0,$500) + bet(100,$100). Eq: |500*(100-p)-100*p|=|50000-600p|. Zero at ~83.
      // p=83: diff=|50000-49800|=200. p=84: diff=400. Eq=83.
      await market.write.placePrediction([marketId, 0n, toUSDC("500")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 100n, toUSDC("100")], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      const eq = await market.read.calculateEquilibrium([marketId]);
      expect(eq).to.equal(83n);

      await market.write.lockMarket([marketId]);

      // Below overweight: leftSide=500*17=8500 > rightSide=100*83=8300
      // predictor1 gets small lock refund (below is heavier)
      const refund1 = await market.read.getLockRefundAmount([marketId, predictor1.account.address]);
      expect(refund1 > 0n).to.be.true;
      // predictor2 gets nothing
      expect(await market.read.getLockRefundAmount([marketId, predictor2.account.address])).to.equal(0n);

      // Resolve below eq → predictor1 wins
      await market.write.resolveMarket([marketId, false], { account: dealer1.account });

      const payout1 = await market.read.calculatePayout([marketId, predictor1.account.address]);
      expect(payout1 > 0n).to.be.true;

      // predictor2 is a loser
      const payout2 = await market.read.calculatePayout([marketId, predictor2.account.address]);
      expect(payout2).to.equal(0n);
    });
  });
});
