/**
 * Lock market calculation algorithm.
 *
 * Inputs:
 * - percentageTotals: amount staked at each percentage point (index 0-100)
 * - totalPool: sum of all amounts (redundant but pre-computed in contract)
 *
 * Output:
 * - TBD: equilibrium, refunds, side assignments, etc.
 */

interface PercentageAndAmount {
  percentage: number;
  amount: number;
}

interface MarketSplit {
  negative: PercentageAndAmount;
  positive: PercentageAndAmount;
}

function reverseCalculate(
  percentages: PercentageAndAmount[],
  negativeIndex: number,
  negativeTotal: number,
  positiveTotal: number
): MarketSplit | undefined {
  // We already reach the point where we know the positive side, so positive side is locked
  const positiveIndex = negativeIndex + 1;
  const positive = percentages[positiveIndex];

  const positivePercentage = positive.percentage;

  // 100% bettors accept any odds, no need to trim negative side
  if (positivePercentage === 100) {
    return { negative: percentages[negativeIndex], positive };
  }

  // sum(negative) <= pNegative * sum(positive) / (100 - pNegative) // maximum negative
  const desiredMaximumNegativeAmount =
    (positivePercentage * positiveTotal) / (100 - positivePercentage);

  let negativeAmount = negativeTotal;
  for (let i = negativeIndex; i >= 0; i--) {
    const negative = percentages[i];
    if (negativeAmount - negative.amount < desiredMaximumNegativeAmount) {
      // great, we stop here
      return {
        negative: {
          percentage: negative.percentage,
          amount:
            desiredMaximumNegativeAmount - (negativeAmount - negative.amount),
        },
        positive,
      };
    }
    negativeAmount -= negative.amount;
  }
  return undefined;
}

function normalizedCalculate(
  percentages: PercentageAndAmount[],
  total: number
): MarketSplit | undefined {
  // We already know percentages.length >= 2, and if percentages.length == 2, we don't have 0 and 100 percentages here
  let negativeTotal = 0;
  let positiveTotal = total;
  for (let i = 0; i < percentages.length - 1; i++) {
    const negative = percentages[i];
    const positive = percentages[i + 1];
    const negativePercentage = negative.percentage;
    const positivePercentage = positive.percentage;
    negativeTotal += negative.amount;
    positiveTotal -= negative.amount;

    // based on the the negative percentage and positive percentage, let's see if we can find a way to satisfy both sides' desire for odds

    // sum(positive) >= ((100 - pNegative) * sum(negative)) / pNegative;
    // 0% bettors are unconditionally negative, no constraint on positive side
    const desiredMinimumPositiveAmount =
      negativePercentage === 0
        ? 0
        : ((100 - negativePercentage) * negativeTotal) / negativePercentage;
    if (positiveTotal >= desiredMinimumPositiveAmount) {
      // sum(negative) >= (pPositive * sum(positive)) / (100 - pPositive);
      // 100% bettors are unconditionally positive, no constraint on negative side
      const desiredMinimumNegativeAmount =
        positivePercentage === 100
          ? 0
          : (positivePercentage * positiveTotal) / (100 - positivePercentage);
      if (negativeTotal >= desiredMinimumNegativeAmount) {
        // perfect, let's return it
        return {
          negative,
          positive,
        };
      } else {
        // negative side is too low
        if (i == percentages.length - 2) {
          // This is the last iteration. It means the highest percentage is betting against everyone else
          // positiveAmount < desiredMinimumPositiveAmount, that means we need to cut the negative side
          return {
            negative,
            positive: {
              percentage: positivePercentage,
              amount: desiredMinimumPositiveAmount,
            },
          };
        } else {
          // we continue with the loop to increase the negative side
        }
      }
    } else {
      // positive side is too low, meaning the negative side is too high
      return reverseCalculate(percentages, i, negativeTotal, positiveTotal);
    }
  }

  return undefined;
}

/*
For a market, we know the percentages people bet on, and the amount for each percentage, and the total
returns the two percentage data
negative percentage and below would bet on the negative side. 
The amount is the total amount to be allowed. If the total staked amount for that percentage is higher than negative.amount, the extra much be refunded.
positive percentage and above would be on the positive side.
The amount is the total amount to be allowed. If the total staked amount for that percentage is higher than negative.amount, the extra much be refunded.
Any percentages between negative and positive percentages shall be refunded.
If the result is undefined, the market is invalid. All bets should be refunded
*/
export function calculate(
  percentages: PercentageAndAmount[],
  total: number
): MarketSplit | undefined {
  if (percentages.length < 2) {
    return undefined;
  }
  if (percentages.length == 2) {
    const negative = percentages[0];
    const positive = percentages[1];
    if (negative.percentage == 0) {
      // they bet on negative no matter what
      if (positive.percentage == 100) {
        // they bet on positive no matter what
        // neither side care about odds
        return { negative, positive };
      } else {
        // positive side care about outcome
        // Check if positive side has expected payout
        // sum(positive) <= (100 - pPositive) * sum(negative) / pPositive
        const positivePercentage = positive.percentage;
        const positiveAmount =
          ((100 - positivePercentage) * negative.amount) / positivePercentage;
        if (positive.amount <= positiveAmount) {
          // higher payout than expected by positive side
          return { negative, positive };
        } else {
          const positiveSide: PercentageAndAmount = {
            percentage: positivePercentage,
            amount: positiveAmount,
          };
          return { negative, positive: positiveSide };
        }
      }
    } else {
      if (positive.percentage == 100) {
        // negative side is not 0, care about outcome
        // Check if negative side has expected payout
        // sum(negative) <= (pNegative * sum(positive)) / (100 - pNegative);
        const negativePercentage = negative.percentage;
        const negativeAmount =
          (negativePercentage * positive.amount) / (100 - negativePercentage);
        if (negative.amount <= negativeAmount) {
          // higher payout than expected by negative side
          return { negative, positive };
        } else {
          const negativeSide: PercentageAndAmount = {
            percentage: negativePercentage,
            amount: negativeAmount,
          };
          return { negative: negativeSide, positive };
        }
      } else {
        // no extreme (0 and 100) bets. Use normalized calculation
        return normalizedCalculate(percentages, total);
      }
    }
  } else {
    return normalizedCalculate(percentages, total);
  }
}
