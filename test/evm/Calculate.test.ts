import { expect } from 'chai';
import { calculate } from '../../calculate.ts';

describe('calculate()', function () {
  it('5 predictions: [25,41] [45,10] [57,13] [58,34] [73,20]', function () {
    const predictions = [
      { percentage: 25, amount: 41 },
      { percentage: 45, amount: 10 },
      { percentage: 57, amount: 13 },
      { percentage: 58, amount: 34 },
      { percentage: 73, amount: 20 },
    ];
    const total = predictions.reduce((s, p) => s + p.amount, 0);
    const result = calculate(predictions, total);

    expect(result).to.not.be.undefined;
    expect(result!.negative.percentage).to.equal(45);
    expect(result!.negative.amount).to.equal(10);
    expect(result!.positive.percentage).to.equal(57);
    expect(result!.positive.amount).to.equal(13);
  });
});
