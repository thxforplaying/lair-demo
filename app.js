// ===== Configuration =====
const API_BASE = 'https://api.coingecko.com/api/v3';
const REFRESH_INTERVAL = 60_000; // 60 seconds

// ===== State =====
const state = {
  coins: [],
  filteredCoins: [],
  currency: 'usd',
  perPage: 100,
  page: 1,
  sortKey: 'market_cap_rank',
  sortDir: 'asc',
  searchQuery: '',
  loading: false,
  refreshTimer: null,
  previousPrices: new Map(),
};

// ===== Currency symbols =====
const currencySymbols = {
  usd: '$', eur: '€', gbp: '£', jpy: '¥', inr: '₹', btc: '₿',
};

// ===== DOM Elements =====
const $ = (sel) => document.querySelector(sel);
const tableBody = $('#cryptoTableBody');
const loadingOverlay = $('#loadingOverlay');
const errorBanner = $('#errorBanner');
const errorMessage = $('#errorMessage');
const searchInput = $('#searchInput');
const currencySelect = $('#currencySelect');
const perPageSelect = $('#perPageSelect');
const refreshBtn = $('#refreshBtn');
const prevPageBtn = $('#prevPage');
const nextPageBtn = $('#nextPage');
const pageInfo = $('#pageInfo');

// ===== Formatting Utilities =====
function formatCurrency(value, currency) {
  if (value == null) return '—';
  const sym = currencySymbols[currency] || '';

  if (currency === 'btc') {
    return `${sym}${value.toFixed(8)}`;
  }

  if (Math.abs(value) >= 1) {
    return `${sym}${value.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  // For very small prices (< $1), show more decimals
  const decimals = Math.abs(value) < 0.01 ? 6 : 4;
  return `${sym}${value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function formatLargeNumber(value) {
  if (value == null) return '—';
  if (value >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return value.toLocaleString('en-US');
}

function formatPercent(value) {
  if (value == null) return '—';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function formatSupply(value, symbol) {
  if (value == null) return '—';
  return `${formatLargeNumber(value)} ${symbol.toUpperCase()}`;
}

// ===== Sparkline Drawing =====
function drawSparkline(canvas, data, isPositive) {
  if (!data || data.length === 0) return;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;

  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const color = isPositive ? '#3fb950' : '#f85149';

  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';

  const step = w / (data.length - 1);
  for (let i = 0; i < data.length; i++) {
    const x = i * step;
    const y = h - ((data[i] - min) / range) * (h - 4) - 2;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Gradient fill
  const gradient = ctx.createLinearGradient(0, 0, 0, h);
  gradient.addColorStop(0, isPositive ? 'rgba(63,185,80,0.15)' : 'rgba(248,81,73,0.15)');
  gradient.addColorStop(1, 'transparent');

  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();
}

// ===== API Calls =====
async function fetchWithRetry(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        // Rate limited — wait and retry
        const wait = Math.min(2000 * (i + 1), 10000);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return await res.json();
    } catch (err) {
      if (i === retries) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

async function fetchCoins() {
  const url = `${API_BASE}/coins/markets?vs_currency=${encodeURIComponent(state.currency)}&order=market_cap_desc&per_page=${state.perPage}&page=${state.page}&sparkline=true&price_change_percentage=1h%2C24h%2C7d`;
  return fetchWithRetry(url);
}

async function fetchGlobalData() {
  return fetchWithRetry(`${API_BASE}/global`);
}

// ===== Rendering =====
function showLoading(show) {
  state.loading = show;
  if (show) {
    loadingOverlay.classList.remove('hidden');
    loadingOverlay.style.display = 'flex';
  } else {
    loadingOverlay.classList.add('hidden');
    loadingOverlay.style.display = 'none';
  }
}

function showError(message) {
  errorMessage.textContent = message;
  errorBanner.style.display = 'flex';
}

function hideError() {
  errorBanner.style.display = 'none';
}

function renderGlobalStats(data) {
  if (!data || !data.data) return;
  const d = data.data;
  $('#statCryptos').textContent = (d.active_cryptocurrencies || 0).toLocaleString();
  $('#statMarkets').textContent = (d.markets || 0).toLocaleString();
  $('#statMarketCap').textContent = `$${formatLargeNumber(d.total_market_cap?.usd)}`;
  $('#statVolume').textContent = `$${formatLargeNumber(d.total_volume?.usd)}`;
  $('#statBtcDom').textContent = `${(d.market_cap_percentage?.btc || 0).toFixed(1)}%`;
}

function createCoinRow(coin) {
  const tr = document.createElement('tr');
  tr.dataset.id = coin.id;

  const change1h = coin.price_change_percentage_1h_in_currency;
  const change24h = coin.price_change_percentage_24h;
  const change7d = coin.price_change_percentage_7d_in_currency;

  const sparklineData = coin.sparkline_in_7d?.price || [];
  const sparklinePositive = change7d != null ? change7d >= 0 : true;

  tr.innerHTML = `
    <td class="td-rank">${coin.market_cap_rank || '—'}</td>
    <td class="td-name">
      <div class="coin-info">
        <img class="coin-img" src="${escapeAttr(coin.image)}" alt="${escapeAttr(coin.name)}" loading="lazy" width="28" height="28" />
        <span>
          <span class="coin-name">${escapeHtml(coin.name)}</span>
          <span class="coin-symbol">${escapeHtml(coin.symbol)}</span>
        </span>
      </div>
    </td>
    <td class="td-price">${formatCurrency(coin.current_price, state.currency)}</td>
    <td class="td-change ${changeClass(change1h)}">${formatPercent(change1h)}</td>
    <td class="td-change ${changeClass(change24h)}">${formatPercent(change24h)}</td>
    <td class="td-change ${changeClass(change7d)}">${formatPercent(change7d)}</td>
    <td class="td-mcap">${currencySymbols[state.currency]}${formatLargeNumber(coin.market_cap)}</td>
    <td class="td-vol">${currencySymbols[state.currency]}${formatLargeNumber(coin.total_volume)}</td>
    <td class="td-supply">${formatSupply(coin.circulating_supply, coin.symbol)}</td>
    <td class="td-chart"><canvas class="sparkline-canvas" width="140" height="40"></canvas></td>
  `;

  // Price flash animation
  const prevPrice = state.previousPrices.get(coin.id);
  if (prevPrice != null && coin.current_price != null && prevPrice !== coin.current_price) {
    const priceCell = tr.querySelector('.td-price');
    priceCell.classList.add(coin.current_price > prevPrice ? 'flash-up' : 'flash-down');
  }

  // Draw sparkline after insertion
  requestAnimationFrame(() => {
    const canvas = tr.querySelector('.sparkline-canvas');
    if (canvas && sparklineData.length > 0) {
      drawSparkline(canvas, sparklineData, sparklinePositive);
    }
  });

  return tr;
}

function changeClass(value) {
  if (value == null) return '';
  return value >= 0 ? 'change-positive' : 'change-negative';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderTable(coins) {
  tableBody.innerHTML = '';

  if (coins.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="10" style="text-align:center; padding:40px; color:var(--text-muted);">No cryptocurrencies found.</td>`;
    tableBody.appendChild(tr);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const coin of coins) {
    fragment.appendChild(createCoinRow(coin));
  }
  tableBody.appendChild(fragment);
}

function renderSkeletonRows(count = 10) {
  tableBody.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const tr = document.createElement('tr');
    tr.className = 'skeleton-row';
    tr.innerHTML = Array(10)
      .fill('<td><span class="skeleton-bar"></span></td>')
      .join('');
    tableBody.appendChild(tr);
  }
}

function updatePagination() {
  pageInfo.textContent = `Page ${state.page}`;
  prevPageBtn.disabled = state.page <= 1;
  // Disable next if fewer results than perPage
  nextPageBtn.disabled = state.coins.length < state.perPage;
}

// ===== Sorting =====
function sortCoins(coins) {
  const key = state.sortKey;
  const dir = state.sortDir === 'asc' ? 1 : -1;

  return [...coins].sort((a, b) => {
    let va = a[key];
    let vb = b[key];

    if (key === 'name') {
      va = (va || '').toLowerCase();
      vb = (vb || '').toLowerCase();
      return dir * va.localeCompare(vb);
    }

    va = va ?? -Infinity;
    vb = vb ?? -Infinity;
    return dir * (va - vb);
  });
}

function updateSortHeaders() {
  document.querySelectorAll('th.sortable').forEach((th) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === state.sortKey) {
      th.classList.add(state.sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });
}

// ===== Search/Filter =====
function filterCoins(coins, query) {
  if (!query) return coins;
  const q = query.toLowerCase().trim();
  return coins.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      c.symbol.toLowerCase().includes(q) ||
      c.id.toLowerCase().includes(q)
  );
}

// ===== Main Data Fetch =====
async function loadData(showSkeleton = true) {
  if (state.loading) return;

  hideError();
  if (showSkeleton) renderSkeletonRows();
  showLoading(true);
  refreshBtn.classList.add('spinning');

  try {
    const [coins, globalData] = await Promise.all([
      fetchCoins(),
      state.page === 1 ? fetchGlobalData() : Promise.resolve(null),
    ]);

    // Save previous prices
    for (const c of state.coins) {
      if (c.current_price != null) {
        state.previousPrices.set(c.id, c.current_price);
      }
    }

    state.coins = coins;
    if (globalData) renderGlobalStats(globalData);

    applyFiltersAndRender();
  } catch (err) {
    console.error('Failed to fetch data:', err);
    showError(`Failed to load data: ${err.message}. CoinGecko free API has rate limits — please wait a moment and retry.`);
    if (state.coins.length === 0) {
      tableBody.innerHTML = '';
    }
  } finally {
    showLoading(false);
    refreshBtn.classList.remove('spinning');
  }
}

function applyFiltersAndRender() {
  let coins = filterCoins(state.coins, state.searchQuery);
  coins = sortCoins(coins);
  state.filteredCoins = coins;
  renderTable(coins);
  updatePagination();
}

// ===== Auto-refresh =====
function startAutoRefresh() {
  stopAutoRefresh();
  state.refreshTimer = setInterval(() => loadData(false), REFRESH_INTERVAL);
}

function stopAutoRefresh() {
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
}

// ===== Event Listeners =====
function initEventListeners() {
  // Search
  let searchTimeout;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      state.searchQuery = searchInput.value;
      applyFiltersAndRender();
    }, 250);
  });

  // Currency change
  currencySelect.addEventListener('change', () => {
    state.currency = currencySelect.value;
    state.page = 1;
    loadData();
    startAutoRefresh();
  });

  // Per page
  perPageSelect.addEventListener('change', () => {
    state.perPage = parseInt(perPageSelect.value, 10);
    state.page = 1;
    loadData();
    startAutoRefresh();
  });

  // Refresh
  refreshBtn.addEventListener('click', () => {
    loadData(false);
    startAutoRefresh();
  });

  // Pagination
  prevPageBtn.addEventListener('click', () => {
    if (state.page > 1) {
      state.page--;
      loadData();
    }
  });

  nextPageBtn.addEventListener('click', () => {
    state.page++;
    loadData();
  });

  // Sorting
  document.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortKey = key;
        state.sortDir = key === 'name' ? 'asc' : 'asc';
      }
      updateSortHeaders();
      applyFiltersAndRender();
    });
  });

  // Error retry
  $('#errorRetry').addEventListener('click', () => {
    loadData();
    startAutoRefresh();
  });
}

// ===== Init =====
function init() {
  initEventListeners();
  updateSortHeaders();
  loadData();
  startAutoRefresh();
}

document.addEventListener('DOMContentLoaded', init);
