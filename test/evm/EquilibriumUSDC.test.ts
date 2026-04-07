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
    it("A1: finds gap equilibrium for symmetric bets", async function () {
      const { market, dealer1, predictor1, predictor2, marketId } =
        await setupMarket();

      await market.write.placePrediction([marketId, 40n, toUSDC("150")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 60n, toUSDC("150")], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      // New formula: gap at g=40. neg=150(at 40), pos=150(at 60).
      // (41)*150=6150 vs (40)*150=6000. Best gap diff=150.
      const eq = await market.read.calculateEquilibrium([marketId]);
      expect(eq).to.equal(40n);

      await market.write.lockMarket([marketId]);
      await market.write.resolveMarket([marketId, true], {
        account: dealer1.account,
      });

      const [, , , , , , , , , , equilibrium] = await market.read.markets([
        marketId,
      ]);
      expect(equilibrium).to.equal(40n);
    });

    it("A2: finds gap equilibrium for uneven amounts", async function () {
      // bet(20, $300) + bet(80, $100)
      // New formula gap at g=20: neg=300(at 20), pos=100(at 80).
      // (21)*100=2100 vs (20)*300=6000. diff=3900 (best among all gaps).
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
      expect(eq).to.equal(20n);

      await market.write.lockMarket([marketId]);

      const [, , , , , , , , , , equilibrium] = await market.read.markets([marketId]);
      expect(equilibrium).to.equal(20n);
    });

    it("A3: handles multiple bettors per side", async function () {
      // bet(20,$100) + bet(30,$200) + bet(70,$150)
      // New formula: exact at p=30 wins (diff=1750, best).
      // neg=100(at 20), pos=150(at 70), eqAmt=200(at 30).
      // (31)*150=4650 vs (29)*100=2900. diff=1750.
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
      expect(eq).to.equal(30n);
    });

    it("A4: adjacent bets at 49 and 51 give equilibrium 49", async function () {
      const { market, predictor1, predictor2, marketId } = await setupMarket();

      await market.write.placePrediction([marketId, 49n, toUSDC("100")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 51n, toUSDC("100")], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      // New formula gap at g=49: neg=100(at 49), pos=100(at 51).
      // (50)*100=5000 vs (49)*100=4900. diff=100 (best).
      const eq = await market.read.calculateEquilibrium([marketId]);
      expect(eq).to.equal(49n);
    });

    it("A5: bets at 0% and 100% give equilibrium 1", async function () {
      const { market, predictor1, predictor2, marketId } = await setupMarket();

      await market.write.placePrediction([marketId, 0n, toUSDC("200")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 100n, toUSDC("200")], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      // New formula: for bets at 0% and 100% with equal amounts,
      // all gap values 1..99 produce the same diff=200.
      // g=1 is found first: (2)*200=400 vs (1)*200=200, diff=200.
      const eq = await market.read.calculateEquilibrium([marketId]);
      expect(eq).to.equal(1n);
    });

    it("A6: calculateEquilibrium view matches lockMarket result", async function () {
      const { market, predictor1, predictor2, marketId } =
        await setupMarket();

      // bet(20, $200) + bet(80, $100)
      // New formula gap at g=20: neg=200, pos=100.
      // (21)*100=2100 vs (20)*200=4000. diff=1900 (best).
      await market.write.placePrediction([marketId, 20n, toUSDC("200")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 80n, toUSDC("100")], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      const eqView = await market.read.calculateEquilibrium([marketId]);
      expect(eqView).to.equal(20n);

      await market.write.lockMarket([marketId]);

      const [, , , , , , , , , , storedEq] = await market.read.markets([marketId]);
      expect(storedEq).to.equal(eqView);
    });
  });

  // ========== GROUP B: Lock Refund Mechanism ==========

  describe("Lock refund mechanism", function () {
    it("B1: below side overweight gets partial refund", async function () {
      // bet(20, $300) + bet(80, $100). Force equilibrium=50 (gap).
      // neg=300(at 20, <=50), pos=100(at 80, >50). pNeg=50, pPos=51.
      // leftSide=51*100=5100, rightSide=50*300=15000. neg overweight.
      // targetNeg=floor(100*51/50)=102. excess=300-102=198.
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

      // predictor1 (below, overweight) should get lock refund of 198
      const refund = await market.read.getLockRefundAmount([
        marketId,
        predictor1.account.address,
      ]);
      expect(refund).to.equal(toUSDC("198"));

      // predictor2 (above, lighter side) gets no lock refund
      const refund2 = await market.read.getLockRefundAmount([
        marketId,
        predictor2.account.address,
      ]);
      expect(refund2).to.equal(0n);
    });

    it("B2: above side overweight gets partial refund", async function () {
      // bet(20, $100) + bet(80, $300). Force equilibrium=50 (gap).
      // neg=100(at 20, <=50), pos=300(at 80, >50). pNeg=50, pPos=51.
      // leftSide=51*300=15300, rightSide=50*100=5000. pos overweight.
      // targetPos=floor(100*50/51)=98. excess=300-98=202.
      const { market, predictor1, predictor2, marketId } = await setupMarket();

      await market.write.placePrediction([marketId, 20n, toUSDC("100")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 80n, toUSDC("300")], {
        account: predictor2.account,
      });

      await advanceTime(86401);
      await market.write.lockMarketWithEquilibrium([marketId, 50n]);

      // predictor2 (above, overweight) should get lock refund
      // targetPos=floor(100M*50/51)=98039215. excess=300M-98039215-100M=201960785 (~201.96 USDC)
      const refund2 = await market.read.getLockRefundAmount([
        marketId,
        predictor2.account.address,
      ]);
      expect(refund2).to.equal(201960785n);

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
      // Force equilibrium=50 (gap). neg=300, pos=100. pNeg=50, pPos=51.
      // rightSide=50*300=15000 > leftSide=51*100=5100. neg overweight.
      // targetNeg=floor(100*51/50)=102. excess=198.
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
      expect(p1AfterRefund - p1Before).to.equal(toUSDC("198"));

      // Resolve below equilibrium: predictor1 wins
      await market.write.resolveMarket([marketId, false], { account: dealer1.account });

      // Pool after lock refund: 400M - 198M = 202M. fee = 202M*100/10000 = 2020000.
      // winnerPool = 202M - 2020000 = 199980000.
      // predictor1 effective = 300M - 198M = 102M. Total winning = 102M. Payout = 199980000.
      const p1BeforeWin = await stakeToken.read.balanceOf([predictor1.account.address]);
      await market.write.claimWinnings([marketId], { account: predictor1.account });
      const p1AfterWin = await stakeToken.read.balanceOf([predictor1.account.address]);
      expect(p1AfterWin - p1BeforeWin).to.equal(199980000n);
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

      // For perfect balance at gap g=40: (41)*pos == (40)*neg.
      // Use neg=41 USDC (at 40%), pos=40 USDC (at 60%).
      await market.write.placePrediction([marketId, 40n, toUSDC("41")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 60n, toUSDC("40")], {
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
    it("C1: adjacent bets form two-sided market — lockMarket succeeds", async function () {
      const { market, predictor1, predictor2, marketId } = await setupMarket();

      // With new formula, bets at 20 and 30 create a valid two-sided market.
      // Gap at g=20: neg=100(at 20), pos=100(at 30). Both sides have bets.
      await market.write.placePrediction([marketId, 20n, toUSDC("100")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 30n, toUSDC("100")], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      // Should succeed with eq=20 (gap)
      await market.write.lockMarket([marketId]);
      const data = await market.read.markets([marketId]);
      expect(data[8]).to.equal(4); // Locked
      expect(data[10]).to.equal(20n); // equilibrium=20
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

      // Market 2: pre-computed equilibrium (must match auto=40)
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

      // Auto lockMarket computes eq=40 (gap)
      await fixtures1.market.write.lockMarket([1n]);
      // Pre-computed must use same eq=40
      await fixtures2.market.write.lockMarketWithEquilibrium([1n, 40n]);

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

      // New formula: eq=50 (exact). eqAmt=150M. neg=150M(at 30), pos=150M(at 80).
      // pNeg=49, pPos=51. pos overweight. excess=5882353. pool=450M-5882353-150M=294117647.
      // fee=2941176. winnerPool=291176471.
      // Winner=bet(80). effective=150M-5882353=144117647. payout=291176471.
      const winnerBefore = await stakeToken.read.balanceOf([
        predictor3.account.address,
      ]);
      await market.write.claimWinnings([marketId], {
        account: predictor3.account,
      });
      const winnerAfter = await stakeToken.read.balanceOf([
        predictor3.account.address,
      ]);

      expect(winnerAfter - winnerBefore).to.equal(291176471n);
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

      // bet(0,$100) + bet(50,$100)
      // New formula: gap at g=1 has diff=100, same as all gaps up to g=49.
      // g=1 found first: neg=100(at 0, <=1), pos=100(at 50, >1).
      await market.write.placePrediction([marketId, 0n, toUSDC("100")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 50n, toUSDC("100")], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      const eq = await market.read.calculateEquilibrium([marketId]);
      expect(eq).to.equal(1n);

      await market.write.lockMarket([marketId]);
      const data = await market.read.markets([marketId]);
      expect(data[8]).to.equal(4); // Locked
      expect(data[10]).to.equal(1n);
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

    it("I3: bet at 0% and 100% — eq=1, full lifecycle with payouts", async function () {
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
      expect(data[10]).to.equal(1n); // equilibrium=1 (gap)

      // pNeg=1, pPos=2. left=2*100=200, right=1*100=100. pos overweight.
      // targetPos=floor(100*1/2)=50. excess=50.
      // predictor1 (neg, not overweight): refund=0
      // predictor2 (pos, overweight): refund=floor(100*50/100)=50
      const refund1 = await market.read.getLockRefundAmount([marketId, predictor1.account.address]);
      const refund2 = await market.read.getLockRefundAmount([marketId, predictor2.account.address]);
      expect(refund1).to.equal(0n);
      expect(refund2).to.equal(toUSDC("50"));

      // Resolve above eq: predictor2 (100%) wins
      await market.write.resolveMarket([marketId, true], { account: dealer1.account });

      // Pool=200M-50M=150M. fee=150M*100/10000=1500000. winnerPool=148500000.
      // predictor2 effective=50M. payout=148500000.
      const before = await stakeToken.read.balanceOf([predictor2.account.address]);
      await market.write.claimWinnings([marketId], { account: predictor2.account });
      const after = await stakeToken.read.balanceOf([predictor2.account.address]);
      expect(after - before).to.equal(148500000n);
    });

    it("I4: bet(0,$100) + bet(100,$300) — equilibrium=1", async function () {
      const { market, dealer1, predictor1, predictor2, stakeToken, marketId } =
        await setupMarket();

      // New formula: gap at g=1. neg=100(at 0), pos=300(at 100).
      // (2)*300=600 vs (1)*100=100. diff=500. Same diff at all g values.
      await market.write.placePrediction([marketId, 0n, toUSDC("100")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 100n, toUSDC("300")], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      const eq = await market.read.calculateEquilibrium([marketId]);
      expect(eq).to.equal(1n);

      await market.write.lockMarket([marketId]);

      // pNeg=1, pPos=2. left=600, right=100. pos overweight.
      // targetPos=floor(100*1/2)=50. excess=250.
      // predictor2 (pos): refund=floor(300*250/300)=250
      expect(await market.read.getLockRefundAmount([marketId, predictor1.account.address])).to.equal(0n);
      expect(await market.read.getLockRefundAmount([marketId, predictor2.account.address])).to.equal(toUSDC("250"));

      // Resolve above eq=1: predictor2 wins
      await market.write.resolveMarket([marketId, true], { account: dealer1.account });

      // Pool=400M-250M=150M. fee=1500000. winnerPool=148500000.
      // predictor2 effective=50M. payout=148500000.
      const before = await stakeToken.read.balanceOf([predictor2.account.address]);
      await market.write.claimWinnings([marketId], { account: predictor2.account });
      const after = await stakeToken.read.balanceOf([predictor2.account.address]);
      expect(after - before).to.equal(148500000n);
    });

    it("I5: bet(0,$300) + bet(100,$100) — equilibrium=1", async function () {
      const { market, dealer1, predictor1, predictor2, stakeToken, marketId } =
        await setupMarket();

      // New formula: gap at g=1. neg=300(at 0), pos=100(at 100).
      // (2)*100=200 vs (1)*300=300. neg overweight.
      // diff=100 (same at all gap values).
      await market.write.placePrediction([marketId, 0n, toUSDC("300")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 100n, toUSDC("100")], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      const eq = await market.read.calculateEquilibrium([marketId]);
      expect(eq).to.equal(1n);

      await market.write.lockMarket([marketId]);

      // pNeg=1, pPos=2. left=200, right=300. neg overweight.
      // targetNeg=floor(100*2/1)=200. excess=100.
      // predictor1 (neg): refund=floor(300*100/300)=100

      // Resolve below eq=1: predictor1 wins
      await market.write.resolveMarket([marketId, false], { account: dealer1.account });

      // Pool=400-100=300. fee=3. winnerPool=297.
      // predictor1 effective=300-100=200. payout=297.
      const before = await stakeToken.read.balanceOf([predictor1.account.address]);
      await market.write.claimWinnings([marketId], { account: predictor1.account });
      const after = await stakeToken.read.balanceOf([predictor1.account.address]);
      expect(after - before).to.equal(toUSDC("297"));
    });

    it("I6: bets at 0%, 50%, 100% — middle bettor gets full refund", async function () {
      const { market, dealer1, predictor1, predictor2, predictor3, stakeToken, marketId } =
        await setupMarket();

      // New formula: exact at p=50. neg=100(at 0), pos=100(at 100), eqAmt=100(at 50).
      // (51)*100=5100 vs (49)*100=4900. diff=200. Better than any gap (gap at g=1: diff=100 but
      // that's for gap; exact at 50 has diff=200 vs best gap diff=100... actually gap wins here).
      // Wait: gap at g=1 with all bets: neg=sum(0..1)=100, pos=sum(2..100)=200.
      // (2)*200=400 vs (1)*100=100. diff=300.
      // gap at g=49: neg=100(at 0), pos=200(50+100). (50)*200=10000 vs (49)*100=4900. diff=5100.
      // gap at g=50: neg=200(0+50), pos=100(100). (51)*100=5100 vs (50)*200=10000. diff=4900.
      // Best gap: g=1, diff=300. vs exact at 50: diff=200. Exact wins!
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

      // predictor2 at eq=50 (exact) gets full refund
      const refund = await market.read.getRefundAmount([marketId, predictor2.account.address]);
      expect(refund).to.equal(toUSDC("100"));

      const p2Before = await stakeToken.read.balanceOf([predictor2.account.address]);
      await market.write.claimRefund([marketId], { account: predictor2.account });
      const p2After = await stakeToken.read.balanceOf([predictor2.account.address]);
      expect(p2After - p2Before).to.equal(toUSDC("100"));

      // predictor3 (100%, above eq) wins.
      // pNeg=49, pPos=51. pos overweight. excess=3921569.
      // pool=300M-3921569-100M=196078431. fee=1960784. winnerPool=194117647.
      // effective(100)=100M-3921569=96078431. payout=194117647.
      const p3Before = await stakeToken.read.balanceOf([predictor3.account.address]);
      await market.write.claimWinnings([marketId], { account: predictor3.account });
      const p3After = await stakeToken.read.balanceOf([predictor3.account.address]);
      expect(p3After - p3Before).to.equal(194117647n);
    });

    it("I7: bets at 0%, 1%, 99%, 100% — equilibrium=1", async function () {
      const { market, dealer1, predictor1, predictor2, predictor3, dealer2, stakeToken, marketId } =
        await setupMarket();

      // All $100. New formula: gap at g=1.
      // neg=sum(0..1)=200, pos=sum(2..100)=200. (2)*200=400 vs (1)*200=200. diff=200.
      // Same diff at all g, so g=1 found first.
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
      expect(eq).to.equal(1n);

      await market.write.lockMarket([marketId]);

      // pNeg=1, pPos=2. left=2*200=400, right=1*200=200. pos overweight.
      // targetPos=floor(200*1/2)=100. excess=100. pool=300.

      // Resolve positive: above-side winners (99, 100) — pct > 1
      await market.write.resolveMarket([marketId, true], { account: dealer1.account });

      // Pool=300M, fee=3M, winnerPool=297M.
      // Each winner effective: 100M-50M=50M. totalWin=100M.
      // Each payout: 50M*297M/100M=148500000
      const p3Before = await stakeToken.read.balanceOf([predictor3.account.address]);
      await market.write.claimWinnings([marketId], { account: predictor3.account });
      const p3After = await stakeToken.read.balanceOf([predictor3.account.address]);
      expect(p3After - p3Before).to.equal(148500000n);

      const d2Before = await stakeToken.read.balanceOf([dealer2.account.address]);
      await market.write.claimWinnings([marketId], { account: dealer2.account });
      const d2After = await stakeToken.read.balanceOf([dealer2.account.address]);
      expect(d2After - d2Before).to.equal(148500000n);
    });

    it("I8: multiple bettors at 0% vs one at 100%", async function () {
      const { market, dealer1, predictor1, predictor2, predictor3, stakeToken, marketId } =
        await setupMarket();

      // bet(0,$150) + bet(0,$150) + bet(100,$300)
      // New formula: gap at g=1. neg=300(at 0), pos=300(at 100).
      // (2)*300=600 vs (1)*300=300. diff=300. Same at all g. g=1 found first.
      // pos overweight. targetPos=floor(300*1/2)=150. excess=150. pool=450.
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
      expect(data[10]).to.equal(1n);

      // Resolve below eq: predictors at 0% win
      await market.write.resolveMarket([marketId, false], { account: dealer1.account });

      // Pool=450M, fee=4500000, winnerPool=445500000. Two winners: 150M each.
      // Each gets 150M*445500000/300M = 222750000
      const p1Before = await stakeToken.read.balanceOf([predictor1.account.address]);
      await market.write.claimWinnings([marketId], { account: predictor1.account });
      const p1After = await stakeToken.read.balanceOf([predictor1.account.address]);
      expect(p1After - p1Before).to.equal(222750000n);

      const p2Before = await stakeToken.read.balanceOf([predictor2.account.address]);
      await market.write.claimWinnings([marketId], { account: predictor2.account });
      const p2After = await stakeToken.read.balanceOf([predictor2.account.address]);
      expect(p2After - p2Before).to.equal(222750000n);
    });
  });

  // ========== GROUP J: Mass Refund (n-1 same percentage, overweight) ==========

  describe("Mass refund (n-1 same percentage)", function () {
    it("J1: 3 below bettors refunded, below side wins", async function () {
      const { market, dealer1, dealer2, predictor1, predictor2, predictor3, stakeToken, marketId } =
        await setupMarket();

      // 3 at 20% ($150 each = $450) + 1 at 80% ($150). Force eq=50 (gap).
      // neg=450, pos=150. pNeg=50, pPos=51.
      // left=51*150=7650, right=50*450=22500. neg overweight.
      // targetNeg=floor(150*51/50)=153. excess=450-153=297.
      // Each below refund = floor(150*297/450) = $99.
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

      // All 3 below bettors get $99 lock refund each
      const r1 = await market.read.getLockRefundAmount([marketId, predictor1.account.address]);
      const r2 = await market.read.getLockRefundAmount([marketId, predictor2.account.address]);
      const r3 = await market.read.getLockRefundAmount([marketId, predictor3.account.address]);
      expect(r1).to.equal(toUSDC("99"));
      expect(r2).to.equal(toUSDC("99"));
      expect(r3).to.equal(toUSDC("99"));

      // Above bettor gets no lock refund
      expect(await market.read.getLockRefundAmount([marketId, dealer2.account.address])).to.equal(0n);

      // Claim lock refunds
      await market.write.claimLockRefund([marketId], { account: predictor1.account });
      await market.write.claimLockRefund([marketId], { account: predictor2.account });
      await market.write.claimLockRefund([marketId], { account: predictor3.account });

      // Resolve below eq → below wins
      await market.write.resolveMarket([marketId, false], { account: dealer1.account });

      // Pool=600M-297M=303M. fee=303M*100/10000=3030000. winnerPool=299970000.
      // Each effective=150M-99M=51M. totalWin=153M. Each payout=51M*299970000/153M=99990000.
      const p1Before = await stakeToken.read.balanceOf([predictor1.account.address]);
      await market.write.claimWinnings([marketId], { account: predictor1.account });
      const p1After = await stakeToken.read.balanceOf([predictor1.account.address]);
      expect(p1After - p1Before).to.equal(99990000n);
    });

    it("J2: 3 below bettors refunded, above side wins", async function () {
      const { market, dealer1, dealer2, predictor1, predictor2, predictor3, stakeToken, marketId } =
        await setupMarket();

      // Same setup: 3 at 20% ($150) + 1 at 80% ($150). Force eq=50 (gap).
      // neg=450, pos=150. neg overweight. excess=297. Each below refund=99.
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

      // Above bettor effective=150M (lighter side, no refund). totalWinning=150M.
      // Pool=303M, fee=3030000, winnerPool=299970000. Payout=150M*299970000/150M=299970000.
      const d2Before = await stakeToken.read.balanceOf([dealer2.account.address]);
      await market.write.claimWinnings([marketId], { account: dealer2.account });
      const d2After = await stakeToken.read.balanceOf([dealer2.account.address]);
      expect(d2After - d2Before).to.equal(299970000n);

      // Below bettors are losers, but can still claim lock refunds ($99 each)
      const p1Before = await stakeToken.read.balanceOf([predictor1.account.address]);
      await market.write.claimLockRefund([marketId], { account: predictor1.account });
      const p1After = await stakeToken.read.balanceOf([predictor1.account.address]);
      expect(p1After - p1Before).to.equal(toUSDC("99"));
    });

    it("J3: 3 above bettors refunded (mirrored)", async function () {
      const { market, dealer1, dealer2, predictor1, predictor2, predictor3, stakeToken, marketId } =
        await setupMarket();

      // 1 at 20% ($150) + 3 at 80% ($150 each = $450). Force eq=50 (gap).
      // neg=150, pos=450. pNeg=50, pPos=51. left=51*450=22950, right=50*150=7500.
      // pos overweight. targetPos=floor(150*50/51)=147. excess=303. Each above refund=floor(150*303/450)=101.
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

      // All 3 above bettors refunded: floor(150M*302941177/450M) = 100980392 each
      expect(await market.read.getLockRefundAmount([marketId, predictor2.account.address])).to.equal(100980392n);
      expect(await market.read.getLockRefundAmount([marketId, predictor3.account.address])).to.equal(100980392n);
      expect(await market.read.getLockRefundAmount([marketId, dealer2.account.address])).to.equal(100980392n);

      // Below bettor gets no lock refund
      expect(await market.read.getLockRefundAmount([marketId, predictor1.account.address])).to.equal(0n);

      // Resolve above eq → above wins
      await market.write.resolveMarket([marketId, true], { account: dealer1.account });

      // Pool=600M-302941177=297058823. fee=2970588. winnerPool=294088235.
      // Each effective=150M-100980392=49019608. totalWin=147058823 (from percentageTotals).
      // Each payout=49019608*294088235/147058823=98029412.
      const p2Before = await stakeToken.read.balanceOf([predictor2.account.address]);
      await market.write.claimWinnings([marketId], { account: predictor2.account });
      const p2After = await stakeToken.read.balanceOf([predictor2.account.address]);
      expect(p2After - p2Before).to.equal(98029412n);
    });
  });

  // ========== GROUP K: Complex Multi-Bettor Combinations ==========

  describe("Complex multi-bettor combinations", function () {
    it("K1: 4 bettors evenly spread — natural equilibrium=40", async function () {
      const { market, dealer1, dealer2, predictor1, predictor2, predictor3, stakeToken, marketId } =
        await setupMarket();

      // bet(20,$100) + bet(40,$100) + bet(60,$100) + bet(80,$100)
      // New formula: gap at g=40. neg=200(20+40), pos=200(60+80).
      // (41)*200=8200 vs (40)*200=8000. diff=200 (best).
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
      expect(eq).to.equal(40n);

      await market.write.lockMarket([marketId]);

      // pos overweight by 5. predictor1 (neg) no refund.
      expect(await market.read.getLockRefundAmount([marketId, predictor1.account.address])).to.equal(0n);

      // Resolve above eq=40: 2 winners (60, 80)
      await market.write.resolveMarket([marketId, true], { account: dealer1.account });

      // Pool=400M-4878049=395121951. fee=3951219. winnerPool=391170732.
      // Each winner effective: 100M-2439024=97560976. totalWin=195121952.
      // Each payout: 97560976*391170732/195121952=195585366.
      const p3Before = await stakeToken.read.balanceOf([predictor3.account.address]);
      await market.write.claimWinnings([marketId], { account: predictor3.account });
      const p3After = await stakeToken.read.balanceOf([predictor3.account.address]);
      expect(p3After - p3Before).to.equal(195585366n);

      // Losers at 20% and 40% get nothing
      const payout1 = await market.read.calculatePayout([marketId, predictor1.account.address]);
      expect(payout1).to.equal(0n);
      const payout2 = await market.read.calculatePayout([marketId, predictor2.account.address]);
      expect(payout2).to.equal(0n);
    });

    it("K2: many small bets vs one large bet with forced equilibrium", async function () {
      const { market, dealer1, predictor1, predictor2, predictor3, stakeToken, marketId } =
        await setupMarket();

      // bet(20,$50) + bet(30,$50) + bet(70,$300). Force eq=50 (gap).
      // neg=100(20+30), pos=300(70). pNeg=50, pPos=51.
      // left=51*300=15300, right=50*100=5000. pos overweight.
      // targetPos=floor(100*50/51)=98. excess=202. Refund for predictor3=floor(300*202/300)=$202.
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

      // Large bettor gets lock refund: floor(300M*201960785/300M)=201960785
      expect(await market.read.getLockRefundAmount([marketId, predictor3.account.address])).to.equal(201960785n);
      // Small bettors get nothing (lighter side)
      expect(await market.read.getLockRefundAmount([marketId, predictor1.account.address])).to.equal(0n);

      // Resolve above eq → predictor3 wins
      await market.write.resolveMarket([marketId, true], { account: dealer1.account });

      // Pool=400M-201960785=198039215. fee=1980392. winnerPool=196058823.
      // predictor3 effective=300M-201960785=98039215. payout=196058823.
      const p3Before = await stakeToken.read.balanceOf([predictor3.account.address]);
      await market.write.claimWinnings([marketId], { account: predictor3.account });
      const p3After = await stakeToken.read.balanceOf([predictor3.account.address]);
      expect(p3After - p3Before).to.equal(196058823n);
    });

    it("K3: boundaries + equilibrium bettor + lock refund combined", async function () {
      const { market, dealer1, dealer2, predictor1, predictor2, predictor3, stakeToken, marketId } =
        await setupMarket();

      // bet(0,$100) + bet(25,$100) + bet(50,$100) + bet(75,$100). Force eq=50.
      // isExact: bets at 50=100, neg(0+25)=200>0, pos(75)=100>0. Exact!
      // neg=200(0+25), pos=100(75). pNeg=49, pPos=51.
      // left=51*100=5100, right=49*200=9800. neg overweight.
      // targetNeg=floor(100*51/49)=104. excess=200-104=96.
      // predictor1 refund=floor(100*96/200)=$48. predictor2 refund=$48.
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

      // Below bettors get lock refund: floor(100M*95918368/200M) = 47959184 each
      expect(await market.read.getLockRefundAmount([marketId, predictor1.account.address])).to.equal(47959184n);
      expect(await market.read.getLockRefundAmount([marketId, predictor2.account.address])).to.equal(47959184n);
      // Equilibrium bettor: no lock refund (gets full refund via claimRefund)
      expect(await market.read.getLockRefundAmount([marketId, predictor3.account.address])).to.equal(0n);
      // Above bettor: no lock refund (lighter side)
      expect(await market.read.getLockRefundAmount([marketId, dealer2.account.address])).to.equal(0n);

      // Resolve above eq → dealer2 (75%) wins
      await market.write.resolveMarket([marketId, true], { account: dealer1.account });

      // Pool=400M-95918368-100M=204081632. fee=2040816. winnerPool=202040816.
      const d2Before = await stakeToken.read.balanceOf([dealer2.account.address]);
      await market.write.claimWinnings([marketId], { account: dealer2.account });
      const d2After = await stakeToken.read.balanceOf([dealer2.account.address]);
      expect(d2After - d2Before).to.equal(202040816n);

      // Equilibrium bettor gets full $100 refund
      const p3Before = await stakeToken.read.balanceOf([predictor3.account.address]);
      await market.write.claimRefund([marketId], { account: predictor3.account });
      const p3After = await stakeToken.read.balanceOf([predictor3.account.address]);
      expect(p3After - p3Before).to.equal(toUSDC("100"));

      // Below bettors can claim lock refund (losers, but still get partial back)
      const p1Before = await stakeToken.read.balanceOf([predictor1.account.address]);
      await market.write.claimLockRefund([marketId], { account: predictor1.account });
      const p1After = await stakeToken.read.balanceOf([predictor1.account.address]);
      expect(p1After - p1Before).to.equal(47959184n);
    });

    it("K4: conservation of value — all payouts + refunds + fees = total pool", async function () {
      const { market, dealer1, predictor1, predictor2, predictor3, stakeToken, owner, marketId } =
        await setupMarket();

      // bet(20,$200) + bet(50,$100) + bet(80,$200). Force eq=50.
      // isExact: bets at 50=100, neg(20)=200>0, pos(80)=200>0. Exact!
      // neg=200, pos=200. pNeg=49, pPos=51.
      // left=51*200=10200, right=49*200=9800. pos overweight.
      // targetPos=floor(200*49/51)=192. excess=8. eqAmt=100.
      // pool=500-8-100=392. fee=3(dealer=1,sys=2). winnerPool=389.
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
      // Winner: predictor3 (80%, above eq). effective=200-8=192. payout=389.
      const winnerBefore = await stakeToken.read.balanceOf([predictor3.account.address]);
      await market.write.claimWinnings([marketId], { account: predictor3.account });
      const winnerAfter = await stakeToken.read.balanceOf([predictor3.account.address]);
      const winnerPayout = winnerAfter - winnerBefore;

      // Lock refund for predictor3 (pos, overweight): 8
      const lockBefore = await stakeToken.read.balanceOf([predictor3.account.address]);
      await market.write.claimLockRefund([marketId], { account: predictor3.account });
      const lockAfter = await stakeToken.read.balanceOf([predictor3.account.address]);
      const lockRefund = lockAfter - lockBefore;

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

      // Total out = winnerPayout + lockRefund + eqRefund + dealerFee + systemFee
      // Loser (predictor1) gets nothing. Total pool was 500.
      const totalOut = winnerPayout + lockRefund + eqRefund + dealerFee + systemFee;
      expect(totalOut).to.equal(toUSDC("500"));
    });

    it("K5: 4 bettors at 0%, 0%, 100%, 100% — two winners split", async function () {
      const { market, dealer1, dealer2, predictor1, predictor2, predictor3, stakeToken, marketId } =
        await setupMarket();

      // New formula: gap at g=1. neg=200(0+0), pos=200(100+100).
      // (2)*200=400 vs (1)*200=200. pos overweight.
      // targetPos=floor(200*1/2)=100. excess=100. pool=300.
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
      expect(data[10]).to.equal(1n);

      // Resolve above: 100% bettors win
      await market.write.resolveMarket([marketId, true], { account: dealer1.account });

      // Pool=300M, fee=3M, winnerPool=297M.
      // Each winner effective=100M-50M=50M. totalWin=100M.
      // Each payout: 50M*297M/100M=148500000.
      const p3Before = await stakeToken.read.balanceOf([predictor3.account.address]);
      await market.write.claimWinnings([marketId], { account: predictor3.account });
      const p3After = await stakeToken.read.balanceOf([predictor3.account.address]);
      expect(p3After - p3Before).to.equal(148500000n);

      const d2Before = await stakeToken.read.balanceOf([dealer2.account.address]);
      await market.write.claimWinnings([marketId], { account: dealer2.account });
      const d2After = await stakeToken.read.balanceOf([dealer2.account.address]);
      expect(d2After - d2Before).to.equal(148500000n);
    });

    it("K6: unequal amounts at 0% and 100% — asymmetric equilibrium", async function () {
      const { market, dealer1, predictor1, predictor2, marketId } =
        await setupMarket();

      // bet(0,$500) + bet(100,$100). New formula: gap at g=1.
      // neg=500(at 0), pos=100(at 100). (2)*100=200 vs (1)*500=500. diff=300.
      // Same diff at all g. g=1 found first.
      await market.write.placePrediction([marketId, 0n, toUSDC("500")], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 100n, toUSDC("100")], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      const eq = await market.read.calculateEquilibrium([marketId]);
      expect(eq).to.equal(1n);

      await market.write.lockMarket([marketId]);

      // pNeg=1, pPos=2. left=200, right=500. neg overweight.
      // targetNeg=floor(100*2/1)=200. excess=300.
      // predictor1 (neg, overweight): refund=floor(500*300/500)=300
      const refund1 = await market.read.getLockRefundAmount([marketId, predictor1.account.address]);
      expect(refund1 > 0n).to.be.true;
      // predictor2 (pos, not overweight): no refund
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
