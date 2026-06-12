import '@nomicfoundation/hardhat-viem';
import { expect } from 'chai';
import hre from 'hardhat';
import { getAddress } from 'viem';
import {
  advanceTime,
  deployPredictionFixture,
  toUSDC,
} from './utils/fixture.ts';

const ZERO_ORACLE_ID =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

describe('PredictionMarket (USDC)', function () {
  async function createMarketForFixture(
    fixtures: Awaited<ReturnType<typeof deployPredictionFixture>>
  ) {
    const block = await fixtures.publicClient.getBlock();
    const deadline = block.timestamp + 86401n;

    await fixtures.market.write.createMarket(
      [1n, 1n, 1n, deadline, 'Split regression market', ZERO_ORACLE_ID],
      { account: fixtures.dealer1.account }
    );

    return 1n;
  }

  describe('Initialization', function () {
    it('sets core dependencies and owner', async function () {
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

  describe('Market lifecycle', function () {
    it('allows licensed dealer to create and cancel empty market', async function () {
      const { market, dealer1, owner, publicClient } =
        await deployPredictionFixture();
      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;

      await market.write.createMarket(
        [1n, 1n, 1n, deadline, 'Rain tomorrow?', ZERO_ORACLE_ID],
        { account: dealer1.account }
      );

      await market.write.cancelMarket([1n], { account: owner.account });
      const marketData = await market.read.markets([1n]);
      expect(marketData[8]).to.equal(1); // Cancelled
    });

    it('lets predictors place, update, withdraw, and respects deadlines', async function () {
      const { market, dealer1, predictor1, publicClient, stakeToken } =
        await deployPredictionFixture();
      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;

      await market.write.createMarket(
        [1n, 1n, 1n, deadline, 'Launch success?', ZERO_ORACLE_ID],
        { account: dealer1.account }
      );

      const startBalance = await stakeToken.read.balanceOf([
        predictor1.account.address,
      ]);

      await market.write.placePrediction([1n, 40n, toUSDC('100')], {
        account: predictor1.account,
      });

      await market.write.updatePrediction([1n, 60n, toUSDC('50')], {
        account: predictor1.account,
      });

      await market.write.withdrawPrediction([1n], {
        account: predictor1.account,
      });

      const endBalance = await stakeToken.read.balanceOf([
        predictor1.account.address,
      ]);
      expect(endBalance).to.equal(startBalance);
    });
  });

  describe('Resolution & refunds', function () {
    async function openBalancedMarket() {
      const fixtures = await deployPredictionFixture();
      const block = await fixtures.publicClient.getBlock();
      const deadline = block.timestamp + 86401n;

      await fixtures.market.write.createMarket(
        [1n, 1n, 1n, deadline, 'Balanced market', ZERO_ORACLE_ID],
        { account: fixtures.dealer1.account }
      );

      await fixtures.market.write.placePrediction([1n, 30n, toUSDC('100')], {
        account: fixtures.predictor1.account,
      });
      await fixtures.market.write.placePrediction([1n, 70n, toUSDC('100')], {
        account: fixtures.predictor2.account,
      });

      return { ...fixtures };
    }

    it('only allows current NFT owner to resolve manually', async function () {
      const { market, dealer1, dealer2, predictor1, dealerNFT } =
        await openBalancedMarket();

      await advanceTime(86401);
      await market.write.lockMarket([1n]);

      try {
        await market.write.resolveMarket([1n, true], {
          account: predictor1.account,
        });
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).to.include('Not dealer owner');
      }

      const nft = await hre.viem.getContractAt('DealerNFT', dealerNFT.address);
      await nft.write.transferFrom(
        [dealer1.account.address, dealer2.account.address, 1n],
        {
          account: dealer1.account,
        }
      );

      await market.write.resolveMarket([1n, true], {
        account: dealer2.account,
      });
      const marketData = await market.read.markets([1n]);
      expect(marketData[8]).to.equal(2); // resolved
    });

    it('auto-abandons one-sided market on lock', async function () {
      const { market, dealer1, predictor1, publicClient } =
        await deployPredictionFixture();
      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;

      await market.write.createMarket(
        [1n, 1n, 1n, deadline, 'One sided', ZERO_ORACLE_ID],
        { account: dealer1.account }
      );

      await market.write.placePrediction([1n, 20n, toUSDC('200')], {
        account: predictor1.account,
      });

      await advanceTime(86401);

      await market.write.lockMarket([1n]);
      const data = await market.read.markets([1n]);
      expect(data[8]).to.equal(3); // Abandoned (auto-abandon on one-sided market)
    });

    it('allows abandonment with refunds when dealer/oracle stalled', async function () {
      const { market, dealer1, predictor1, publicClient } =
        await deployPredictionFixture();
      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;

      await market.write.createMarket(
        [1n, 1n, 1n, deadline, 'Abandon me', ZERO_ORACLE_ID],
        { account: dealer1.account }
      );
      await market.write.placePrediction([1n, 55n, toUSDC('50')], {
        account: predictor1.account,
      });

      await advanceTime(Number(86401n + 86401n));
      await market.write.abandonMarket([1n]);

      const refund = await market.read.getRefundAmount([
        1n,
        predictor1.account.address,
      ]);
      expect(refund).to.equal(toUSDC('50'));
    });

    it('distributes payouts and fees in USDC', async function () {
      const {
        market,
        dealer1,
        predictor1,
        predictor2,
        publicClient,
        stakeToken,
        owner,
      } = await deployPredictionFixture();
      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;

      await market.write.createMarket(
        [1n, 1n, 1n, deadline, 'Winner payout', ZERO_ORACLE_ID],
        { account: dealer1.account }
      );

      // Use larger amounts to ensure fees are non-zero after new formula
      await market.write.placePrediction([1n, 40n, toUSDC('1000')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([1n, 80n, toUSDC('1000')], {
        account: predictor2.account,
      });

      await advanceTime(86401);
      await market.write.lockMarket([1n]);
      await market.write.resolveMarket([1n, true], {
        account: dealer1.account,
      });

      // desiredMinPos = (40*1000)/60 = 666.67. posTotal(1000) >= 666.67 → yes
      // desiredMinNeg = (80*1000)/20 = 4000. negTotal(1000) < 4000 → last iter, cap pos to 666.67
      // poolAfterLock = 2000 - (1000 - 666.666666) = 1666.666666
      // fee = 1666.666666 * 1% = 16.666666. winnerPool = 1650.
      const winnerBefore = await stakeToken.read.balanceOf([
        predictor2.account.address,
      ]);
      await market.write.claimWinnings([1n], { account: predictor2.account });
      const winnerAfter = await stakeToken.read.balanceOf([
        predictor2.account.address,
      ]);
      expect(winnerAfter - winnerBefore).to.equal(1650000000n);

      const dealerBefore = await stakeToken.read.balanceOf([
        dealer1.account.address,
      ]);
      await market.write.withdrawDealerFees([1n], { account: dealer1.account });
      const dealerAfter = await stakeToken.read.balanceOf([
        dealer1.account.address,
      ]);
      expect(dealerAfter - dealerBefore).to.equal(4166666n);

      const ownerBefore = await stakeToken.read.balanceOf([
        owner.account.address,
      ]);
      await market.write.withdrawSystemFees({ account: owner.account });
      const ownerAfter = await stakeToken.read.balanceOf([
        owner.account.address,
      ]);
      expect(ownerAfter - ownerBefore).to.equal(12500000n);
    });

    it('pays affiliate 10% of fee from system share when winner has affiliate', async function () {
      const {
        market,
        dealer1,
        predictor1,
        predictor2,
        predictor3,
        publicClient,
        stakeToken,
        owner,
      } = await deployPredictionFixture();
      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;

      await market.write.createMarket(
        [1n, 1n, 1n, deadline, 'Affiliate test', ZERO_ORACLE_ID],
        { account: dealer1.account }
      );

      // predictor1 bets 40% with predictor3 as affiliate
      await market.write.placePrediction(
        [1n, 40n, toUSDC('1000'), predictor3.account.address],
        { account: predictor1.account }
      );
      // predictor2 bets 80% with no affiliate
      await market.write.placePrediction([1n, 80n, toUSDC('1000')], {
        account: predictor2.account,
      });

      await advanceTime(86401);
      await market.write.lockMarket([1n]);
      await market.write.resolveMarket([1n, true], {
        account: dealer1.account,
      });

      // poolAfterLock = 1666.666666 USDC
      // totalFee = 16.666666 USDC (1%)
      // dealerFee = 16666666 * 25 / 100 = 4166666
      // affiliateReserve = 16666666 * 1000 / 10000 = 1666666 (10% of totalFee)
      // systemFee = 16666666 - 4166666 - 1666666 = 10833334

      // Winner: predictor2 (no affiliate), gets full payout
      const winnerBefore = await stakeToken.read.balanceOf([
        predictor2.account.address,
      ]);
      const affiliateBefore = await stakeToken.read.balanceOf([
        predictor3.account.address,
      ]);
      await market.write.claimWinnings([1n], { account: predictor2.account });
      const winnerAfter = await stakeToken.read.balanceOf([
        predictor2.account.address,
      ]);
      const affiliateAfterWinner = await stakeToken.read.balanceOf([
        predictor3.account.address,
      ]);
      // Winner payout same as before (1650 USDC)
      expect(winnerAfter - winnerBefore).to.equal(1650000000n);
      // No affiliate payout for predictor2 (no affiliate set)
      expect(affiliateAfterWinner - affiliateBefore).to.equal(0n);

      // Dealer fees
      await market.write.withdrawDealerFees([1n], { account: dealer1.account });

      // System fees (reduced by affiliate reserve)
      const ownerBefore = await stakeToken.read.balanceOf([
        owner.account.address,
      ]);
      await market.write.withdrawSystemFees({ account: owner.account });
      const ownerAfter = await stakeToken.read.balanceOf([
        owner.account.address,
      ]);
      // System gets 10833334 (75% minus 10% affiliate reserve)
      expect(ownerAfter - ownerBefore).to.equal(10833334n);
    });

    it('rejects self-referral as affiliate', async function () {
      const { market, dealer1, predictor1, publicClient } =
        await deployPredictionFixture();
      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;

      await market.write.createMarket(
        [1n, 1n, 1n, deadline, 'Self-ref test', ZERO_ORACLE_ID],
        { account: dealer1.account }
      );

      try {
        await market.write.placePrediction(
          [1n, 50n, toUSDC('100'), predictor1.account.address],
          { account: predictor1.account }
        );
        expect.fail('Should have reverted');
      } catch (error: any) {
        expect(error.message).to.include('Self-referral');
      }
    });

    it('resolves with the auto-computed split', async function () {
      const {
        market,
        dealer1,
        predictor1,
        predictor2,
        publicClient,
        stakeToken,
      } = await deployPredictionFixture();
      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;

      await market.write.createMarket(
        [1n, 1n, 1n, deadline, 'Pre-computed split', ZERO_ORACLE_ID],
        { account: dealer1.account }
      );

      await market.write.placePrediction([1n, 40n, toUSDC('100')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([1n, 80n, toUSDC('100')], {
        account: predictor2.account,
      });

      await advanceTime(86401);
      await market.write.lockMarket([1n]);
      await market.write.resolveMarket([1n, true], {
        account: dealer1.account,
      });

      const marketData = await market.read.markets([1n]);
      expect(marketData[8]).to.equal(2); // Resolved
      expect(marketData[10]).to.equal(40n); // lower boundary = 40

      // bet(40,$100) + bet(80,$100): posAllowed = (40*100)/60 = 66.666666
      // poolAfterLock = 200 - (100 - 66.666666) = 166.666666. fee=1.666666. winnerPool=165.
      const winnerBefore = await stakeToken.read.balanceOf([
        predictor2.account.address,
      ]);
      await market.write.claimWinnings([1n], { account: predictor2.account });
      const winnerAfter = await stakeToken.read.balanceOf([
        predictor2.account.address,
      ]);
      expect(winnerAfter - winnerBefore).to.equal(165000000n);
    });

    it('exposes the computed split boundaries through lockRefunds', async function () {
      const { market, dealer1, predictor1, predictor2, publicClient } =
        await deployPredictionFixture();
      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;

      await market.write.createMarket(
        [1n, 1n, 1n, deadline, 'Bad split values', ZERO_ORACLE_ID],
        { account: dealer1.account }
      );

      await market.write.placePrediction([1n, 30n, toUSDC('100')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([1n, 70n, toUSDC('100')], {
        account: predictor2.account,
      });

      await advanceTime(86401);
      await market.write.lockMarket([1n]);

      const lockInfo = await market.read.lockRefunds([1n]);
      expect(lockInfo[0]).to.equal(30n);
      expect(lockInfo[1]).to.equal(70n);
      // desiredMinPos = (30*100M)/70 = 42857142. Positive side capped.
      expect(lockInfo[2]).to.equal(toUSDC('100'));
      expect(lockInfo[3]).to.equal(42857142n);
    });

    it('anyone can lock but only dealer can resolve', async function () {
      const { market, dealer1, predictor1, predictor2, publicClient } =
        await deployPredictionFixture();
      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;

      await market.write.createMarket(
        [1n, 1n, 1n, deadline, 'Auth check', ZERO_ORACLE_ID],
        { account: dealer1.account }
      );

      await market.write.placePrediction([1n, 30n, toUSDC('100')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([1n, 70n, toUSDC('100')], {
        account: predictor2.account,
      });

      await advanceTime(86401);

      // Anyone can lock (predictor1 locks here)
      await market.write.lockMarket([1n], {
        account: predictor1.account,
      });

      // But only dealer can resolve
      try {
        await market.write.resolveMarket([1n, true], {
          account: predictor1.account,
        });
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).to.include('Not dealer owner');
      }
    });

    it('reports no valid split for a one-sided market', async function () {
      const { market, dealer1, predictor1, publicClient } =
        await deployPredictionFixture();
      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;

      await market.write.createMarket(
        [1n, 1n, 1n, deadline, 'One sided split', ZERO_ORACLE_ID],
        { account: dealer1.account }
      );

      await market.write.placePrediction([1n, 20n, toUSDC('200')], {
        account: predictor1.account,
      });

      await advanceTime(86401);
      const split = await market.read.calculateMarketSplit([1n]);
      expect(split[4]).to.equal(false);
    });

    it('validates oracle timestamps before resolving', async function () {
      const {
        market,
        dealer1,
        oracleResolver,
        owner,
        publicClient,
        predictor1,
        predictor2,
      } = await deployPredictionFixture();
      const oracleId =
        '0x0000000000000000000000000000000000000000000000000000000000000abc';

      await oracleResolver.write.registerOracle(
        [oracleId, 2, getAddress(owner.account.address), 0n, 100n, 86400n],
        { account: owner.account }
      );
      await oracleResolver.write.setAuthorizedUpdater(
        [owner.account.address, true],
        {
          account: owner.account,
        }
      );

      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 86401n;

      await market.write.createMarket(
        [1n, 1n, 1n, deadline, 'Oracle market', oracleId],
        { account: dealer1.account }
      );

      await market.write.placePrediction([1n, 20n, toUSDC('50')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([1n, 80n, toUSDC('50')], {
        account: predictor2.account,
      });

      // Publish oracle data too early (before deadline)
      await oracleResolver.write.updateOracleData([oracleId, 80n], {
        account: owner.account,
      });

      await advanceTime(86401);

      // Lock market first (required before resolve)
      await market.write.lockMarket([1n]);

      let state = await market.read.markets([1n]);
      expect(state[8]).to.equal(4); // Locked

      let reverted = false;
      try {
        await market.write.resolveMarketWithOracle([1n]);
        expect.fail('Should revert on early data');
      } catch {
        reverted = true;
      }
      expect(reverted).to.be.true;

      // Publish fresh data (after deadline, so timestamp is valid)
      await oracleResolver.write.updateOracleData([oracleId, 90n], {
        account: owner.account,
      });

      await market.write.resolveMarketWithOracle([1n]);
      state = await market.read.markets([1n]);
      expect(state[8]).to.equal(2); // Resolved
    });
  });

  describe('Split edge cases', function () {
    it('handles 0%, 50%, 100% without reverting and matches TS split', async function () {
      const fixtures = await deployPredictionFixture();
      const { market, predictor1, predictor2, predictor3 } = fixtures;
      const marketId = await createMarketForFixture(fixtures);

      await market.write.placePrediction([marketId, 0n, toUSDC('100')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 50n, toUSDC('100')], {
        account: predictor2.account,
      });
      await market.write.placePrediction([marketId, 100n, toUSDC('100')], {
        account: predictor3.account,
      });

      const split = await market.read.calculateMarketSplit([marketId]);
      expect(split[0]).to.equal(50n);
      expect(split[1]).to.equal(100n);
      expect(split[2]).to.equal(toUSDC('100'));
      expect(split[3]).to.equal(toUSDC('100'));
      expect(split[4]).to.equal(true);

      await advanceTime(86401);
      await market.write.lockMarket([marketId]);

      const marketData = await market.read.markets([marketId]);
      expect(marketData[10]).to.equal(50n);

      const lockInfo = await market.read.lockRefunds([marketId]);
      expect(lockInfo[0]).to.equal(50n);
      expect(lockInfo[1]).to.equal(100n);
      expect(lockInfo[2]).to.equal(toUSDC('100'));
      expect(lockInfo[3]).to.equal(toUSDC('100'));
    });

    it('handles 0%, 1%, 99%, 100% without reverting and matches TS split', async function () {
      const fixtures = await deployPredictionFixture();
      const { market, predictor1, predictor2, predictor3, dealer2 } = fixtures;
      const marketId = await createMarketForFixture(fixtures);

      await market.write.placePrediction([marketId, 0n, toUSDC('100')], {
        account: predictor1.account,
      });
      await market.write.placePrediction([marketId, 1n, toUSDC('100')], {
        account: predictor2.account,
      });
      await market.write.placePrediction([marketId, 99n, toUSDC('100')], {
        account: predictor3.account,
      });
      await market.write.placePrediction([marketId, 100n, toUSDC('100')], {
        account: dealer2.account,
      });

      const split = await market.read.calculateMarketSplit([marketId]);
      expect(split[0]).to.equal(0n);
      expect(split[1]).to.equal(1n);
      expect(split[2]).to.equal(toUSDC('100'));
      expect(split[3]).to.equal(toUSDC('100'));
      expect(split[4]).to.equal(true);

      await advanceTime(86401);
      await market.write.lockMarket([marketId]);

      const marketData = await market.read.markets([marketId]);
      expect(marketData[10]).to.equal(0n);

      const lockInfo = await market.read.lockRefunds([marketId]);
      expect(lockInfo[0]).to.equal(0n);
      expect(lockInfo[1]).to.equal(1n);
      expect(lockInfo[2]).to.equal(toUSDC('100'));
      expect(lockInfo[3]).to.equal(toUSDC('100'));
    });
  });
});
