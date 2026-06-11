import { FundPortfolio, FundHolding } from './core.js';

// --- State ---
const STORAGE_KEY = 'goldprice_portfolio';
let portfolio = loadPortfolio();
let isFundsExpanded = true;
let currentAdjustCode = null;

// --- JSONP Utility ---
function fetchJSONP(url, callbackName) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const cb = `jsonp_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    
    window[cb] = (data) => {
      delete window[cb];
      document.body.removeChild(script);
      resolve(data);
    };

    script.src = `${url}${url.includes('?') ? '&' : '?'}${callbackName}=${cb}`;
    script.onerror = () => {
      delete window[cb];
      document.body.removeChild(script);
      reject(new Error(`JSONP failed for ${url}`));
    };

    document.body.appendChild(script);
  });
}

// --- Storage ---
function loadPortfolio() {
  const data = localStorage.getItem(STORAGE_KEY);
  if (data) {
    const p = FundPortfolio.deserialize(data);
    if (p) return p;
  }
  return new FundPortfolio(FundPortfolio.getDefaults());
}

function savePortfolio() {
  localStorage.setItem(STORAGE_KEY, portfolio.serialize());
}

// --- Fetchers ---
async function fetchMarket() {
  try {
    // AU9999
    const auUrl = 'https://push2delay.eastmoney.com/api/qt/stock/get?secid=118.AU9999&fields=f43,f59,f60,f169,f170';
    const auData = await fetchJSONP(auUrl, 'cb');
    updateMarketUI('gold', auData.data);

    // Shanghai Index
    const shUrl = 'https://push2delay.eastmoney.com/api/qt/stock/get?secid=1.000001&fields=f43,f59,f60,f169,f170';
    const shData = await fetchJSONP(shUrl, 'cb');
    updateMarketUI('index', shData.data);
  } catch (error) {
    console.error('Market fetch failed', error);
  }
}

async function fetchFunds() {
  let anySuccess = false;
  let latestTime = null;

  for (const holding of portfolio.holdings) {
    try {
      const url = `https://fundgz.1234567.com.cn/js/${holding.code}.js`;
      // fundgz returns jsonpgz({ ... })
      const script = document.createElement('script');
      
      const promise = new Promise((resolve, reject) => {
        window['jsonpgz'] = (data) => resolve(data);
        script.src = `${url}?rt=${Date.now()}`;
        script.onerror = () => reject(new Error('fund fetch failed'));
        document.body.appendChild(script);
      });

      const data = await promise;
      document.body.removeChild(script);
      delete window['jsonpgz'];

      if (data && data.fundcode === holding.code) {
        holding.name = data.name;
        holding.estimatedNAV = parseFloat(data.gsz);
        holding.previousNAV = parseFloat(data.dwjz);
        holding.todayChangePercent = parseFloat(data.gszzl);
        holding.estimateTime = data.gztime;
        anySuccess = true;

        if (!latestTime || data.gztime > latestTime) {
          latestTime = data.gztime;
        }
      }
    } catch (e) {
      console.warn(`Failed to fetch fund ${holding.code}`, e);
    }
  }

  if (anySuccess) {
    savePortfolio();
    renderFunds();
    if (latestTime) {
      document.getElementById('update-time').textContent = `估值时间 ${latestTime.substr(11, 5)}`;
    }
  }
}

// --- UI Rendering ---
function updateMarketUI(type, data) {
  if (!data) return;
  const current = data.f43 / 100;
  const change = data.f169 / 100;
  const changePercent = data.f170 / 100;

  const priceEl = document.getElementById(`${type}-price`);
  const trendEl = document.getElementById(`${type}-trend`);
  
  priceEl.textContent = current.toFixed(2);
  
  const isUp = change > 0;
  const isDown = change < 0;
  
  trendEl.className = `trend ${isUp ? 'trend-up' : isDown ? 'trend-down' : 'trend-flat'}`;
  
  const symbol = isUp ? '↑' : isDown ? '↓' : '—';
  const valText = `${Math.abs(change).toFixed(2)} (${Math.abs(changePercent).toFixed(2)}%)`;
  
  trendEl.querySelector('.symbol').textContent = symbol;
  trendEl.querySelector('.value').textContent = valText;
}

function renderFunds() {
  const list = document.getElementById('funds-list');
  list.innerHTML = '';

  let totalEarnings = 0;
  let allFailed = true;

  portfolio.holdings.forEach(h => {
    const row = document.createElement('div');
    row.className = 'fund-row';
    
    // Name
    const nameCol = document.createElement('a');
    nameCol.className = 'fund-name-col';
    nameCol.href = `https://fund.eastmoney.com/${h.code}.html`;
    nameCol.target = '_blank';
    nameCol.title = '单击查看基金详情';
    nameCol.innerHTML = `
      <span class="fund-name">${h.name}</span>
      <span class="fund-code">${h.code}</span>
    `;

    const spacer = document.createElement('div');
    spacer.className = 'spacer';

    // Cost
    const costCol = document.createElement('div');
    costCol.className = 'fund-cost-col fund-val';
    costCol.textContent = FundHolding.formatAmount(h.costBasis);

    // Profit
    const profitCol = document.createElement('div');
    profitCol.className = `fund-profit-col fund-val ${FundHolding.getTrendClass(h.profit)}`;
    profitCol.textContent = FundHolding.formatSigned(h.profit);

    // Today
    const todayCol = document.createElement('div');
    todayCol.className = `fund-today-col fund-val ${FundHolding.getTrendClass(h.todayChange)}`;
    todayCol.textContent = FundHolding.formatSigned(h.todayChange);

    // Action
    const actionCol = document.createElement('div');
    actionCol.className = 'fund-action-col';
    const btn = document.createElement('button');
    btn.className = 'action-btn';
    btn.innerHTML = '⋯';
    btn.onclick = () => openAdjustDialog(h.code);
    actionCol.appendChild(btn);

    row.append(nameCol, spacer, costCol, profitCol, todayCol, actionCol);
    list.appendChild(row);

    if (h.todayChange !== null) {
      totalEarnings += h.todayChange;
      allFailed = false;
    }
  });

  // Update total earnings
  const earningsEl = document.getElementById('earnings-value');
  const dotEl = document.getElementById('earnings-dot');
  
  if (allFailed) {
    earningsEl.textContent = '--';
    earningsEl.style.color = 'var(--text-muted)';
    dotEl.className = 'dot earnings trend-flat';
  } else {
    earningsEl.textContent = FundHolding.formatSigned(totalEarnings);
    earningsEl.className = `price ${FundHolding.getTrendClass(totalEarnings)}`;
    earningsEl.style.color = '';
    
    // Update dot color
    dotEl.className = 'dot earnings';
    if (totalEarnings > 0) dotEl.style.backgroundColor = 'var(--color-up)';
    else if (totalEarnings < 0) dotEl.style.backgroundColor = 'var(--color-down)';
    else dotEl.style.backgroundColor = 'var(--color-flat)';
  }
}

// --- Interactions ---
document.getElementById('toggle-btn').addEventListener('click', (e) => {
  isFundsExpanded = !isFundsExpanded;
  document.getElementById('funds-section').style.display = isFundsExpanded ? 'flex' : 'none';
  e.target.textContent = isFundsExpanded ? '▲' : '▼';
  e.target.title = isFundsExpanded ? '收起基金列表' : '展开基金列表';
});

// Add Fund
const addDialog = document.getElementById('add-fund-dialog');
document.getElementById('add-fund-btn').addEventListener('click', () => {
  document.getElementById('add-code').value = '';
  document.getElementById('add-amount').value = '';
  document.getElementById('add-error').textContent = '';
  addDialog.showModal();
});
document.getElementById('add-cancel-btn').addEventListener('click', () => addDialog.close());
document.getElementById('add-submit-btn').addEventListener('click', () => {
  try {
    const code = document.getElementById('add-code').value;
    const amount = parseFloat(document.getElementById('add-amount').value);
    portfolio.addFund(code, amount);
    savePortfolio();
    addDialog.close();
    renderFunds();
    fetchFunds(); // Fetch newly added
  } catch (e) {
    document.getElementById('add-error').textContent = e.message;
  }
});

// Adjust Fund
const adjustDialog = document.getElementById('adjust-fund-dialog');
function openAdjustDialog(code) {
  currentAdjustCode = code;
  const holding = portfolio.holdings.find(h => h.code === code);
  document.getElementById('adjust-fund-name').textContent = holding.name;
  document.getElementById('adjust-fund-cost').textContent = FundHolding.formatAmount(holding.costBasis);
  document.getElementById('adjust-amount').value = '';
  document.getElementById('adjust-error').textContent = '';
  adjustDialog.showModal();
}

document.getElementById('adjust-cancel-btn').addEventListener('click', () => adjustDialog.close());
document.getElementById('adjust-increase-btn').addEventListener('click', () => handleAdjust(true));
document.getElementById('adjust-decrease-btn').addEventListener('click', () => handleAdjust(false));
document.getElementById('adjust-delete-btn').addEventListener('click', () => {
  if (confirm('确认删除此基金吗？')) {
    portfolio.deleteFund(currentAdjustCode);
    savePortfolio();
    adjustDialog.close();
    renderFunds();
  }
});

function handleAdjust(isIncrease) {
  try {
    const amount = parseFloat(document.getElementById('adjust-amount').value);
    portfolio.adjustFund(currentAdjustCode, amount, isIncrease);
    savePortfolio();
    adjustDialog.close();
    renderFunds();
  } catch (e) {
    document.getElementById('adjust-error').textContent = e.message;
  }
}

// --- Initialization ---
function start() {
  renderFunds();
  fetchMarket();
  fetchFunds();
  
  setInterval(fetchMarket, 5000);
  setInterval(fetchFunds, 60000);
}

start();
