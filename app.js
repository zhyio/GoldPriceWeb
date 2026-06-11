import { FundPortfolio, FundHolding } from './core.js';

// --- State ---
const STORAGE_KEY = 'goldprice_portfolio';
let portfolio = null;
let currentAdjustCode = null;

// --- Supabase Config ---
const SUPABASE_URL = 'https://owqhouyafggdzgcqwlji.supabase.co';
const SUPABASE_KEY = 'sb_publishable_QgsSE7ZoIfcaPsJLlkfS5w_tGvRz_I6';
const supabaseClient = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;
const USER_ID = 'goldprice_web';
let dbRecordId = null;
let saveTimeout = null;

// --- JSONP Utility (matches original Swift project's approach) ---
// EastMoney market API supports a configurable callback parameter named "cb"
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

// Fund estimate API (fundgz.1234567.com.cn) uses a HARDCODED callback name "jsonpgz"
// This matches the Swift parser: FundEstimateParser.parse expects "jsonpgz(...)"
function fetchFundEstimate(code) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timestamp = Date.now();

    const cleanup = () => {
      delete window.jsonpgz;
      if (script.parentNode) script.parentNode.removeChild(script);
    };

    window.jsonpgz = (data) => { cleanup(); resolve(data); };
    script.src = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${timestamp}`;
    script.onerror = () => { cleanup(); reject(new Error(`Fund ${code} fetch failed`)); };

    // Timeout: if no response in 8s (matching Swift's 8s timeout), reject
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Fund ${code} timed out`)); }, 8000);
    const origResolve = window.jsonpgz;
    window.jsonpgz = (data) => { clearTimeout(timer); origResolve(data); };

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
        .select('*')
        .eq('user_id', USER_ID)
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      if (data) {
        dbRecordId = data.id;
        if (data.exercises && data.exercises.holdings) {
          p = FundPortfolio.deserialize(data.exercises.holdings) || p;
          localStorage.setItem(STORAGE_KEY, data.exercises.holdings);
        }
      }
    } catch (e) {
      console.warn('Supabase load failed, using local cache:', e.message);
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
        const payload = {
          user_id: USER_ID,
          exercises: { holdings: serialized },
          updated_at: new Date().toISOString()
        };
        if (dbRecordId) {
          await supabaseClient.from('fitness_data').update(payload).eq('id', dbRecordId);
        } else {
          const { data } = await supabaseClient.from('fitness_data').insert([payload]).select().single();
          if (data) dbRecordId = data.id;
        }
      } catch (e) {
        console.warn('Supabase save failed:', e.message);
      }
    }, 1000);
  }
}

// --- Fetchers ---
// Market: uses the EXACT same URLs as the Swift MarketService.swift
async function fetchMarket() {
  try {
    const goldData = await fetchMarketJSONP(
      'https://push2delay.eastmoney.com/api/qt/stock/get?secid=118.AU9999&fields=f43,f59,f60,f169,f170'
    );
    updateMarketUI('gold', goldData?.data);
  } catch (e) {
    console.warn('Gold fetch failed:', e.message);
  }

  try {
    const indexData = await fetchMarketJSONP(
      'https://push2delay.eastmoney.com/api/qt/stock/get?secid=1.000001&fields=f43,f59,f60,f169,f170'
    );
    updateMarketUI('index', indexData?.data);
  } catch (e) {
    console.warn('Index fetch failed:', e.message);
  }
}

// Fund: fetches one at a time (serial) because jsonpgz is a global singleton callback
// This matches the Swift FundService.swift logic
async function fetchFunds() {
  let anySuccess = false;
  let latestTime = null;

  for (const holding of portfolio.holdings) {
    try {
      const data = await fetchFundEstimate(holding.code);

      if (data && data.fundcode === holding.code) {
        // Parse exactly like FundEstimateResponse in FundModels.swift
        const gsz = parseFloat(data.gsz);
        const dwjz = parseFloat(data.dwjz);
        const gszzl = parseFloat(data.gszzl);

        if (!isNaN(gszzl)) {
          holding.todayChangePercent = gszzl;
        }
        if (!isNaN(gsz) && gsz > 0) {
          holding.estimatedNAV = gsz;
        }
        if (!isNaN(dwjz) && dwjz > 0) {
          holding.previousNAV = dwjz;
        }
        if (data.name) {
          holding.name = data.name;
        }
        if (data.gztime) {
          holding.estimateTime = data.gztime;
        }

        // Auto-calculate shares if 0 (matching Swift: shares == 0 && costBasis > 0 && nav > 0)
        if (holding.shares === 0 && holding.costBasis > 0 && holding.estimatedNAV > 0) {
          holding.shares = holding.costBasis / holding.estimatedNAV;
        }

        anySuccess = true;
        if (!latestTime || data.gztime > latestTime) {
          latestTime = data.gztime;
        }
      }
    } catch (e) {
      console.warn(`Fund ${holding.code} failed:`, e.message);
    }
  }

  if (anySuccess) {
    savePortfolio();
    renderFunds();
    if (latestTime) {
      document.getElementById('update-time').textContent = `估值 ${latestTime.substr(11, 5)}`;
    }
  }
}

// --- UI Rendering ---
// Market UI: matches Swift MarketModels.swift parsing
// f43 = current price (raw int), f59 = precision, f169 = change amount, f170 = change percent
// All divided by 10^precision (precision from f59)
function updateMarketUI(type, data) {
  if (!data) return;

  const precision = data.f59 || 2;
  const divisor = Math.pow(10, precision);
  const current = data.f43 / divisor;
  const changePercent = data.f170 / 100; // f170 is already *100 in raw data

  const priceEl = document.getElementById(`${type}-price`);
  const trendEl = document.getElementById(`${type}-trend`);

  priceEl.textContent = current.toFixed(precision);

  const isUp = changePercent > 0;
  const isDown = changePercent < 0;
  const trendClass = isUp ? 'trend-up' : isDown ? 'trend-down' : 'trend-flat';
  trendEl.className = `trend-badge ${trendClass}`;

  const sign = isUp ? '+' : '';
  trendEl.textContent = `${sign}${changePercent.toFixed(2)}%`;
}

function renderFunds() {
  const list = document.getElementById('funds-list');
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

  // Update earnings hero card
  const earningsEl = document.getElementById('earnings-value');

  if (allFailed) {
    earningsEl.textContent = '--';
    earningsEl.className = 'main-price';
    earningsEl.style.color = 'var(--text-muted)';
  } else {
    earningsEl.textContent = FundHolding.formatSigned(totalEarnings);
    const trendClass = FundHolding.getTrendClass(totalEarnings);
    earningsEl.className = `main-price ${trendClass}`;
    earningsEl.style.color = '';
  }
}

// --- Interactions ---
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
    fetchFunds();
  } catch (e) {
    document.getElementById('add-error').textContent = e.message;
  }
});

const adjustDialog = document.getElementById('adjust-fund-dialog');

document.getElementById('funds-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.adjust-btn');
  if (btn) {
    const code = btn.dataset.code;
    currentAdjustCode = code;
    const holding = portfolio.holdings.find(h => h.code === code);
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

// Close dialogs on backdrop click
addDialog.addEventListener('click', (e) => { if (e.target === addDialog) addDialog.close(); });
adjustDialog.addEventListener('click', (e) => { if (e.target === adjustDialog) adjustDialog.close(); });

// --- Initialization ---
async function start() {
  portfolio = await loadPortfolio();
  renderFunds();
  fetchMarket();
  fetchFunds();

  setInterval(fetchMarket, 5000);
  setInterval(fetchFunds, 60000);
}

start();
