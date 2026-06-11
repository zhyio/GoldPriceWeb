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
      console.warn('Failed to load from Supabase', e);
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
        console.warn('Failed to save to Supabase', e);
      }
    }, 1000);
  }
}

// --- Fetchers ---
async function fetchMarket() {
  try {
    const auUrl = 'https://push2delay.eastmoney.com/api/qt/stock/get?secid=118.AU9999&fields=f43,f59,f60,f169,f170';
    const auData = await fetchJSONP(auUrl, 'cb');
    updateMarketUI('gold', auData.data);

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
      document.getElementById('update-time').textContent = `估值 ${latestTime.substr(11, 5)}`;
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
  const trendClass = isUp ? 'trend-up' : isDown ? 'trend-down' : 'trend-flat';
  
  // Gold uses trend-badge class, index uses trend class
  const baseClass = type === 'gold' ? 'trend-badge' : 'trend';
  trendEl.className = `${baseClass} ${trendClass}`;
  
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

  // Update earnings card
  const earningsEl = document.getElementById('earnings-value');
  
  if (allFailed) {
    earningsEl.textContent = '--';
    earningsEl.className = 'main-price small';
    earningsEl.style.color = 'var(--text-muted)';
  } else {
    earningsEl.textContent = FundHolding.formatSigned(totalEarnings);
    earningsEl.className = `main-price small ${FundHolding.getTrendClass(totalEarnings)}`;
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
addDialog.addEventListener('click', (e) => {
  if (e.target === addDialog) addDialog.close();
});
adjustDialog.addEventListener('click', (e) => {
  if (e.target === adjustDialog) adjustDialog.close();
});

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
