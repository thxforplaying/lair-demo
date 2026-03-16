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

  const count = d.active_cryptocurrencies;
  if (count) $('#heroCryptoCount').textContent = count.toLocaleString();
}

// ===== Ticker Bar =====
function renderTicker(coins) {
  const track = $('#tickerTrack');
  if (!track || !coins.length) return;

  const top20 = coins.slice(0, 20);

  // Build items twice for seamless loop
  const makeItems = () =>
    top20
      .map((c) => {
        const change = c.price_change_percentage_24h;
        const cls = change >= 0 ? 'change-positive' : 'change-negative';
        const sign = change >= 0 ? '+' : '';
        return `
        <span class="ticker-item">
          <img src="${escapeAttr(c.image)}" alt="${escapeAttr(c.symbol)}" />
          <span class="ticker-name">${escapeHtml(c.symbol.toUpperCase())}</span>
          <span class="ticker-price">${formatCurrency(c.current_price, 'usd')}</span>
          <span class="ticker-change ${cls}">${sign}${(change || 0).toFixed(2)}%</span>
        </span>`;
      })
      .join('');

  track.innerHTML = makeItems() + makeItems();

  // Adjust animation speed based on content width
  const itemWidth = 160;
  const totalWidth = top20.length * itemWidth;
  const duration = Math.max(30, totalWidth / 3);
  track.style.animationDuration = `${duration}s`;
}

// ===== Hero Market Cards =====
const HERO_COINS = [
  { id: 'bitcoin',  priceEl: '#cardBtcPrice', changeEl: '#cardBtcChange', chartEl: '#cardBtcChart' },
  { id: 'ethereum', priceEl: '#cardEthPrice', changeEl: '#cardEthChange', chartEl: '#cardEthChart' },
  { id: 'solana',   priceEl: '#cardSolPrice', changeEl: '#cardSolChange', chartEl: '#cardSolChart' },
  { id: 'binancecoin', priceEl: '#cardBnbPrice', changeEl: '#cardBnbChange', chartEl: '#cardBnbChart' },
];

function renderHeroCards(coins) {
  for (const hero of HERO_COINS) {
    const coin = coins.find((c) => c.id === hero.id);
    if (!coin) continue;

    const priceEl  = $(hero.priceEl);
    const changeEl = $(hero.changeEl);
    const chartEl  = $(hero.chartEl);

    if (priceEl)  priceEl.textContent  = formatCurrency(coin.current_price, 'usd');

    if (changeEl) {
      const ch = coin.price_change_percentage_24h;
      const sign = ch >= 0 ? '+' : '';
      changeEl.textContent  = `${sign}${(ch || 0).toFixed(2)}%`;
      changeEl.className    = `mc-change ${ch >= 0 ? 'change-positive' : 'change-negative'}`;
    }

    if (chartEl) {
      const sparklineData = coin.sparkline_in_7d?.price || [];
      if (sparklineData.length) {
        const isPos = (coin.price_change_percentage_7d_in_currency ?? coin.price_change_percentage_24h ?? 0) >= 0;
        requestAnimationFrame(() => drawSparkline(chartEl, sparklineData, isPos));
      }
    }
  }
}

function createCoinRow(coin) {
  const tr = document.createElement('tr');
  tr.dataset.id = coin.id;

  tr.style.cursor = 'pointer';
  tr.setAttribute('tabindex', '0');
  tr.setAttribute('role', 'button');
  tr.setAttribute('aria-label', `View details for ${coin.name}`);
  tr.addEventListener('click', () => {
    window.location.hash = `coin-${coin.id}`;
  });
  tr.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      window.location.hash = `coin-${coin.id}`;
    }
  });

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
  renderTicker(state.coins);
  renderHeroCards(state.coins);
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

  // Back button
  document.getElementById('backBtn').addEventListener('click', () => {
    window.location.hash = '';
  });

  // Detail error retry
  document.getElementById('detailRetry').addEventListener('click', () => {
    const coinId = getHashCoinId();
    if (coinId) showCoinDetail(coinId);
  });
}

// ===== Hash Routing =====
function getHashCoinId() {
  const hash = window.location.hash;
  if (hash.startsWith('#coin-')) return decodeURIComponent(hash.slice(6));
  return null;
}

function handleRouteChange() {
  const coinId = getHashCoinId();
  if (coinId) {
    showCoinDetail(coinId);
  } else {
    showMainView();
  }
}

function showMainView() {
  stopAutoRefresh();
  document.getElementById('mainView').style.display = '';
  document.getElementById('coinDetail').classList.add('hidden');
  document.title = 'CryptoTracker — Live Cryptocurrency Prices';
  if (state.coins.length > 0) {
    applyFiltersAndRender();
  } else {
    loadData();
  }
  startAutoRefresh();
}

// ===== Detail State =====
const detailState = {
  coinId: null,
  days: 7,
};

// ===== Safety Helpers =====
function stripHtml(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html || '';
  return tmp.textContent || '';
}

function safeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  if (url.startsWith('https://') || url.startsWith('http://')) return url;
  return null;
}

// ===== Detail API Calls =====
async function fetchCoinDetail(coinId) {
  return fetchWithRetry(
    `${API_BASE}/coins/${encodeURIComponent(coinId)}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`
  );
}

async function fetchPriceHistory(coinId, days) {
  return fetchWithRetry(
    `${API_BASE}/coins/${encodeURIComponent(coinId)}/market_chart?vs_currency=${encodeURIComponent(state.currency)}&days=${days}`
  );
}

// ===== Detail Chart =====
function downsample(data, maxPoints) {
  if (data.length <= maxPoints) return data;
  const step = data.length / maxPoints;
  return Array.from({ length: maxPoints }, (_, i) => data[Math.round(i * step)]);
}

function drawDetailChart(canvas, prices, isPositive) {
  if (!prices || prices.length < 2) return;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const W = rect.width;
  const H = rect.height;

  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.scale(dpr, dpr);

  const PAD_LEFT = 80;
  const PAD_RIGHT = 16;
  const PAD_TOP = 16;
  const PAD_BOTTOM = 36;

  const sampled = downsample(prices, 500);
  const values = sampled.map((p) => p[1]);
  const times = sampled.map((p) => p[0]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const chartW = W - PAD_LEFT - PAD_RIGHT;
  const chartH = H - PAD_TOP - PAD_BOTTOM;

  const xFor = (i) => PAD_LEFT + (i / (sampled.length - 1)) * chartW;
  const yFor = (v) => PAD_TOP + chartH - ((v - min) / range) * chartH;

  const color = isPositive ? '#3fb950' : '#f85149';

  // Grid lines & Y labels
  ctx.lineWidth = 1;
  const gridLines = 5;
  for (let i = 0; i <= gridLines; i++) {
    const y = PAD_TOP + (i / gridLines) * chartH;
    ctx.strokeStyle = 'rgba(48,54,61,0.8)';
    ctx.beginPath();
    ctx.moveTo(PAD_LEFT, y);
    ctx.lineTo(W - PAD_RIGHT, y);
    ctx.stroke();

    const val = max - (i / gridLines) * range;
    ctx.fillStyle = 'rgba(139,148,158,0.9)';
    ctx.font = `11px 'SF Mono', Consolas, monospace`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(formatCurrency(val, state.currency), PAD_LEFT - 8, y);
  }

  // X labels
  const xLabelCount = 5;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(139,148,158,0.9)';
  for (let i = 0; i <= xLabelCount; i++) {
    const idx = Math.round((i / xLabelCount) * (sampled.length - 1));
    const x = xFor(idx);
    const date = new Date(times[idx]);
    let label;
    if (detailState.days <= 1) {
      label = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    } else if (detailState.days <= 90) {
      label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } else {
      label = date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    }
    ctx.fillText(label, x, PAD_TOP + chartH + 8);
  }

  // Price line
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (let i = 0; i < sampled.length; i++) {
    const x = xFor(i);
    const y = yFor(values[i]);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Gradient fill
  const gradient = ctx.createLinearGradient(0, PAD_TOP, 0, PAD_TOP + chartH);
  gradient.addColorStop(0, isPositive ? 'rgba(63,185,80,0.2)' : 'rgba(248,81,73,0.2)');
  gradient.addColorStop(1, 'rgba(13,17,23,0)');
  ctx.beginPath();
  for (let i = 0; i < sampled.length; i++) {
    const x = xFor(i);
    const y = yFor(values[i]);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.lineTo(xFor(sampled.length - 1), PAD_TOP + chartH);
  ctx.lineTo(PAD_LEFT, PAD_TOP + chartH);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // Store chart data for tooltip
  canvas._chartData = { sampled, values, times, min, range, chartW, chartH, PAD_LEFT, PAD_RIGHT, PAD_TOP, xFor, yFor };
}

function addChartTooltip(canvas) {
  const tooltip = document.getElementById('chartTooltip');

  canvas.addEventListener('mousemove', (e) => {
    const data = canvas._chartData;
    if (!data) return;

    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const { sampled, values, times, PAD_LEFT, PAD_RIGHT, chartW, xFor, yFor } = data;

    if (mouseX < PAD_LEFT || mouseX > rect.width - PAD_RIGHT) {
      tooltip.style.display = 'none';
      return;
    }

    const ratio = (mouseX - PAD_LEFT) / chartW;
    const idx = Math.max(0, Math.min(sampled.length - 1, Math.round(ratio * (sampled.length - 1))));
    const price = values[idx];
    const time = new Date(times[idx]);

    const timeStr =
      detailState.days <= 1
        ? time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
        : time.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    tooltip.innerHTML = `<div class="tooltip-time">${timeStr}</div><div class="tooltip-price">${formatCurrency(price, state.currency)}</div>`;

    let left = e.clientX + 14;
    if (left + 160 > window.innerWidth) left = e.clientX - 174;
    let top = e.clientY - 40;

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
    tooltip.style.display = 'block';
  });

  canvas.addEventListener('mouseleave', () => {
    tooltip.style.display = 'none';
  });
}

// ===== Render Coin Detail =====
function renderCoinDetail(coin) {
  const sym = currencySymbols[state.currency] || '$';
  const md = coin.market_data;
  const price = md.current_price?.[state.currency];
  const change24h = md.price_change_percentage_24h;
  const change1h = md.price_change_percentage_1h_in_currency?.[state.currency];
  const change7d = md.price_change_percentage_7d_in_currency?.[state.currency];
  const change30d = md.price_change_percentage_30d_in_currency?.[state.currency];
  const marketCap = md.market_cap?.[state.currency];
  const vol24h = md.total_volume?.[state.currency];
  const ath = md.ath?.[state.currency];
  const athDate = md.ath_date?.[state.currency];
  const atl = md.atl?.[state.currency];
  const atlDate = md.atl_date?.[state.currency];
  const circulatingSupply = md.circulating_supply;
  const totalSupply = md.total_supply;
  const maxSupply = md.max_supply;

  const descRaw = stripHtml(coin.description?.en || '');
  const desc = descRaw.length > 1200 ? descRaw.slice(0, 1200).trimEnd() + '…' : descRaw;

  const homepage = safeUrl(coin.links?.homepage?.find(Boolean));
  const explorer = safeUrl(coin.links?.blockchain_site?.find(Boolean));
  const reddit = safeUrl(coin.links?.subreddit_url);
  const twitterHandle = coin.links?.twitter_screen_name;
  const twitter = twitterHandle ? `https://twitter.com/${encodeURIComponent(twitterHandle)}` : null;

  const changeRows = [
    { label: '1h Change', val: change1h },
    { label: '24h Change', val: change24h },
    { label: '7d Change', val: change7d },
    { label: '30d Change', val: change30d },
  ];

  const statRows = [
    { label: 'Market Cap', val: marketCap != null ? `${sym}${formatLargeNumber(marketCap)}` : '—' },
    { label: '24h Volume', val: vol24h != null ? `${sym}${formatLargeNumber(vol24h)}` : '—' },
    { label: 'Circulating Supply', val: formatSupply(circulatingSupply, coin.symbol) },
    { label: 'Total Supply', val: totalSupply ? formatSupply(totalSupply, coin.symbol) : '∞' },
    { label: 'Max Supply', val: maxSupply ? formatSupply(maxSupply, coin.symbol) : '∞' },
    {
      label: 'All-Time High',
      val: formatCurrency(ath, state.currency),
      sub: athDate ? new Date(athDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '',
    },
    {
      label: 'All-Time Low',
      val: formatCurrency(atl, state.currency),
      sub: atlDate ? new Date(atlDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '',
    },
    { label: 'Market Cap Rank', val: coin.market_cap_rank ? `#${coin.market_cap_rank}` : '—' },
  ];

  const rangeBtns = [1, 7, 30, 90, 365]
    .map((d) => {
      const label = d === 1 ? '24H' : d === 7 ? '7D' : d === 30 ? '30D' : d === 90 ? '90D' : '1Y';
      return `<button class="chart-range-btn${d === detailState.days ? ' active' : ''}" data-days="${d}">${label}</button>`;
    })
    .join('');

  const links = [
    homepage && `<a href="${escapeAttr(homepage)}" target="_blank" rel="noopener noreferrer" class="detail-link">🌐 Website</a>`,
    explorer && `<a href="${escapeAttr(explorer)}" target="_blank" rel="noopener noreferrer" class="detail-link">🔍 Explorer</a>`,
    reddit && `<a href="${escapeAttr(reddit)}" target="_blank" rel="noopener noreferrer" class="detail-link">📣 Reddit</a>`,
    twitter && `<a href="${escapeAttr(twitter)}" target="_blank" rel="noopener noreferrer" class="detail-link">𝕏 Twitter</a>`,
  ]
    .filter(Boolean)
    .join('');

  const content = document.getElementById('detailContent');
  content.innerHTML = `
    <div class="detail-header-card">
      <div class="detail-coin-identity">
        <img class="detail-coin-img" src="${escapeAttr(coin.image?.large || coin.image?.small || '')}" alt="${escapeAttr(coin.name)}" width="64" height="64" />
        <div>
          <h2 class="detail-coin-name">${escapeHtml(coin.name)}</h2>
          <div class="detail-coin-meta">
            <span class="detail-coin-symbol">${escapeHtml((coin.symbol || '').toUpperCase())}</span>
            ${coin.market_cap_rank ? `<span class="detail-coin-rank">#${coin.market_cap_rank}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="detail-price-block">
        <div class="detail-price">${formatCurrency(price, state.currency)}</div>
        <div class="detail-price-change ${changeClass(change24h)}">${formatPercent(change24h)} <span class="detail-change-label">24h</span></div>
      </div>
    </div>

    <div class="detail-chart-card">
      <div class="chart-range-btns">${rangeBtns}</div>
      <div class="detail-chart-wrap">
        <canvas id="detailChartCanvas"></canvas>
      </div>
    </div>

    <div class="detail-changes-grid">
      ${changeRows.map((r) => `
        <div class="change-card">
          <div class="change-label">${r.label}</div>
          <div class="change-value ${changeClass(r.val)}">${formatPercent(r.val)}</div>
        </div>`).join('')}
    </div>

    <div class="detail-stats-grid">
      ${statRows.map((r) => `
        <div class="stat-card">
          <div class="stat-label">${r.label}</div>
          <div class="stat-value">${r.val}</div>
          ${r.sub ? `<div class="stat-sub">${r.sub}</div>` : ''}
        </div>`).join('')}
    </div>

    ${desc ? `
    <div class="detail-description-card">
      <h3>About ${escapeHtml(coin.name)}</h3>
      <p>${escapeHtml(desc)}</p>
    </div>` : ''}

    ${links ? `
    <div class="detail-links-card">
      <h3>Links</h3>
      <div class="detail-links-list">${links}</div>
    </div>` : ''}
  `;

  // Wire up chart range buttons
  document.querySelectorAll('.chart-range-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.chart-range-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      detailState.days = parseInt(btn.dataset.days, 10);
      await loadAndDrawChart(coin.id);
    });
  });
}

async function loadAndDrawChart(coinId) {
  const canvas = document.getElementById('detailChartCanvas');
  if (!canvas) return;
  try {
    const history = await fetchPriceHistory(coinId, detailState.days);
    const prices = history?.prices;
    if (prices && prices.length > 1) {
      const isPositive = prices[prices.length - 1][1] >= prices[0][1];
      drawDetailChart(canvas, prices, isPositive);
      addChartTooltip(canvas);
    }
  } catch (err) {
    console.error('Chart load failed:', err);
  }
}

async function showCoinDetail(coinId) {
  stopAutoRefresh();
  detailState.coinId = coinId;
  detailState.days = 7;

  const mainEl = document.getElementById('mainView');
  const detailEl = document.getElementById('coinDetail');
  const detailLoading = document.getElementById('detailLoading');
  const detailError = document.getElementById('detailError');
  const detailContent = document.getElementById('detailContent');

  mainEl.style.display = 'none';
  detailEl.classList.remove('hidden');
  detailLoading.classList.remove('hidden');
  detailError.style.display = 'none';
  detailContent.innerHTML = '';
  document.title = 'Loading… — CryptoTracker';

  try {
    const coin = await fetchCoinDetail(coinId);
    document.title = `${coin.name} (${(coin.symbol || '').toUpperCase()}) — CryptoTracker`;
    renderCoinDetail(coin);
    await loadAndDrawChart(coinId);
  } catch (err) {
    console.error('Failed to load coin detail:', err);
    document.getElementById('detailErrorMsg').textContent =
      `Failed to load data: ${err.message}. CoinGecko free API has rate limits — please wait a moment and retry.`;
    detailError.style.display = 'flex';
  } finally {
    detailLoading.classList.add('hidden');
  }
}

// ===== Init =====
function init() {
  initEventListeners();
  updateSortHeaders();
  window.addEventListener('hashchange', handleRouteChange);

  const coinId = getHashCoinId();
  if (coinId) {
    showCoinDetail(coinId);
  } else {
    loadData();
    startAutoRefresh();
  }
}

document.addEventListener('DOMContentLoaded', init);
