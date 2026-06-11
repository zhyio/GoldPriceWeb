export class FundHolding {
  constructor(code, name, costBasis, shares = 0) {
    this.code = code;
    this.name = name;
    this.costBasis = costBasis;
    this.shares = shares;

    this.estimatedNAV = null;
    this.previousNAV = null;
    this.todayChangePercent = null;
    this.estimateTime = null;
  }

  get estimatedValue() {
    if (this.estimatedNAV > 0 && this.shares > 0) {
      return this.shares * this.estimatedNAV;
    }
    return null;
  }

  get profit() {
    if (this.estimatedValue !== null) {
      return this.estimatedValue - this.costBasis;
    }
    return null;
  }

  get todayChange() {
    if (this.estimatedNAV !== null && this.previousNAV > 0 && this.shares > 0) {
      return this.shares * (this.estimatedNAV - this.previousNAV);
    }
    return null;
  }

  static formatSigned(value) {
    if (value === null || value === undefined || isNaN(value)) return '--';
    const num = Number(value);
    const formatted = num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return num > 0 ? `+${formatted}` : formatted;
  }

  static formatAmount(value) {
    if (value === null || value === undefined || isNaN(value)) return '--';
    return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  static getTrendClass(value) {
    if (value > 0) return 'trend-up';
    if (value < 0) return 'trend-down';
    return 'trend-flat';
  }
}

export class FundPortfolio {
  constructor(holdings = []) {
    this.holdings = holdings.map(h => {
      const holding = new FundHolding(h.code, h.name, h.costBasis, h.shares);
      if (h.estimatedNAV) holding.estimatedNAV = h.estimatedNAV;
      if (h.previousNAV) holding.previousNAV = h.previousNAV;
      if (h.todayChangePercent) holding.todayChangePercent = h.todayChangePercent;
      if (h.estimateTime) holding.estimateTime = h.estimateTime;
      return holding;
    });
    this.updatedAt = null;
    this.isLoading = true;
  }

  static getDefaults() {
    return [
      { code: "008702", name: "华夏黄金ETF联接C", costBasis: 500.00 },
      { code: "013642", name: "博道成长智航股票C", costBasis: 1000.00 },
      { code: "019594", name: "嘉实稳宁纯债债券A", costBasis: 100069.98 },
      { code: "027300", name: "富国电子信息产业混合发起式C", costBasis: 2000.00 },
      { code: "020341", name: "工银黄金ETF联接E", costBasis: 1000.00 },
    ];
  }

  addFund(code, costBasis) {
    code = code.trim();
    if (!/^\d{6}$/.test(code)) throw new Error("基金代码必须是 6 位数字");
    if (typeof costBasis !== 'number' || !isFinite(costBasis) || costBasis <= 0) throw new Error("金额必须是大于 0 的有效数字");
    if (this.holdings.find(h => h.code === code)) throw new Error("该基金已在持仓列表中");

    this.holdings.push(new FundHolding(code, `基金 ${code}`, costBasis, 0));
  }

  adjustFund(code, amount, isIncrease) {
    code = code.trim();
    if (!/^\d{6}$/.test(code)) throw new Error("基金代码必须是 6 位数字");
    if (typeof amount !== 'number' || !isFinite(amount) || amount <= 0) throw new Error("金额必须是大于 0 的有效数字");
    
    const holding = this.holdings.find(h => h.code === code);
    if (!holding) throw new Error("未找到对应的基金持仓");

    const nav = holding.estimatedNAV || holding.previousNAV;
    if (!nav || !isFinite(nav) || nav <= 0) throw new Error("暂无可用净值，暂时无法调仓");

    if (isIncrease) {
      holding.costBasis += amount;
      holding.shares += amount / nav;
      return;
    }

    if (!holding.shares || !isFinite(holding.shares) || holding.shares <= 0) {
      throw new Error("暂无可用净值，暂时无法调仓");
    }

    const sharesToSell = amount / nav;
    // adding a small epsilon to account for floating point errors
    if (sharesToSell > holding.shares + 0.000001) {
      throw new Error("减仓金额超过当前持有市值");
    }

    const proportion = sharesToSell / holding.shares;
    holding.costBasis -= proportion * holding.costBasis;
    holding.shares -= sharesToSell;

    if (holding.shares < 0.00000001) {
      holding.costBasis = 0;
      holding.shares = 0;
    }
  }

  deleteFund(code) {
    code = code.trim();
    const index = this.holdings.findIndex(h => h.code === code);
    if (index === -1) throw new Error("未找到对应的基金持仓");
    this.holdings.splice(index, 1);
  }

  serialize() {
    return JSON.stringify(this.holdings.map(h => ({
      code: h.code,
      name: h.name,
      costBasis: h.costBasis,
      shares: h.shares
    })));
  }

  static deserialize(jsonStr) {
    try {
      const data = JSON.parse(jsonStr);
      if (!Array.isArray(data)) return null;
      return new FundPortfolio(data);
    } catch {
      return null;
    }
  }
}
