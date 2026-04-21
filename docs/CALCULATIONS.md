# Probability market

## Definitions

The "payout" below refers to the ratio of profit / original stake.

percentage - a number indicating his prediction of positive outcome, from 0 to 100.
pNegative - Under this percentage (inclusive), everyone bets on the negative outcome
pPositive - Above this percentage (inclusive), everyone bets on the positive outcome

pPositive must be > pNegative

Total - Total amount staked in the market
amount(percentage) - amount staked in that percentage
sum(negative) - total amount on the negative side, from 0 to pNegative (inclusive)
sum(positive) - total amount on the positive side, from pPositive to 100 (inclusive)

staking[] - array of {percentage, sum(negative)}, sorted by percentage

## Requirements

```

// for negative side
sum(posivie) / sum(negative) >= (100 - pNegative) / pNegative;
Meaning:
sum(positive) >= (100 - pNegative) * sum(negative) / pNegative // minimum positive
sum(negative) <= pNegative * sum(positive) / (100 - pNegative) // maximum negative

// for positive side
sum(negative) / sum(positive) >= pPositive / (100 - pPositive)
Meaning:
sum(negative) >= pPositive * sum(positive) / (100 - pPositive) // minimum negative
sum(positive) <= (100 - pPositive) * sum(negative) / pPositive // maximum positive

```

## Calculations

Given staking[{percentage, sum(negative)}], and total:

We want to return a structure, qsuedo code:
{
result: boolean; // whether successful
negative?: {percentage, effectiveTotal}
positive?: {percentage, effectiveTotal}
}

if staking.count < 2 {
return {false, undefined, undefined}; // we need at least two different percentages to lock the market
}

let totalNegative = 0;
let totalPositive = total;
for (i = 0; i <= staking.count; i ++) {

let negative = staking[i];
let positive = staking[i + 1];

}

## Tests

When we write code, we need to create test cases for the calculation. The calculations should always contain a list of bets, which include both a probability and an amount. Then we should calculate the equilibrium and remove some bets, and all remaining will be either on the negative or the positive side. Finally, we should verify all remaining bets would get higher than expected payout.
