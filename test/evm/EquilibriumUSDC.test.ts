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

  it("finds a 50% equilibrium for symmetric odds", async function () {
    const { market, dealer1, predictor1, predictor2, marketId } =
      await setupMarket();

    await market.write.placePrediction([marketId, 40n, toUSDC("150")], {
      account: predictor1.account,
    });
    await market.write.placePrediction([marketId, 60n, toUSDC("150")], {
      account: predictor2.account,
    });

    await advanceTime(86401);
    await market.write.resolveMarket([marketId, 55n], {
      account: dealer1.account,
    });

    const [, , , , , , , , , , equilibrium] = await market.read.markets([
      marketId,
    ]);
    expect(equilibrium).to.equal(50n);
  });

  it("refunds predictors who land exactly on the equilibrium point", async function () {
    const { market, dealer1, predictor1, predictor2, predictor3, marketId } =
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
    await market.write.resolveMarket([marketId, 65n], {
      account: dealer1.account,
    });

    const refund = await market.read.getRefundAmount([
      marketId,
      predictor2.account.address,
    ]);
    expect(refund).to.equal(toUSDC("120"));

    await market.write.claimRefund([marketId], {
      account: predictor2.account,
    });
    const prediction = await market.read.predictions([
      marketId,
      predictor2.account.address,
    ]);
    expect(prediction[3]).to.equal(true);
  });

  it("excludes equilibrium stakes from winner payouts", async function () {
    const { market, dealer1, predictor1, predictor2, predictor3, stakeToken } =
      await setupMarket();
    const marketId = 1n;

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
    await market.write.resolveMarket([marketId, 70n], {
      account: dealer1.account,
    });

    const winnerBefore = await stakeToken.read.balanceOf([
      predictor3.account.address,
    ]);
    await market.write.claimWinnings([marketId], {
      account: predictor3.account,
    });
    const winnerAfter = await stakeToken.read.balanceOf([
      predictor3.account.address,
    ]);

    // Total pool = 450 USDC, but 150 USDC sits at equilibrium and should be refunded.
    // Winners therefore only split the 300 USDC pool minus fees.
    expect(winnerAfter - winnerBefore).to.equal(toUSDC("299.67"));
  });
});

describe("Equilibrium algorithm with pre-computed equilibrium (USDC)", function () {
  async function setupMarket() {
    const fixtures = await deployPredictionFixture();
    const block = await fixtures.publicClient.getBlock();
    const deadline = block.timestamp + 86401n;

    await fixtures.market.write.createMarket(
      [1n, 1n, 1n, deadline, "Pre-computed eq checks", "0x0000000000000000000000000000000000000000000000000000000000000000"],
      { account: fixtures.dealer1.account }
    );

    return { ...fixtures, marketId: 1n };
  }

  it("finds a 50% equilibrium for symmetric odds with pre-computed equilibrium", async function () {
    const { market, dealer1, predictor1, predictor2, marketId } =
      await setupMarket();

    await market.write.placePrediction([marketId, 40n, toUSDC("150")], {
      account: predictor1.account,
    });
    await market.write.placePrediction([marketId, 60n, toUSDC("150")], {
      account: predictor2.account,
    });

    await advanceTime(86401);
    await market.write.resolveMarketWithEquilibrium([marketId, 55n, 50n], {
      account: dealer1.account,
    });

    const [, , , , , , , , , , equilibrium] = await market.read.markets([
      marketId,
    ]);
    expect(equilibrium).to.equal(50n);
  });

  it("refunds equilibrium predictors with pre-computed equilibrium", async function () {
    const { market, dealer1, predictor1, predictor2, predictor3, marketId } =
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
    await market.write.resolveMarketWithEquilibrium([marketId, 65n, 50n], {
      account: dealer1.account,
    });

    const refund = await market.read.getRefundAmount([
      marketId,
      predictor2.account.address,
    ]);
    expect(refund).to.equal(toUSDC("120"));

    await market.write.claimRefund([marketId], {
      account: predictor2.account,
    });
    const prediction = await market.read.predictions([
      marketId,
      predictor2.account.address,
    ]);
    expect(prediction[3]).to.equal(true);
  });

  it("excludes equilibrium stakes from winner payouts with pre-computed equilibrium", async function () {
    const { market, dealer1, predictor1, predictor2, predictor3, stakeToken } =
      await setupMarket();
    const marketId = 1n;

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
    await market.write.resolveMarketWithEquilibrium([marketId, 70n, 50n], {
      account: dealer1.account,
    });

    const winnerBefore = await stakeToken.read.balanceOf([
      predictor3.account.address,
    ]);
    await market.write.claimWinnings([marketId], {
      account: predictor3.account,
    });
    const winnerAfter = await stakeToken.read.balanceOf([
      predictor3.account.address,
    ]);

    expect(winnerAfter - winnerBefore).to.equal(toUSDC("299.67"));
  });
});
