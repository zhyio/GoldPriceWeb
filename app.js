import { FundPortfolio, FundHolding } from './core.js';

// --- State ---
const STORAGE_KEY = 'goldprice_portfolio';
let portfolio = null;
let currentAdjustCode = null;

// --- Supabase Config ---
const SUPABASE_URL = 'https://owqhouyafggdzgcqwlji.supabase.co';
const SUPABASE_KEY = 'sb_publishable_QgsSE7ZoIfcaPsJLlkfS5w_tGvRz_I6';
let supabaseClient = null;
const USER_ID = '87553652@qq.com';
const ROW_ID = 'c5c4ca38-9682-451c-b4da-228de7f8b83b';
let saveTimeout = null;

try {
  if (window.supabase) {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  }
} catch (e) {
  console.warn('Supabase init failed:', e.message);
}

// --- JSONP: Market API (EastMoney push2delay) ---
function fetchMarketJSONP(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const cb = `__mk_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const cleanup = () => {
      delete window[cb];
      if (script.parentNode) script.parentNode.removeChild(script);
    };
    window[cb] = (data) => { cleanup(); resolve(data); };
    script.src = `${url}&cb=${cb}`;
    script.onerror = () => { cleanup(); reject(new Error('Market JSONP failed')); };
    document.body.appendChild(script);
  });
}

// --- JSONP: Fund API (fundgz.1234567.com.cn) ---
// Hardcoded "jsonpgz" callback — matches Swift FundEstimateParser
function fetchFundEstimate(code) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const cleanup = () => {
      delete window.jsonpgz;
      if (script.parentNode) script.parentNode.removeChild(script);
      clearTimeout(timer);
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Fund ${code} timeout`)); }, 8000);
    window.jsonpgz = (data) => { cleanup(); resolve(data); };
    script.src = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
    script.onerror = () => { cleanup(); reject(new Error(`Fund ${code} script error`)); };
    document.body.appendChild(script);
  });
}

// --- Storage ---
async function loadPortfolio() {
  const localData = localStorage.getItem(STORAGE_KEY);
  let p = localData ? FundPortfolio.deserialize(localData) : new FundPortfolio(FundPortfolio.getDefaults());

  if (supabaseClient) {
    try {
      const { data, error } = await supabaseClient
        .from('fitness_data')
        .select('exercises')
        .eq('id', ROW_ID)
        .maybeSingle();
      if (error) throw error;
      if (data && data.exercises && data.exercises.gold_holdings) {
        const cloudStr = typeof data.exercises.gold_holdings === 'string'
          ? data.exercises.gold_holdings
          : JSON.stringify(data.exercises.gold_holdings);
        p = FundPortfolio.deserialize(cloudStr) || p;
        localStorage.setItem(STORAGE_KEY, cloudStr);
      }
    } catch (e) {
      console.warn('Supabase load error:', e.message);
    }
  }
  return p;
}

function savePortfolio() {
  const serialized = portfolio.serialize();
  localStorage.setItem(STORAGE_KEY, serialized);

  if (supabaseClient) {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
      try {
        // Read current exercises, merge in gold_holdings, then update
        const { data: current } = await supabaseClient
          .from('fitness_data')
          .select('exercises')
          .eq('id', ROW_ID)
          .maybeSingle();

        const exercises = (current && current.exercises) ? { ...current.exercises } : {};
        exercises.gold_holdings = serialized;

        await supabaseClient
          .from('fitness_data')
          .update({ exercises, updated_at: new Date().toISOString() })
          .eq('id', ROW_ID);
      } catch (e) {
        console.warn('Supabase save error:', e.message);
      }
    }, 1000);
  }
}

// --- Fetchers ---
async function fetchMarket() {
  try {
    const goldData = await fetchMarketJSONP(
      'https://push2delay.eastmoney.com/api/qt/stock/get?secid=118.AU9999&fields=f43,f59,f60,f169,f170'
    );
    if (goldData && goldData.data) updateMarketUI('gold', goldData.data);
  } catch (e) {
    console.warn('Gold fetch error:', e.message);
  }

  try {
    const indexData = await fetchMarketJSONP(
      'https://push2delay.eastmoney.com/api/qt/stock/get?secid=1.000001&fields=f43,f59,f60,f169,f170'
    );
    if (indexData && indexData.data) updateMarketUI('index', indexData.data);
  } catch (e) {
    console.warn('Index fetch error:', e.message);
  }
}

async function fetchFunds() {
  if (!portfolio || !portfolio.holdings.length) return;

  let anySuccess = false;
  let latestTime = null;

  for (const holding of portfolio.holdings) {
    try {
      const data = await fetchFundEstimate(holding.code);
      if (data && data.fundcode === holding.code) {
        const gsz = parseFloat(data.gsz);
        const dwjz = parseFloat(data.dwjz);
        const gszzl = parseFloat(data.gszzl);

        if (!isNaN(gszzl)) holding.todayChangePercent = gszzl;
        if (!isNaN(gsz) && gsz > 0) holding.estimatedNAV = gsz;
        if (!isNaN(dwjz) && dwjz > 0) holding.previousNAV = dwjz;
        if (data.name) holding.name = data.name;
        if (data.gztime) holding.estimateTime = data.gztime;

        // Auto-calc shares (matches Swift logic)
        if (holding.shares === 0 && holding.costBasis > 0 && holding.estimatedNAV > 0) {
          holding.shares = holding.costBasis / holding.estimatedNAV;
        }

        anySuccess = true;
        if (!latestTime || data.gztime > latestTime) latestTime = data.gztime;
      }
    } catch (e) {
      console.warn(`Fund ${holding.code}:`, e.message);
    }
  }

  if (anySuccess) {
    savePortfolio();
    renderFunds();
    if (latestTime) {
      const el = document.getElementById('update-time');
      if (el) el.textContent = `估值 ${latestTime.substr(11, 5)}`;
    }
  }
}

// --- UI Rendering ---
function updateMarketUI(type, data) {
  if (!data) return;
  const precision = data.f59 || 2;
  const divisor = Math.pow(10, precision);
  const current = data.f43 / divisor;
  const changePercent = data.f170 / 100;

  const priceEl = document.getElementById(`${type}-price`);
  const trendEl = document.getElementById(`${type}-trend`);
  if (!priceEl || !trendEl) return;

  priceEl.textContent = current.toFixed(precision);

  const isUp = changePercent > 0;
  const isDown = changePercent < 0;
  trendEl.className = `trend-badge ${isUp ? 'trend-up' : isDown ? 'trend-down' : 'trend-flat'}`;
  trendEl.textContent = `${isUp ? '+' : ''}${changePercent.toFixed(2)}%`;
}

function renderFunds() {
  const list = document.getElementById('funds-list');
  if (!list) return;
  list.innerHTML = '';

  let totalEarnings = 0;
  let allFailed = true;

  portfolio.holdings.forEach(h => {
    const row = document.createElement('div');
    row.className = 'fund-item';

    const profitClass = FundHolding.getTrendClass(h.profit);
    const todayClass = FundHolding.getTrendClass(h.todayChange);

    row.innerHTML = `
      <div class="fund-info">
        <a href="https://fund.eastmoney.com/${h.code}.html" target="_blank" class="fund-name">${h.name}</a>
        <span class="fund-stats">${h.code} · 持仓 ${FundHolding.formatAmount(h.costBasis)}</span>
      </div>
      <div class="fund-values">
        <span class="fund-profit ${profitClass}">${FundHolding.formatSigned(h.profit)}</span>
        <span class="fund-today ${todayClass}">${FundHolding.formatSigned(h.todayChange)}</span>
      </div>
      <div class="fund-actions">
        <button class="btn-icon adjust-btn" data-code="${h.code}" aria-label="调整">⋯</button>
      </div>
    `;
    list.appendChild(row);

    if (h.todayChange !== null) {
      totalEarnings += h.todayChange;
      allFailed = false;
    }
  });

  const earningsEl = document.getElementById('earnings-value');
  if (!earningsEl) return;

  if (allFailed) {
    earningsEl.textContent = '--';
    earningsEl.className = 'main-price';
    earningsEl.style.color = 'var(--text-muted)';
  } else {
    earningsEl.textContent = FundHolding.formatSigned(totalEarnings);
    earningsEl.className = `main-price ${FundHolding.getTrendClass(totalEarnings)}`;
    earningsEl.style.color = '';
  }
}

// --- Setup interactions (called after DOM ready) ---
function setupInteractions() {
  const addDialog = document.getElementById('add-fund-dialog');
  const adjustDialog = document.getElementById('adjust-fund-dialog');

  if (!addDialog || !adjustDialog) {
    console.error('Dialog elements not found');
    return;
  }

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
      fetchFunds();
    } catch (e) {
      document.getElementById('add-error').textContent = e.message;
    }
  });

  document.getElementById('funds-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.adjust-btn');
    if (btn) {
      const code = btn.dataset.code;
      currentAdjustCode = code;
      const holding = portfolio.holdings.find(h => h.code === code);
      if (!holding) return;
      document.getElementById('adjust-fund-name').textContent = holding.name;
      document.getElementById('adjust-fund-cost').textContent = FundHolding.formatAmount(holding.costBasis);
      document.getElementById('adjust-amount').value = '';
      document.getElementById('adjust-error').textContent = '';
      adjustDialog.showModal();
    }
  });

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

  // Close on backdrop click
  addDialog.addEventListener('click', (e) => { if (e.target === addDialog) addDialog.close(); });
  adjustDialog.addEventListener('click', (e) => { if (e.target === adjustDialog) adjustDialog.close(); });
}

// --- Init ---
async function start() {
  portfolio = await loadPortfolio();
  renderFunds();
  fetchMarket();
  fetchFunds();
  setInterval(fetchMarket, 5000);
  setInterval(fetchFunds, 60000);
}

// Ensure DOM is ready before binding anything
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { setupInteractions(); start(); });
} else {
  setupInteractions();
  start();
}
