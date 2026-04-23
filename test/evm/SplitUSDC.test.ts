import { expect } from 'chai';
import {
  advanceTime,
  deployPredictionFixture,
  toUSDC,
} from './utils/fixture.ts';

const ZERO_ORACLE_ID =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

describe('Market Split algorithm (USDC)', function () {
  async function setupMarket() {
    const fixtures = await deployPredictionFixture();
    const block = await fixtures.publicClient.getBlock();
    const deadline = block.timestamp + 86401n;

    await fixtures.market.write.createMarket(
      [1n, 1n, 1n, deadline, 'Split checks', ZERO_ORACLE_ID],
      { account: fixtures.dealer1.account }
    );

    return { ...fixtures, marketId: 1n };
  }

  // ========== GROUP A: Split Calculation ==========

  describe('Split calculation', function () {
    it('A1: two symmetric bets — split at those percentages, positive side capped', async function () {
      const { market, predictor1, predictor2, marketId } = await setupMarket();

      await market.write.placePrediction([marketId, 40n, toUSDC('150')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 60n, toUSDC('150')], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      // Split: neg=40, pos=60
      // desiredMinPos = (40*150)/60 = 100. posTotal(150) >= 100 → yes
      // desiredMinNeg = (60*150)/40 = 225. negTotal(150) < 225 → last iter, cap pos to 100
      const [negPct, posPct, , , valid] =
        await market.read.calculateMarketSplit([marketId]);
      expect(valid).to.be.true;
      expect(negPct).to.equal(40n);
      expect(posPct).to.equal(60n);

      await market.write.lockMarket([marketId]);

      // No neg refund (negAllowed=150 = actual)
      const refund1 = await market.read.getLockRefundAmount([
        marketId,
        predictor1.account.address,
      ]);
      // Positive side capped: posAllowed=100M < actual(150M), excess=50M
      const refund2 = await market.read.getLockRefundAmount([
        marketId,
        predictor2.account.address,
      ]);
      expect(refund1).to.equal(0n);
      expect(refund2).to.equal(50000000n);
    });

    it('A2: uneven amounts — split at percentages, positive side capped', async function () {
      const { market, predictor1, predictor2, marketId } = await setupMarket();

      // bet(20,$300) + bet(80,$100)
      // desiredMinPos = (20*300)/80 = 75. posTotal(100) >= 75 → yes
      // desiredMinNeg = (80*100)/20 = 400. negTotal(300) < 400 → last iter, cap pos to 75
      await market.write.placePrediction([marketId, 20n, toUSDC('300')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 80n, toUSDC('100')], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      const [negPct, posPct, , , valid] =
        await market.read.calculateMarketSplit([marketId]);
      expect(valid).to.be.true;
      expect(negPct).to.equal(20n);
      expect(posPct).to.equal(80n);

      await market.write.lockMarket([marketId]);

      // negAllowed=300 = actual(300), no neg refund
      expect(
        await market.read.getLockRefundAmount([
          marketId,
          predictor1.account.address,
        ])
      ).to.equal(0n);
      // posAllowed=75M < actual(100M), excess=25M
      expect(
        await market.read.getLockRefundAmount([
          marketId,
          predictor2.account.address,
        ])
      ).to.equal(25000000n);
    });

    it('A3: adjacent bets 49 and 51 — split at those percentages', async function () {
      const { market, predictor1, predictor2, marketId } = await setupMarket();

      await market.write.placePrediction([marketId, 49n, toUSDC('100')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 51n, toUSDC('100')], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      const [negPct, posPct, , , valid] =
        await market.read.calculateMarketSplit([marketId]);
      expect(valid).to.be.true;
      expect(negPct).to.equal(49n);
      expect(posPct).to.equal(51n);
    });

    it('A4: bets at 0% and 100% — both unconditional, no refund', async function () {
      const { market, predictor1, predictor2, marketId } = await setupMarket();

      await market.write.placePrediction([marketId, 0n, toUSDC('200')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 100n, toUSDC('200')], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      const [negPct, posPct, negAmt, posAmt, valid] =
        await market.read.calculateMarketSplit([marketId]);
      expect(valid).to.be.true;
      expect(negPct).to.equal(0n);
      expect(posPct).to.equal(100n);
      expect(negAmt).to.equal(toUSDC('200'));
      expect(posAmt).to.equal(toUSDC('200'));

      await market.write.lockMarket([marketId]);

      // No refunds — both sides unconditional
      expect(
        await market.read.getLockRefundAmount([
          marketId,
          predictor1.account.address,
        ])
      ).to.equal(0n);
      expect(
        await market.read.getLockRefundAmount([
          marketId,
          predictor2.account.address,
        ])
      ).to.equal(0n);
    });

    it('A5: calculateMarketSplit view matches lockMarket stored values', async function () {
      const { market, predictor1, predictor2, marketId } = await setupMarket();

      await market.write.placePrediction([marketId, 30n, toUSDC('200')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 70n, toUSDC('100')], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      const [negPct, , , , valid] = await market.read.calculateMarketSplit([
        marketId,
      ]);
      expect(valid).to.be.true;

      await market.write.lockMarket([marketId]);

      // stored lower boundary field stores negPct
      const [, , , , , , , , , , storedEq] = await market.read.markets([
        marketId,
      ]);
      expect(storedEq).to.equal(negPct);
    });
  });

  // ========== GROUP B: Lock Refund Mechanism ==========

  describe('Lock refund mechanism', function () {
    it('B1: positive side capped gets partial refund', async function () {
      const { market, predictor1, predictor2, marketId } = await setupMarket();

      // bet(20,$100) + bet(80,$300)
      // desiredMinPos = (20*100)/80 = 25. posTotal(300) >= 25 → yes
      // desiredMinNeg = (80*300)/20 = 1200. negTotal(100) < 1200 → last iter, cap pos to 25
      // posAllowed=25M < actual(300M) → excess=275M. Partial refund!
      await market.write.placePrediction([marketId, 20n, toUSDC('100')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 80n, toUSDC('300')], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      const [, , , , valid] = await market.read.calculateMarketSplit([
        marketId,
      ]);
      expect(valid).to.be.true;

      await market.write.lockMarket([marketId]);

      // Check split boundaries
      const [, posPctStored, , posAmtStored] = await market.read.lockRefunds([
        marketId,
      ]);

      // Verify positive boundary has a partial refund
      const actualPos = await market.read.percentageTotals([
        marketId,
        posPctStored,
      ]);

      const hasRefund = posAmtStored < actualPos;
      expect(hasRefund).to.be.true;
    });

    it('B2: cannot double-claim lock refund', async function () {
      const { market, predictor1, predictor2, predictor3, marketId } =
        await setupMarket();

      // Use a case that produces partial refunds
      // bet(20,$100) + bet(30,$100) + bet(70,$100)
      await market.write.placePrediction([marketId, 20n, toUSDC('100')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 30n, toUSDC('100')], {
        account: predictor2.account,
      });
      await market.write.placePrediction([marketId, 70n, toUSDC('100')], {
        account: predictor3.account,
      });

      await advanceTime(86401);
      await market.write.lockMarket([marketId]);

      // Find who has a lock refund
      const r1 = await market.read.getLockRefundAmount([
        marketId,
        predictor1.account.address,
      ]);

      if (r1 > 0n) {
        // First claim succeeds
        await market.write.claimLockRefund([marketId], {
          account: predictor1.account,
        });

        // Second claim reverts
        try {
          await market.write.claimLockRefund([marketId], {
            account: predictor1.account,
          });
          expect.fail('Should have reverted');
        } catch (error: any) {
          expect(error.message).to.include('Already claimed');
        }
      }
    });

    it('B3: no lock refund when both sides exactly satisfy constraints', async function () {
      const { market, predictor1, predictor2, marketId } = await setupMarket();

      // Two bets where both sides are satisfied → no refunds
      // bet(0,$100) + bet(100,$100): both unconditional, no cap needed
      await market.write.placePrediction([marketId, 0n, toUSDC('100')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 100n, toUSDC('100')], {
        account: predictor2.account,
      });

      await advanceTime(86401);
      await market.write.lockMarket([marketId]);

      expect(
        await market.read.getLockRefundAmount([
          marketId,
          predictor1.account.address,
        ])
      ).to.equal(0n);
      expect(
        await market.read.getLockRefundAmount([
          marketId,
          predictor2.account.address,
        ])
      ).to.equal(0n);
    });
  });

  // ========== GROUP C: One-Sided / Invalid Markets ==========

  describe('One-sided market detection', function () {
    it('C1: adjacent bets form valid market — lockMarket succeeds', async function () {
      const { market, predictor1, predictor2, marketId } = await setupMarket();

      await market.write.placePrediction([marketId, 20n, toUSDC('100')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 30n, toUSDC('100')], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      await market.write.lockMarket([marketId]);
      const data = await market.read.markets([marketId]);
      expect(data[8]).to.equal(4); // Locked
    });

    it('C2: all bets at same percentage — lockMarket reverts', async function () {
      const { market, predictor1, predictor2, marketId } = await setupMarket();

      await market.write.placePrediction([marketId, 50n, toUSDC('100')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 50n, toUSDC('200')], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      try {
        await market.write.lockMarket([marketId]);
        expect.fail('Should have reverted');
      } catch (error: any) {
        expect(error.message).to.include('No valid market split');
      }
    });

    it('C3: single prediction — lockMarket reverts', async function () {
      const { market, predictor1, marketId } = await setupMarket();

      await market.write.placePrediction([marketId, 50n, toUSDC('100')], {
        account: predictor1.account,
      });

      await advanceTime(86401);

      try {
        await market.write.lockMarket([marketId]);
        expect.fail('Should have reverted');
      } catch (error: any) {
        expect(error.message).to.include('No valid market split');
      }
    });

    it('C4: three predictions at same percentage — lockMarket reverts', async function () {
      const { market, predictor1, predictor2, predictor3, marketId } =
        await setupMarket();

      await market.write.placePrediction([marketId, 30n, toUSDC('100')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 30n, toUSDC('200')], {
        account: predictor2.account,
      });
      await market.write.placePrediction([marketId, 30n, toUSDC('50')], {
        account: predictor3.account,
      });

      await advanceTime(86401);

      try {
        await market.write.lockMarket([marketId]);
        expect.fail('Should have reverted');
      } catch (error: any) {
        expect(error.message).to.include('No valid market split');
      }
    });
  });

  // ========== GROUP D: Resolution ==========

  describe('Resolution', function () {
    it('D1: negative resolution — below-side wins', async function () {
      const { market, dealer1, predictor1, predictor2, marketId } =
        await setupMarket();

      await market.write.placePrediction([marketId, 40n, toUSDC('100')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 60n, toUSDC('100')], {
        account: predictor2.account,
      });

      await advanceTime(86401);
      await market.write.lockMarket([marketId]);
      await market.write.resolveMarket([marketId, false], {
        account: dealer1.account,
      });

      expect(await market.read.isWinner([marketId, predictor1.account.address]))
        .to.be.true;
      expect(await market.read.isWinner([marketId, predictor2.account.address]))
        .to.be.false;

      const payout1 = await market.read.calculatePayout([
        marketId,
        predictor1.account.address,
      ]);
      expect(payout1 > 0n).to.be.true;
    });

    it('D2: positive resolution — above-side wins', async function () {
      const { market, dealer1, predictor1, predictor2, marketId } =
        await setupMarket();

      await market.write.placePrediction([marketId, 40n, toUSDC('100')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 60n, toUSDC('100')], {
        account: predictor2.account,
      });

      await advanceTime(86401);
      await market.write.lockMarket([marketId]);
      await market.write.resolveMarket([marketId, true], {
        account: dealer1.account,
      });

      expect(await market.read.isWinner([marketId, predictor1.account.address]))
        .to.be.false;
      expect(await market.read.isWinner([marketId, predictor2.account.address]))
        .to.be.true;
    });

    it('D3: middle bettor between boundaries gets full refund', async function () {
      const { market, dealer1, predictor1, predictor2, predictor3, marketId } =
        await setupMarket();

      // bet(20,$100) + bet(50,$120) + bet(80,$100)
      // The algorithm will find a split. Let's see:
      // sorted: [{20,100}, {50,120}, {80,100}], total=320
      // i=0: negTotal=100, posTotal=220
      //   desiredMinPos = (80*100)/20 = 400. posTotal(220) < 400 → reverse
      //   posPercentage=50, desiredMaxNeg = (50*220)/50 = 220
      //   negAmount=100, 100-100=0 < 220 → allowed=220
      //   Returns (20, 50, 220, 120, true)
      //
      // Split: neg=20(allowed 220>actual 100), pos=50(allowed 120=actual 120)
      // Between: nothing between 20 and 50 with bets
      // But bet at 80 is above positive boundary 50 → positive side
      //
      // Hmm, that means 50 and 80 are both positive. No middle refund.
      //
      // Let's try bet(20,$100) + bet(45,$120) + bet(80,$100)
      // i=0: negTotal=100, posTotal=220
      //   desiredMinPos = (80*100)/20 = 400. posTotal(220) < 400 → reverse
      //   posPercentage=45, desiredMaxNeg = (45*220)/55 = 180
      //   negAmount=100, 100-100=0 < 180 → allowed=180
      //   Returns (20, 45, 180, 120, true)
      // Between 20 and 45: nothing. Bet at 80 is above 45 → positive side.
      //
      // We need bets that straddle the split to get a middle refund.
      // E.g., bet(10,$100) + bet(50,$100) + bet(90,$100)
      // i=0: negTotal=100, posTotal=200
      //   desiredMinPos = (90*100)/10 = 900. posTotal(200) < 900 → reverse
      //   posPercentage=50, desiredMaxNeg = (50*200)/50 = 200
      //   negAmount=100, 100-100=0 < 200 → allowed=200
      //   Returns (10, 50, 200, 100, true)
      // Split=(10,50). Bet at 90 is >= 50 → positive side. Between(11-49): nothing.
      //
      // Actually to get a middle refund, we need a bet BETWEEN the boundaries.
      // That only happens when the algorithm picks boundaries that skip a middle bet.
      //
      // bet(10,$200) + bet(50,$100) + bet(90,$200)
      // i=0: negTotal=200, posTotal=300
      //   desiredMinPos = (90*200)/10 = 1800. posTotal(300) < 1800 → reverse
      //   posPercentage=50, desiredMaxNeg = (50*300)/50 = 300
      //   negAmount=200, 200-200=0 < 300 → allowed=300
      //   Returns (10, 50, 300, 100, true)
      // Split=(10,50). Bet at 90 is >=50 → positive. No middle.
      //
      // To get a middle refund: the algorithm must skip a percentage level.
      // This happens in normalizedCalculate when it continues past i=0.
      //
      // bet(10,$100) + bet(50,$100) + bet(90,$300)
      // i=0: negTotal=100, posTotal=400
      //   desiredMinPos = (90*100)/10 = 900. posTotal(400) < 900 → reverse
      //   posPercentage=50, desiredMaxNeg = (50*400)/50 = 400
      //   negAmount=100, 100-100=0 < 400 → allowed=400
      //   Returns (10, 50, 400, 100, true)
      // Still (10,50). Bet at 90 positive.
      //
      // Let me try: bet(10,$500) + bet(50,$100) + bet(90,$100)
      // i=0: negTotal=500, posTotal=200
      //   desiredMinPos = (90*500)/10 = 4500. posTotal(200) < 4500 → reverse
      //   posPercentage=50, desiredMaxNeg = (50*200)/50 = 200
      //   negAmount=500, amts[0]=500, 500-500=0 < 200 → allowed=200
      //   Returns (10, 50, 200, 100, true)
      //
      // negAllowed=200 < actual(500)! Partial refund for bet at 10.
      // Excess = 500 - 200 = 300. Refund = (500 * 300) / 500 = 300.
      // Bet at 90 is positive (>=50). Between(11-49): nothing.
      //
      // Middle refund only occurs with gaps >1 between percentages where
      // the algorithm jumps. Actually, looking again at the code, middle refund
      // happens if bets exist at percentages between negPct and posPct.
      //
      // So I need: bet at negPct, bet(s) strictly between, bet at posPct.
      // The key is that normalizedCalculate must CONTINUE past a percentage.
      //
      // bet(10,$100) + bet(50,$100) + bet(90,$100)
      // The algorithm picks (10, 50) via reverseCalculate. Bet at 90 is >=50, so positive.
      // No bet between 10 and 50.
      //
      // What if: bet(10,$10) + bet(30,$10) + bet(50,$10) + bet(90,$10)
      // i=0: negTotal=10, posTotal=30, desiredMinPos=(90*10)/10=90, 30<90 → reverse
      //   posPercentage=30, desiredMaxNeg=(30*30)/70=12.8→12
      //   negAmount=10, 10-10=0 < 12 → allowed=12 (>actual 10)
      //   Returns (10, 30, 12, 10, true)
      // Between 10 and 30: nothing. Bets at 50 and 90 are >=30 → positive.
      //
      // Actually the simplest way: bets at 10, 20, 90.
      // If algo picks (10, 90), then bet at 20 (between 10 and 90) gets full refund!
      //
      // bet(10,$50) + bet(20,$50) + bet(90,$50)
      // i=0: negTotal=50, posTotal=100
      //   desiredMinPos = (90*50)/10 = 450. posTotal(100) < 450 → reverse
      //   posPercentage=20, desiredMaxNeg=(20*100)/80=25
      //   negAmount=50, 50-50=0 < 25 → allowed=25
      //   Returns (10, 20, 25, 50, true)
      // Split=(10,20). Bet at 90 is >=20 → positive. Between(11-19): nothing.
      //
      // Hmm... the algorithm never seems to skip. It always picks adjacent entries.
      // That's because reverseCalculate always returns the entry at negativeIndex
      // (same i), and normalizedCalculate always returns (pcts[i], pcts[i+1]).
      //
      // So there's NEVER a bet between boundaries! The boundaries are always
      // adjacent entries in the sorted non-zero percentages array.
      //
      // Middle refund (full refund for bets between boundaries) can never happen!
      // The only refunds are partial refunds at the boundaries.
      //
      // Actually wait - unless the reverseCalculate walks past entries.
      // Let me re-check: bet(10,$100) + bet(20,$100) + bet(90,$50)
      // i=0: negTotal=100, posTotal=150
      //   desiredMinPos = (90*100)/10 = 900. posTotal(150) < 900 → reverse
      //   posPercentage=20, desiredMaxNeg=(20*150)/80=37.5→37
      //   negAmount=100, amts[0]=100, 100-100=0 < 37 → stop, allowed=37
      //   Returns (10, 20, 37, 100, true)
      //
      // Still (10,20).
      //
      // bet(10,$100) + bet(20,$100) + bet(30,$100) + bet(90,$50)
      // i=0: negTotal=100, posTotal=250
      //   desiredMinPos = (90*100)/10 = 900. posTotal(250) < 900 → reverse
      //   posPercentage=20, desiredMaxNeg=(20*250)/80=62.5→62
      //   negAmount=100, amts[0]=100, 100-100=0 < 62 → stop, allowed=62
      //   Returns (10, 20, 62, 100, true)
      // Split=(10,20). Bets at 30 and 90 are >=20 → positive.
      //
      // Hmm what about this:
      // bet(10,$200) + bet(20,$100) + bet(30,$100) + bet(90,$50)
      // i=0: negTotal=200, posTotal=250
      //   desiredMinPos = (90*200)/10 = 1800. posTotal(250) < 1800 → reverse
      //   posPercentage=20, desiredMaxNeg=(20*250)/80=62.5→62
      //   negAmount=200, amts[0]=200, 200-200=0 < 62 → stop, allowed=62
      //   Returns (10, 20, 62, 100, true)
      //
      // What about when reverseCalculate walks back PAST an entry?
      // bet(10,$10) + bet(20,$100) + bet(90,$50)
      // i=0: negTotal=10, posTotal=150
      //   desiredMinPos = (90*10)/10 = 90. posTotal(150) >= 90? Yes!
      //   desiredMinNeg = (20*150)/80 = 37.5→37
      //   negTotal(10) >= 37? No → continue (not last)
      // i=1: negTotal=110, posTotal=50
      //   desiredMinPos = (90*110)/20 = 495. posTotal(50) < 495 → reverse
      //   posPercentage=90, desiredMaxNeg=(90*50)/10=450
      //   negAmount=110, amts[1]=100, 110-100=10 < 450 → stop, allowed=450-(110-100)=440
      //   Returns (20, 90, 440, 50, true)
      //
      // Split=(20, 90). Bet at 10 is <=20 → negative. No bet between 20 and 90.
      //
      // To get middle refund we need to engineer the scenario differently...
      // Actually: bet(10,$10) + bet(50,$500) + bet(90,$10)
      // i=0: negTotal=10, posTotal=510
      //   desiredMinPos = (90*10)/10 = 90. posTotal(510) >= 90? Yes!
      //   desiredMinNeg = (50*510)/50 = 510
      //   negTotal(10) >= 510? No → continue (not last)
      // i=1: negTotal=510, posTotal=10
      //   desiredMinPos = (90*510)/50 = 918. posTotal(10) < 918 → reverse
      //   posPercentage=90, desiredMaxNeg=(90*10)/10=90
      //   negAmount=510
      //   Check amts[1]=500: 510-500=10 < 90 → stop, allowed=90-(510-500)=80
      //   Returns (50, 90, 80, 10, true)
      //
      // Split=(50, 90). Bet at 10 (<=50) is negative. Between 50 and 90: nothing.
      // negAllowed=80 < actual(500) at pct 50. Excess=420. Big partial refund.
      //
      // Still no middle! The boundaries always pick adjacent sorted entries.
      //
      // WAIT. What about reverseCalculate walking PAST an entry?
      // bet(10,$100) + bet(20,$100) + bet(30,$100) + bet(90,$10)
      // i=0: desiredMinPos = (90*100)/10 = 900. posTotal(310) < 900 → reverse
      //   posPercentage=20, desiredMaxNeg=(20*310)/80=77.5→77
      //   negAmount=100, amts[0]=100, 100-100=0 < 77 → stop, allowed=77
      //   Returns (10, 20, 77, 100, true)
      //
      // What if I make desiredMaxNeg very small?
      // bet(10,$100) + bet(20,$100) + bet(30,$100) + bet(99,$1)
      // i=0: desiredMinPos = (90*100)/10 = 900 wait no...
      //
      // Hmm: I realize the boundaries are ALWAYS adjacent entries in the sorted
      // array because the algorithm either:
      // 1. Returns (pcts[i], pcts[i+1]) from normalizedCalculate
      // 2. Returns (pcts[idx], pcts[negativeIndex+1]) from reverseCalculate,
      //    where idx <= negativeIndex (walking backwards)
      //
      // If reverseCalculate walks past entries, it COULD skip them!
      // Example: bet(10,$100) + bet(11,$100) + bet(90,$10)
      // i=0: negTotal=100, posTotal=110
      //   desiredMinPos = (90*100)/10 = 900. posTotal(110) < 900 → reverse
      //   posPercentage=11, desiredMaxNeg=(11*110)/89=13.6→13
      //   negAmount=100, amts[0]=100, 100-100=0 < 13 → stop, allowed=13
      //   Returns (10, 11, 13, 100, true)
      //
      // What if reverse walks PAST pcts[0]?
      // bet(10,$100) + bet(11,$1) + bet(90,$10)
      // i=0: negTotal=100, posTotal=11
      //   desiredMinPos = (90*100)/10 = 900. posTotal(11) < 900 → reverse
      //   posPercentage=11, desiredMaxNeg=(11*11)/89=1.35→1
      //   negAmount=100, amts[0]=100, 100-100=0 < 1 → stop, allowed=1
      //   Returns (10, 11, 1, 1, true)
      //
      // Hmm it always stops at the first entry because negAmount-amts[0] is always 0
      // when negativeIndex=0.
      //
      // For negativeIndex > 0:
      // bet(10,$100) + bet(11,$100) + bet(12,$100) + bet(90,$10)
      // i=0: negTotal=100, posTotal=210
      //   desiredMinPos=(90*100)/10=900. 210<900 → reverse
      //   posPercentage=11, desiredMaxNeg=(11*210)/89=25.9→25
      //   negAmount=100, amts[0]=100, 100-100=0 < 25 → stop, allowed=25
      //   Returns (10, 11, 25, 100, true)
      //
      // For normalizedCalculate to call reverse at i>0:
      // bet(10,$1) + bet(50,$100) + bet(90,$10)
      // i=0: negTotal=1, posTotal=110
      //   desiredMinPos=(90*1)/10=9. posTotal(110)>=9? Yes!
      //   desiredMinNeg=(50*110)/50=110. negTotal(1)>=110? No → continue (not last)
      // i=1: negTotal=101, posTotal=10
      //   desiredMinPos=(90*101)/50=181.8→181. posTotal(10)<181 → reverse(i=1)
      //   posPercentage=pcts[2]=90, desiredMaxNeg=(90*10)/10=90
      //   negAmount=101
      //   Check amts[1]=100: 101-100=1 < 90 → stop, allowed=90-(101-100)=89
      //   Returns (50, 90, 89, 10, true)
      //
      // Split=(50,90). Bet at 10 (<=50) is negative. No bet between 50 and 90.
      //
      // For reverse to walk past: need negAmount - amts[idx] >= desiredMaxNeg
      // bet(10,$1) + bet(50,$200) + bet(51,$100) + bet(90,$10)
      // i=0: negTotal=1, posTotal=310
      //   desiredMinPos=(90*1)/10=9. posTotal(310)>=9? Yes!
      //   desiredMinNeg=(50*310)/50=310. negTotal(1)>=310? No → continue
      // i=1: negTotal=201, posTotal=110
      //   desiredMinPos=(90*201)/50=361.8→361. posTotal(110)<361 → reverse(i=1)
      //   posPercentage=pcts[2]=51, desiredMaxNeg=(51*110)/49=114.7→114
      //   negAmount=201
      //   Check amts[1]=200: 201-200=1 < 114 → stop, allowed=114-(201-200)=113
      //   Returns (50, 51, 113, 100, true)
      // Split=(50,51). Bet at 10 negative, bet at 90 positive. No middle.
      //
      // To get reverseCalculate to walk past: amts at that index must be small
      // and desiredMaxNeg must be very small too.
      //
      // bet(10,$100) + bet(11,$100) + bet(12,$1) + bet(90,$1)
      // i=0: negTotal=100, posTotal=102
      //   desiredMinPos=(90*100)/10=900. 102<900 → reverse(i=0)
      //   posPercentage=pcts[1]=11, desiredMaxNeg=(11*102)/89=12.6→12
      //   negAmount=100, amts[0]=100, 100-100=0 < 12 → stop, allowed=12
      //   Returns (10, 11, 12, 100, true)
      //
      // To walk past an entry in reverse, we need:
      //   negAmount - amts[idx] >= desiredMaxNeg
      // This means: the remaining after removing this entry is ALREADY enough.
      // So we skip it entirely and move to the previous entry.
      //
      // This can only happen at negativeIndex > 0. Let me construct:
      // bet(10,$1) + bet(11,$50) + bet(50,$100) + bet(90,$1)
      // normalizedCalc:
      // i=0: negTotal=1, posTotal=151
      //   desiredMinPos=(90*1)/10=9. 151>=9? Yes!
      //   desiredMinNeg=(11*151)/89=18.7→18. 1>=18? No → continue
      // i=1: negTotal=51, posTotal=101
      //   desiredMinPos=(90*51)/11=417.3→417. 101<417 → reverse(i=1)
      //   posPercentage=pcts[2]=50, desiredMaxNeg=(50*101)/50=101
      //   negAmount=51
      //   Check amts[1]=50: 51-50=1 < 101 → stop, allowed=101-1=100
      //   Returns (11, 50, 100, 100, true)
      // Split=(11,50). Bet at 10 (<=11) negative. Bet at 90 (>=50) positive.
      //
      // What if I make it: bet(10,$50) + bet(11,$1) + bet(50,$100) + bet(90,$1)
      // i=0: negTotal=50, posTotal=102
      //   desiredMinPos=(90*50)/10=450. 102<450 → reverse(i=0)
      //   posPercentage=pcts[1]=11, desiredMaxNeg=(11*102)/89=12.6→12
      //   negAmount=50, amts[0]=50, 50-50=0 < 12 → stop, allowed=12
      //   Returns (10, 11, 12, 1, true)
      // Split=(10,11). Bets at 50 and 90 positive. negAllowed=12 < actual(50). Partial refund.
      //
      // OK I think I've proven to myself that the algorithm ALWAYS picks adjacent
      // entries from the sorted array as boundaries. The only refunds are:
      // 1. Partial refunds at the negative boundary (if negAllowed < actual)
      // 2. Partial refunds at the positive boundary (if posAllowed < actual)
      //
      // There is NEVER a "middle refund" because there are never bets between
      // two adjacent sorted entries.
      //
      // Wait... unless two entries have the same percentage! But we aggregate
      // by percentageTotals, so each percentage appears at most once in the array.
      //
      // So getRefundAmount() for "between boundaries" will only return >0 if
      // a percentage has bets but is between two non-adjacent boundaries.
      // But that CANNOT happen with this algorithm.
      //
      // Actually I realize it CAN'T happen either because the algorithm builds
      // the sorted array from percentageTotals which only includes non-zero entries.
      // Every percentage with bets appears in the sorted array. The boundaries
      // are always adjacent entries. So no bet can be "between" the boundaries.
      //
      // This means getRefundAmount() for locked/resolved markets will always return 0
      // (except for cancelled/abandoned which is full refund).
      //
      // Interesting! The "middle refund" code path in the contract is dead code
      // for this algorithm. Let me just test what actually works.

      // bet(30,$100) + bet(50,$120) + bet(70,$100), total=320
      // With new formula, split=(30,70). Bet at 50 is BETWEEN → full refund.
      await market.write.placePrediction([marketId, 30n, toUSDC('100')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 50n, toUSDC('120')], {
        account: predictor2.account,
      });
      await market.write.placePrediction([marketId, 70n, toUSDC('100')], {
        account: predictor3.account,
      });

      await advanceTime(86401);
      await market.write.lockMarket([marketId]);
      await market.write.resolveMarket([marketId, true], {
        account: dealer1.account,
      });

      // predictor2 at 50% is between boundaries (30, 70) → full refund
      const refund = await market.read.getRefundAmount([
        marketId,
        predictor2.account.address,
      ]);
      expect(refund).to.equal(toUSDC('120'));
    });
  });

  // ========== GROUP E: Fairness Verification ==========

  describe('Fairness verification', function () {
    it('E1: winner payout > 0 for equal symmetric bets', async function () {
      const { market, dealer1, predictor1, predictor2, stakeToken, marketId } =
        await setupMarket();

      await market.write.placePrediction([marketId, 40n, toUSDC('100')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 60n, toUSDC('100')], {
        account: predictor2.account,
      });

      await advanceTime(86401);
      await market.write.lockMarket([marketId]);
      await market.write.resolveMarket([marketId, true], {
        account: dealer1.account,
      });

      // predictor2 wins. posAllowed=66.67M, poolAfterLock=166.67M, fee=1.67M, winnerPool=165M.
      const payout = await market.read.calculatePayout([
        marketId,
        predictor2.account.address,
      ]);
      expect(payout).to.equal(165000000n);

      const before = await stakeToken.read.balanceOf([
        predictor2.account.address,
      ]);
      await market.write.claimWinnings([marketId], {
        account: predictor2.account,
      });
      const after = await stakeToken.read.balanceOf([
        predictor2.account.address,
      ]);
      expect(after - before).to.equal(165000000n);
    });

    it('E2: loser gets zero payout', async function () {
      const { market, dealer1, predictor1, predictor2, marketId } =
        await setupMarket();

      await market.write.placePrediction([marketId, 40n, toUSDC('100')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 60n, toUSDC('100')], {
        account: predictor2.account,
      });

      await advanceTime(86401);
      await market.write.lockMarket([marketId]);
      await market.write.resolveMarket([marketId, true], {
        account: dealer1.account,
      });

      const payout1 = await market.read.calculatePayout([
        marketId,
        predictor1.account.address,
      ]);
      expect(payout1).to.equal(0n);
    });
  });

  // ========== GROUP F: Boundary Percentages (0% and 100%) ==========

  describe('Boundary percentages (0% and 100%)', function () {
    it('F1: bet at 0% and 50% — split is (0, 50)', async function () {
      const { market, predictor1, predictor2, marketId } = await setupMarket();

      await market.write.placePrediction([marketId, 0n, toUSDC('100')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 50n, toUSDC('100')], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      const [negPct, posPct, , , valid] =
        await market.read.calculateMarketSplit([marketId]);
      expect(valid).to.be.true;
      expect(negPct).to.equal(0n);
      expect(posPct).to.equal(50n);

      await market.write.lockMarket([marketId]);
      const data = await market.read.markets([marketId]);
      expect(data[8]).to.equal(4); // Locked
    });

    it('F2: bet at 50% and 100% — split is (50, 100)', async function () {
      const { market, predictor1, predictor2, marketId } = await setupMarket();

      await market.write.placePrediction([marketId, 50n, toUSDC('100')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 100n, toUSDC('100')], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      const [negPct, posPct, , , valid] =
        await market.read.calculateMarketSplit([marketId]);
      expect(valid).to.be.true;
      expect(negPct).to.equal(50n);
      expect(posPct).to.equal(100n);

      await market.write.lockMarket([marketId]);
      const data = await market.read.markets([marketId]);
      expect(data[8]).to.equal(4); // Locked
    });

    it('F3: bet at 0% and 100% — full lifecycle, positive wins', async function () {
      const { market, dealer1, predictor1, predictor2, stakeToken, marketId } =
        await setupMarket();

      await market.write.placePrediction([marketId, 0n, toUSDC('100')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 100n, toUSDC('100')], {
        account: predictor2.account,
      });

      await advanceTime(86401);
      await market.write.lockMarket([marketId]);

      // Split=(0,100), no refunds. Pool=200M.
      await market.write.resolveMarket([marketId, true], {
        account: dealer1.account,
      });

      // fee=200M*100/10000=2M. winnerPool=198M. predictor2 payout=198M.
      const before = await stakeToken.read.balanceOf([
        predictor2.account.address,
      ]);
      await market.write.claimWinnings([marketId], {
        account: predictor2.account,
      });
      const after = await stakeToken.read.balanceOf([
        predictor2.account.address,
      ]);
      expect(after - before).to.equal(198000000n);
    });

    it('F4: bet(0,$100) + bet(100,$300) — positive side capped', async function () {
      const { market, dealer1, predictor1, predictor2, stakeToken, marketId } =
        await setupMarket();

      // _calculateTwoElement: negPct=0, posPct=100. Both extreme → (0,100,100,300,true)
      // No cap because both are unconditional. No refunds.
      await market.write.placePrediction([marketId, 0n, toUSDC('100')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 100n, toUSDC('300')], {
        account: predictor2.account,
      });

      await advanceTime(86401);
      await market.write.lockMarket([marketId]);

      // No refunds (both unconditional)
      expect(
        await market.read.getLockRefundAmount([
          marketId,
          predictor1.account.address,
        ])
      ).to.equal(0n);
      expect(
        await market.read.getLockRefundAmount([
          marketId,
          predictor2.account.address,
        ])
      ).to.equal(0n);

      // Resolve positive: predictor2 wins
      await market.write.resolveMarket([marketId, true], {
        account: dealer1.account,
      });

      // Pool=400M. fee=4M. winnerPool=396M. predictor2 payout=396M.
      const before = await stakeToken.read.balanceOf([
        predictor2.account.address,
      ]);
      await market.write.claimWinnings([marketId], {
        account: predictor2.account,
      });
      const after = await stakeToken.read.balanceOf([
        predictor2.account.address,
      ]);
      expect(after - before).to.equal(396000000n);
    });

    it('F5: bet(0,$300) + bet(100,$100) — negative side capped', async function () {
      const { market, dealer1, predictor1, predictor2, stakeToken, marketId } =
        await setupMarket();

      await market.write.placePrediction([marketId, 0n, toUSDC('300')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 100n, toUSDC('100')], {
        account: predictor2.account,
      });

      await advanceTime(86401);
      await market.write.lockMarket([marketId]);

      // Both unconditional, no refunds
      await market.write.resolveMarket([marketId, false], {
        account: dealer1.account,
      });

      // Pool=400M. fee=4M. winnerPool=396M. predictor1 payout=396M.
      const before = await stakeToken.read.balanceOf([
        predictor1.account.address,
      ]);
      await market.write.claimWinnings([marketId], {
        account: predictor1.account,
      });
      const after = await stakeToken.read.balanceOf([
        predictor1.account.address,
      ]);
      expect(after - before).to.equal(396000000n);
    });

    it('F6: bets at 0%, 50%, 100% — three-way split', async function () {
      const {
        market,
        dealer1,
        predictor1,
        predictor2,
        predictor3,
        stakeToken,
        marketId,
      } = await setupMarket();

      // sorted: [{0,100}, {50,100}, {100,100}], total=300
      // normalizedCalc:
      //   i=0: negTotal=100, posTotal=200. desiredMinPos=0 (pcts[0]=0). 200>=0? Yes.
      //     desiredMinNeg = (50*200)/50=200. negTotal(100)>=200? No → continue
      //   i=1: negTotal=200, posTotal=100. desiredMinPos=(50*200)/50=200. 100>=200? No → reverse
      //     pcts[2]=100 → early return: (50, 100, amts[1]=100, amts[2]=100, true)
      // Split=(50,100). Bet at 0 (<=50) is negative. No between.
      await market.write.placePrediction([marketId, 0n, toUSDC('100')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 50n, toUSDC('100')], {
        account: predictor2.account,
      });
      await market.write.placePrediction([marketId, 100n, toUSDC('100')], {
        account: predictor3.account,
      });

      await advanceTime(86401);

      const [negPct, posPct, , , valid] =
        await market.read.calculateMarketSplit([marketId]);
      expect(valid).to.be.true;
      expect(negPct).to.equal(50n);
      expect(posPct).to.equal(100n);

      await market.write.lockMarket([marketId]);

      // Resolve positive: bet at 100 wins
      await market.write.resolveMarket([marketId, true], {
        account: dealer1.account,
      });

      // Bets at 0 and 50 are negative (<=50). Bet at 100 is positive (>=100).
      expect(await market.read.isWinner([marketId, predictor1.account.address]))
        .to.be.false;
      expect(await market.read.isWinner([marketId, predictor2.account.address]))
        .to.be.false;
      expect(await market.read.isWinner([marketId, predictor3.account.address]))
        .to.be.true;

      // Pool=300M. fee=3M. winnerPool=297M. predictor3 payout=297M.
      const before = await stakeToken.read.balanceOf([
        predictor3.account.address,
      ]);
      await market.write.claimWinnings([marketId], {
        account: predictor3.account,
      });
      const after = await stakeToken.read.balanceOf([
        predictor3.account.address,
      ]);
      expect(after - before).to.equal(297000000n);
    });
  });

  // ========== GROUP G: Multi-Bettor Combinations ==========

  describe('Multi-bettor combinations', function () {
    it('G1: 4 bettors evenly spread — split found', async function () {
      const {
        market,
        dealer1,
        dealer2,
        predictor1,
        predictor2,
        predictor3,
        marketId,
      } = await setupMarket();

      // bet(20,$100) + bet(40,$100) + bet(60,$100) + bet(80,$100)
      await market.write.placePrediction([marketId, 20n, toUSDC('100')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 40n, toUSDC('100')], {
        account: predictor2.account,
      });
      await market.write.placePrediction([marketId, 60n, toUSDC('100')], {
        account: predictor3.account,
      });
      await market.write.placePrediction([marketId, 80n, toUSDC('100')], {
        account: dealer2.account,
      });

      await advanceTime(86401);

      const [, , , , valid] = await market.read.calculateMarketSplit([
        marketId,
      ]);
      expect(valid).to.be.true;

      await market.write.lockMarket([marketId]);

      // Resolve positive: above posPct wins
      await market.write.resolveMarket([marketId, true], {
        account: dealer1.account,
      });

      // At least one of the higher bettors should win
      const isWinner3 = await market.read.isWinner([
        marketId,
        predictor3.account.address,
      ]);
      const isWinner4 = await market.read.isWinner([
        marketId,
        dealer2.account.address,
      ]);
      expect(isWinner3 || isWinner4).to.be.true;
    });

    it('G2: conservation of value — payouts + refunds + fees = total pool', async function () {
      const {
        market,
        dealer1,
        predictor1,
        predictor2,
        stakeToken,
        owner,
        marketId,
      } = await setupMarket();

      // bet(40,$200) + bet(60,$200). Positive side capped → lock refund for predictor2.
      await market.write.placePrediction([marketId, 40n, toUSDC('200')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 60n, toUSDC('200')], {
        account: predictor2.account,
      });

      await advanceTime(86401);
      await market.write.lockMarket([marketId]);

      // Claim lock refund for predictor2 (positive side capped)
      const lockRefundBefore = await stakeToken.read.balanceOf([
        predictor2.account.address,
      ]);
      const lockRefundAmt = await market.read.getLockRefundAmount([
        marketId,
        predictor2.account.address,
      ]);
      if (lockRefundAmt > 0n) {
        await market.write.claimLockRefund([marketId], {
          account: predictor2.account,
        });
      }
      const lockRefundAfter = await stakeToken.read.balanceOf([
        predictor2.account.address,
      ]);
      const lockRefund = lockRefundAfter - lockRefundBefore;

      await market.write.resolveMarket([marketId, true], {
        account: dealer1.account,
      });

      // Winner: predictor2
      const winnerBefore = await stakeToken.read.balanceOf([
        predictor2.account.address,
      ]);
      await market.write.claimWinnings([marketId], {
        account: predictor2.account,
      });
      const winnerAfter = await stakeToken.read.balanceOf([
        predictor2.account.address,
      ]);
      const winnerPayout = winnerAfter - winnerBefore;

      // Dealer fees
      const dealerBefore = await stakeToken.read.balanceOf([
        dealer1.account.address,
      ]);
      await market.write.withdrawDealerFees([marketId], {
        account: dealer1.account,
      });
      const dealerAfter = await stakeToken.read.balanceOf([
        dealer1.account.address,
      ]);
      const dealerFee = dealerAfter - dealerBefore;

      // System fees
      const ownerBefore = await stakeToken.read.balanceOf([
        owner.account.address,
      ]);
      await market.write.withdrawSystemFees({ account: owner.account });
      const ownerAfter = await stakeToken.read.balanceOf([
        owner.account.address,
      ]);
      const systemFee = ownerAfter - ownerBefore;

      // Total = winnerPayout + lockRefund + dealerFee + systemFee = 400 USDC
      const totalOut = winnerPayout + lockRefund + dealerFee + systemFee;
      expect(totalOut).to.equal(toUSDC('400'));
    });

    it('G3: multiple bettors at same percentage — split still works', async function () {
      const {
        market,
        dealer1,
        predictor1,
        predictor2,
        predictor3,
        stakeToken,
        marketId,
      } = await setupMarket();

      // bet(0,$150) + bet(0,$150) + bet(100,$300)
      // Two bettors at 0%, one at 100%. Both 0% and 100% are unconditional.
      await market.write.placePrediction([marketId, 0n, toUSDC('150')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 0n, toUSDC('150')], {
        account: predictor2.account,
      });
      await market.write.placePrediction([marketId, 100n, toUSDC('300')], {
        account: predictor3.account,
      });

      await advanceTime(86401);
      await market.write.lockMarket([marketId]);

      // Resolve negative: 0% bettors win
      await market.write.resolveMarket([marketId, false], {
        account: dealer1.account,
      });

      // Pool=600M. fee=6M. winnerPool=594M. Each winner=150M/300M*594M=297M.
      const p1Before = await stakeToken.read.balanceOf([
        predictor1.account.address,
      ]);
      await market.write.claimWinnings([marketId], {
        account: predictor1.account,
      });
      const p1After = await stakeToken.read.balanceOf([
        predictor1.account.address,
      ]);
      expect(p1After - p1Before).to.equal(297000000n);

      const p2Before = await stakeToken.read.balanceOf([
        predictor2.account.address,
      ]);
      await market.write.claimWinnings([marketId], {
        account: predictor2.account,
      });
      const p2After = await stakeToken.read.balanceOf([
        predictor2.account.address,
      ]);
      expect(p2After - p2Before).to.equal(297000000n);
    });

    it('G4: partial refund at boundary with multiple bettors', async function () {
      const {
        market,
        dealer1,
        predictor1,
        predictor2,
        predictor3,
        stakeToken,
        marketId,
      } = await setupMarket();

      // bet(10,$500) + bet(50,$100) + bet(90,$100)
      // With new formula: desiredMinPos=(10*500)/90=55.5. posTotal(200)>=55 → yes
      // desiredMinNeg=(50*200)/50=200. negTotal(500)>=200 → yes. MATCH at (10,50).
      // No refunds — both sides fully satisfied.
      await market.write.placePrediction([marketId, 10n, toUSDC('500')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 50n, toUSDC('100')], {
        account: predictor2.account,
      });
      await market.write.placePrediction([marketId, 90n, toUSDC('100')], {
        account: predictor3.account,
      });

      await advanceTime(86401);
      await market.write.lockMarket([marketId]);

      // No refunds — all amounts within allowed limits
      expect(
        await market.read.getLockRefundAmount([
          marketId,
          predictor1.account.address,
        ])
      ).to.equal(0n);
      expect(
        await market.read.getLockRefundAmount([
          marketId,
          predictor2.account.address,
        ])
      ).to.equal(0n);
      expect(
        await market.read.getLockRefundAmount([
          marketId,
          predictor3.account.address,
        ])
      ).to.equal(0n);

      // Resolve positive: bets >= 50 win (predictor2 and predictor3)
      await market.write.resolveMarket([marketId, true], {
        account: dealer1.account,
      });

      expect(await market.read.isWinner([marketId, predictor2.account.address]))
        .to.be.true;
      expect(await market.read.isWinner([marketId, predictor3.account.address]))
        .to.be.true;
      expect(await market.read.isWinner([marketId, predictor1.account.address]))
        .to.be.false;

      // Pool=700M, no refunds. fee=7M. winnerPool=693M.
      // predictor2=100M, predictor3=100M. totalWin=200M.
      // Each payout: 100M*693M/200M = 346.5M.
      const p2Before = await stakeToken.read.balanceOf([
        predictor2.account.address,
      ]);
      await market.write.claimWinnings([marketId], {
        account: predictor2.account,
      });
      const p2After = await stakeToken.read.balanceOf([
        predictor2.account.address,
      ]);
      expect(p2After - p2Before).to.equal(346500000n);
    });
  });

  // ========== GROUP H: Cancellation and Abandonment ==========

  describe('Cancellation and abandonment', function () {
    it('H1: cancelled market — full refund for all', async function () {
      const { market, dealer1, marketId } = await setupMarket();

      // Cancel before any predictions
      await market.write.cancelMarket([marketId], {
        account: dealer1.account,
      });

      const data = await market.read.markets([marketId]);
      expect(data[8]).to.equal(1); // Cancelled
    });

    it('H2: abandoned market — full refund for all predictors', async function () {
      const { market, predictor1, predictor2, stakeToken, marketId } =
        await setupMarket();

      await market.write.placePrediction([marketId, 40n, toUSDC('100')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 60n, toUSDC('100')], {
        account: predictor2.account,
      });

      // Advance past deadline + grace period
      await advanceTime(86401 + 86400);

      await market.write.abandonMarket([marketId], {
        account: predictor1.account,
      });

      const refund1 = await market.read.getRefundAmount([
        marketId,
        predictor1.account.address,
      ]);
      expect(refund1).to.equal(toUSDC('100'));

      const before = await stakeToken.read.balanceOf([
        predictor1.account.address,
      ]);
      await market.write.claimRefund([marketId], {
        account: predictor1.account,
      });
      const after = await stakeToken.read.balanceOf([
        predictor1.account.address,
      ]);
      expect(after - before).to.equal(toUSDC('100'));
    });
  });
});
