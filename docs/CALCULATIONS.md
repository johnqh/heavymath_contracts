# Probability market

## Definitions

The "payout" below refers to the ratio of profit / original stake.

When user specifies a percentage, it represent the predicted probability (in fraction, it is 0.0 to 1.0) of the outcome.

That also indicates the payout he is willing to bet on either side.  
Let's say the probability he put in is p (in fraction, converted from percentage).  
It also means he is willing to bet on positive if the payout is higher than (1 - p) / p. He is willing to bet on the negative if the payout of betting and winning with negative is higher than p / (1 - p)

## Examples

For example, if he thinks the probability is 0.25, he is willing to bet on positive if the payout of betting and winning with positive is higher than (1 - 0.25) / 0.25, which is 3.

It also means he is willing to bet on the negative if the payout of betting and winning with negative is higher than 0.25/(1 - 0.25) = 1/3.

## Equilibrium

When we calculate the equilibrium (let's call it e), it means e / (1 - e) equals the total amount to its right / total amount to its left.

If user placed a prediction with 0.25, and the equilibrium is 0.26, it means the expected payout of betting on negative is 0.26/(1 - 0.26) = 0.3524, and the expected payout of betting on the positive is (1 - 0.26)/0.26 = 2.84.

Remember the user expects >=3.0 payout for betting on positive, or >=0.333 for betting on negative. So in this case, he bets on negative.

In essentive, if he is more negative than the equilibrium, he places bet on the negative side. If he is more positive than the equilibrium, he places bet on the positive side.

## Edge Cases 1

If the calculated equilibrium is exactly on a percentage number, all of those predictions on that exact percentage should be refunded and removed from the pool.

## Edge Cases 2

In rare cases, we will have to remove some amount of predictions to get to the equilibrium.

Example, let's say one person A bet $3 on 0.49, and other person B bet $1 on 0.51.

If equilibrium is 0.50, A would bet on negative and B would bet on negative. B is super happy because his expected payout is (1 - 0.51)/0.51 = 0.96. However, the pool would give him a 3/1=3 payout. A would be very unhappy because he expected payout to be (1 - 0.49) / 0.49 = 1.04, but with the pool, he would only have 1/3 = 0.33 payout.

The solution is to give partial refund to A, so A only have (0.51 / 0.49) x 1 = 0.96. In this case, both predictors get satisfactory payout.

The formular is

Let's use Pneg for nearest negative probability in percentage increment (or in fraction, nearest in 0.01 increment to equilibrium's left)
Let's use Ppos for nearest positive probability in percentage increment (or in fraction, nearest in 0.01 increment to equilibrium's right)

Ppos / Pneg = sum(negative amount) / sum(positive amount).

Essentially we go back to the definition of equilibrium

## Calculation

Essentially we should use a binary search pattern, starting with 0.5, to compare Ppos / Pneg and sum(negative amount) / sum(positive amount)

If (Ppos / Pneg) > sum(negative amount) / sum(positive amount), we move left (for example, if we start with 0.5, we should try 0.25 next).
If (Ppos / Pneg) < sum(negative amount) / sum(positive amount), we move right (for example, if we start with 0.5, we should try 0.75 next).

The equilibrium must be a whole percent.

At some point, we will understand the equilibrium is a exact percentage, such as 0.25. In this case, we remove all bets on 0.25. Pneg is 0.24, and Ppos is 0.26.
Or, we will find the equilibrium is between two percentages, such as 0.25 and 0.26. Then we use the lower number (0.25) as Pneg, and higher number (0.26) as Ppos.

## Tests

When we write code, we need to create test cases for the calculation. The calculations should always contain a list of bets, which include both a probability and an amount. Then we should calculate the equilibrium and remove some bets, and all remaining will be either on the negative or the positive side. Finally, we should verify all remaining bets would get higher than expected payout.
