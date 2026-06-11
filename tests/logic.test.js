import { expect } from 'chai';
import { FundHolding, FundPortfolio } from '../core.js';

describe('FundHolding', () => {
  it('calculates estimatedValue correctly', () => {
    const holding = new FundHolding('008702', 'Test', 1000, 100);
    holding.estimatedNAV = 2.0;
    expect(holding.estimatedValue).to.equal(200);
  });

  it('calculates profit correctly', () => {
    const holding = new FundHolding('008702', 'Test', 150, 100);
    holding.estimatedNAV = 2.0;
    expect(holding.profit).to.equal(50);
  });

  it('calculates todayChange correctly', () => {
    const holding = new FundHolding('008702', 'Test', 1000, 100);
    holding.estimatedNAV = 2.0;
    holding.previousNAV = 1.9;
    expect(holding.todayChange).to.be.closeTo(10, 0.001);
  });

  it('formats positive signed amounts correctly', () => {
    expect(FundHolding.formatSigned(50)).to.equal('+50.00');
    expect(FundHolding.formatSigned(5000.5)).to.equal('+5,000.50');
  });

  it('formats negative signed amounts correctly', () => {
    expect(FundHolding.formatSigned(-50)).to.equal('-50.00');
  });

  it('identifies trend classes', () => {
    expect(FundHolding.getTrendClass(10)).to.equal('trend-up');
    expect(FundHolding.getTrendClass(-10)).to.equal('trend-down');
    expect(FundHolding.getTrendClass(0)).to.equal('trend-flat');
  });
});

describe('FundPortfolio', () => {
  it('initializes with default funds if empty', () => {
    const defaults = FundPortfolio.getDefaults();
    const portfolio = new FundPortfolio(defaults);
    expect(portfolio.holdings.length).to.equal(5);
    expect(portfolio.holdings[0].code).to.equal('008702');
    expect(portfolio.holdings[0].shares).to.equal(0);
  });

  it('adds a new fund successfully', () => {
    const portfolio = new FundPortfolio();
    portfolio.addFund('123456', 500);
    expect(portfolio.holdings.length).to.equal(1);
    expect(portfolio.holdings[0].code).to.equal('123456');
    expect(portfolio.holdings[0].costBasis).to.equal(500);
  });

  it('fails to add invalid code or amount', () => {
    const portfolio = new FundPortfolio();
    expect(() => portfolio.addFund('123', 500)).to.throw("基金代码必须是 6 位数字");
    expect(() => portfolio.addFund('123456', -100)).to.throw("金额必须是大于 0 的有效数字");
    portfolio.addFund('123456', 500);
    expect(() => portfolio.addFund('123456', 100)).to.throw("该基金已在持仓列表中");
  });

  it('adjusts fund (increase) correctly', () => {
    const portfolio = new FundPortfolio([{ code: '123456', name: 'Test', costBasis: 1000, shares: 1000 }]);
    portfolio.holdings[0].estimatedNAV = 2.0; // nav = 2
    portfolio.adjustFund('123456', 500, true);
    expect(portfolio.holdings[0].costBasis).to.equal(1500);
    expect(portfolio.holdings[0].shares).to.equal(1250); // 1000 + 500/2
  });

  it('adjusts fund (decrease) correctly', () => {
    const portfolio = new FundPortfolio([{ code: '123456', name: 'Test', costBasis: 1000, shares: 1000 }]);
    portfolio.holdings[0].estimatedNAV = 2.0; // nav = 2
    // total value = 2000
    portfolio.adjustFund('123456', 1000, false); // sell 1000 value = 500 shares
    expect(portfolio.holdings[0].shares).to.equal(500);
    // sold half shares, so cost basis reduced by half
    expect(portfolio.holdings[0].costBasis).to.equal(500);
  });

  it('rejects decrease if exceeds holding', () => {
    const portfolio = new FundPortfolio([{ code: '123456', name: 'Test', costBasis: 1000, shares: 1000 }]);
    portfolio.holdings[0].estimatedNAV = 2.0; // nav = 2
    expect(() => portfolio.adjustFund('123456', 2001, false)).to.throw("减仓金额超过当前持有市值");
  });

  it('serializes and deserializes', () => {
    const portfolio = new FundPortfolio([{ code: '123456', name: 'Test', costBasis: 1000, shares: 1000 }]);
    const jsonStr = portfolio.serialize();
    const restored = FundPortfolio.deserialize(jsonStr);
    expect(restored.holdings[0].code).to.equal('123456');
    expect(restored.holdings[0].costBasis).to.equal(1000);
  });
});
