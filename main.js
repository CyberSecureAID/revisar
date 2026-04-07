/**
 * Sniper Alert — Main Process v3.4
 * Real-time Binance Spot prices via /api/v3/ticker/price (matches TradingView tick-by-tick).
 * ADC — Algoritmo de Detección de Ciclos. Internals hidden from UI.
 * All trade alerts delivered as OS desktop notifications only.
 */
'use strict';

const { app, BrowserWindow, ipcMain, Notification, shell, net } = require('electron');
const path = require('path');
const fs   = require('fs');

const USER_DATA   = app.getPath('userData');
const CONFIG_FILE = path.join(USER_DATA, 'config.json');
const LOG_FILE    = path.join(USER_DATA, 'sniper-alert.log');

function log(level, message, meta = {}) {
  const entry = { ts: new Date().toISOString(), level, message, ...meta };
  try { fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n'); } catch (_) {}
  console.log(`[${entry.ts}] [${level}] ${message}`, Object.keys(meta).length ? meta : '');
}

const DEFAULT_CONFIG = {
  schemaVersion: 4,
  tracked:   ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  favorites: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  alerts:    {},
  settings: {
    refreshInterval:      5000,
    notificationCooldown: 120000,
    alarmRepeat:          3,
    soundEnabled:         true,
    language:             'es',
    provider:             'binance',
    alwaysOnTop:          false,
    windowBounds:         { width: 520, height: 680 },
    osNotifications:      true,
    adcEnabled:           true
  }
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        settings: { ...DEFAULT_CONFIG.settings, ...(parsed.settings || {}) }
      };
    }
  } catch (err) { log('ERROR', 'Config load failed', { error: err.message }); }
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(USER_DATA, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    return true;
  } catch (err) {
    log('ERROR', 'Config save failed', { error: err.message });
    return false;
  }
}

function netGet(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs);
    const req = net.request({ url, method: 'GET' });
    req.setHeader('User-Agent', 'SniperAlert/3.4 Electron');
    req.setHeader('Accept', 'application/json');
    let body = '';
    req.on('response', res => {
      if (res.statusCode === 429) { clearTimeout(timer); reject(new Error('RATE_LIMIT')); return; }
      if (res.statusCode !== 200) { clearTimeout(timer); reject(new Error(`HTTP_${res.statusCode}`)); return; }
      res.on('data', c => { body += c.toString(); });
      res.on('end',  () => { clearTimeout(timer); try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('JSON_PARSE')); } });
      res.on('error', e => { clearTimeout(timer); reject(e); });
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

// ─── Symbol maps ───────────────────────────────────────────────────
const BINANCE_TO_COINGECKO = {
  BTCUSDT:'bitcoin', ETHUSDT:'ethereum', SOLUSDT:'solana',
  BNBUSDT:'binancecoin', XRPUSDT:'ripple', DOGEUSDT:'dogecoin',
  ADAUSDT:'cardano', AVAXUSDT:'avalanche-2', LINKUSDT:'chainlink',
  DOTUSDT:'polkadot', MATICUSDT:'matic-network', SHIBUSDT:'shiba-inu',
};
const BINANCE_TO_KRAKEN = {
  BTCUSDT:'XBTUSD', ETHUSDT:'ETHUSD', SOLUSDT:'SOLUSD',
  XRPUSDT:'XRPUSD', DOGEUSDT:'DOGEUSD', ADAUSDT:'ADAUSD',
  AVAXUSDT:'AVAXUSD', LINKUSDT:'LINKUSD', DOTUSDT:'DOTUSD',
};
const BINANCE_TO_COINPAPRIKA = {
  BTCUSDT:'btc-bitcoin', ETHUSDT:'eth-ethereum', SOLUSDT:'sol-solana',
  BNBUSDT:'bnb-binance-coin', XRPUSDT:'xrp-xrp', DOGEUSDT:'doge-dogecoin',
  ADAUSDT:'ada-cardano', AVAXUSDT:'avax-avalanche', LINKUSDT:'link-chainlink',
  DOTUSDT:'dot-polkadot', MATICUSDT:'matic-polygon', SHIBUSDT:'shib-shiba-inu',
};

function makeTick(symbol, price, change24h, volume, high24h, low24h, source) {
  return {
    symbol, source, ts: Date.now(),
    price:     parseFloat(price)     || 0,
    change24h: parseFloat(change24h) || 0,
    volume:    parseFloat(volume)    || 0,
    high24h:   parseFloat(high24h)   || 0,
    low24h:    parseFloat(low24h)    || 0,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  BINANCE REAL-TIME PRICES
//  /api/v3/ticker/price  → exact live price (same feed as TradingView)
//  /api/v3/ticker/24hr   → 24h stats (cached 30 s to respect rate limits)
// ─────────────────────────────────────────────────────────────────────
const BINANCE_PRICE_BASE = [
  'https://api.binance.com/api/v3/ticker/price?symbol=',
  'https://data.binance.com/api/v3/ticker/price?symbol=',
  'https://api.binance.us/api/v3/ticker/price?symbol=',
];
const BINANCE_STATS_BASE = [
  'https://api.binance.com/api/v3/ticker/24hr?symbol=',
  'https://data.binance.com/api/v3/ticker/24hr?symbol=',
  'https://api.binance.us/api/v3/ticker/24hr?symbol=',
];
const BINANCE_KLINE_BASE = [
  'https://api.binance.com/api/v3/klines',
  'https://data.binance.com/api/v3/klines',
  'https://api.binance.us/api/v3/klines',
];

const statsCache = {};
const STATS_TTL  = 30000; // 30 s

async function getStats(symbol) {
  const now = Date.now();
  if (statsCache[symbol] && now - statsCache[symbol].ts < STATS_TTL) {
    return statsCache[symbol].data;
  }
  for (const base of BINANCE_STATS_BASE) {
    try {
      const raw = await netGet(base + symbol, 8000);
      if (raw && raw.lastPrice) { statsCache[symbol] = { ts: now, data: raw }; return raw; }
    } catch (_) {}
  }
  return statsCache[symbol]?.data || null;
}

async function fetchOneBinance(symbol) {
  // Live price — matches TradingView to the cent
  let livePrice = null;
  for (const base of BINANCE_PRICE_BASE) {
    try {
      const raw = await netGet(base + symbol, 6000);
      if (raw && raw.price) { livePrice = parseFloat(raw.price); break; }
    } catch (_) {}
  }
  const stats = await getStats(symbol);
  if (!stats && livePrice === null) return null;

  const price     = livePrice !== null ? livePrice : parseFloat(stats?.lastPrice || 0);
  const change24h = parseFloat(stats?.priceChangePercent || 0);
  const volume    = parseFloat(stats?.volume             || 0);
  const high24h   = parseFloat(stats?.highPrice          || 0);
  const low24h    = parseFloat(stats?.lowPrice           || 0);

  return makeTick(symbol, price, change24h, volume, high24h, low24h, 'Binance');
}

async function fetchViaBinance(symbols) {
  const results = await Promise.allSettled(symbols.map(fetchOneBinance));
  return results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
}

async function fetchViaKraken(symbols) {
  const pairs = symbols.map(s => BINANCE_TO_KRAKEN[s]).filter(Boolean);
  const rev   = {};
  for (const [b, k] of Object.entries(BINANCE_TO_KRAKEN)) rev[k] = b;
  if (!pairs.length) return [];
  try {
    const data = await netGet(`https://api.kraken.com/0/public/Ticker?pair=${pairs.join(',')}`);
    if (data.error?.length) return [];
    const ticks = [];
    for (const [key, v] of Object.entries(data.result || {})) {
      const pair = pairs.find(p => key.replace('XBT','BTC').includes(p.replace('XBT','BTC').replace('USD','')));
      const sym  = pair ? rev[pair] : null;
      if (!sym || !symbols.includes(sym)) continue;
      const price = parseFloat(v.c[0]);
      const open  = parseFloat(v.o);
      ticks.push(makeTick(sym, price, open > 0 ? ((price - open) / open) * 100 : 0, v.v[1], v.h[1], v.l[1], 'Kraken'));
    }
    return ticks;
  } catch (err) { log('WARN', 'Kraken fetch failed', { error: err.message }); return []; }
}

async function fetchViaCoinGecko(symbols) {
  const ids = symbols.map(s => BINANCE_TO_COINGECKO[s]).filter(Boolean).join(',');
  const rev = {};
  for (const [b, g] of Object.entries(BINANCE_TO_COINGECKO)) rev[g] = b;
  if (!ids) return [];
  try {
    const data = await netGet(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&price_change_percentage=24h`
    );
    return data
      .filter(c => rev[c.id] && symbols.includes(rev[c.id]))
      .map(c => makeTick(rev[c.id], c.current_price, c.price_change_percentage_24h,
        c.total_volume, c.high_24h, c.low_24h, 'CoinGecko'));
  } catch (err) { log('WARN', 'CoinGecko fetch failed', { error: err.message }); return []; }
}

async function fetchViaCoinPaprika(symbols) {
  const results = [];
  await Promise.allSettled(symbols.map(async sym => {
    const id = BINANCE_TO_COINPAPRIKA[sym];
    if (!id) return;
    try {
      const data = await netGet(`https://api.coinpaprika.com/v1/tickers/${id}?quotes=USD`);
      const q = data?.quotes?.USD;
      if (q) results.push(makeTick(sym, q.price, q.percent_change_24h, q.volume_24h, null, null, 'CoinPaprika'));
    } catch (_) {}
  }));
  return results;
}

async function fetchAllTickers(symbols, provider = 'binance') {
  let ticks = [];
  try {
    switch (provider) {
      case 'kraken':      ticks = await fetchViaKraken(symbols);     break;
      case 'coingecko':   ticks = await fetchViaCoinGecko(symbols);  break;
      case 'coinpaprika': ticks = await fetchViaCoinPaprika(symbols); break;
      default:            ticks = await fetchViaBinance(symbols);     break;
    }
  } catch (err) { log('WARN', `Provider ${provider} error`, { error: err.message }); }
  if (!ticks.length && provider !== 'coingecko') {
    ticks = await fetchViaCoinGecko(symbols).catch(() => []);
  }
  return ticks;
}

// ─────────────────────────────────────────────
//  UPDATE CHECKER
// ─────────────────────────────────────────────
const CURRENT_VERSION     = app.getVersion();
const UPDATE_MANIFEST_URL = 'https://raw.githubusercontent.com/CyberSecureAID/sniper-alert/main/version.json';

async function checkForUpdates() {
  try {
    const manifest  = await netGet(UPDATE_MANIFEST_URL);
    const hasUpdate = compareVersions(manifest.version, CURRENT_VERSION) > 0;
    return { hasUpdate, manifest, current: CURRENT_VERSION };
  } catch (err) { return { hasUpdate: false, error: err.message, current: CURRENT_VERSION }; }
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i]||0) - (pb[i]||0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════
//  ADC — Algoritmo de Detección de Ciclos
//  Pine Script v6 logic, Binance Spot klines (= TradingView source).
//  Parameters intentionally not exposed in the UI.
// ═══════════════════════════════════════════════════════════════════════
const ADC_PERIOD      = 2;
const ADC_MULT        = 19.0;
const ADC_WARM_BARS   = 100;
const ADC_INTERVAL    = '15m';
const ADC_COOLDOWN_MS = 4 * 60 * 60 * 1000;

const adcStates = new Map();

function adcGetState(symbol) {
  if (!adcStates.has(symbol)) {
    adcStates.set(symbol, {
      prevClose: null, prevArriba: null, prevAbajo: null,
      prevTendencia: null, prevATR: null,
      warmUpDone: false, warmUpInProgress: false,
      lastCandleTime: null, lastLongMs: 0, lastShortMs: 0,
    });
  }
  return adcStates.get(symbol);
}

function adcRMA(value, prev) {
  if (prev === null || prev === undefined) return value;
  return (1 / ADC_PERIOD) * value + (1 - 1 / ADC_PERIOD) * prev;
}

function adcTR(high, low, prevClose) {
  if (prevClose === null || prevClose === undefined) return high - low;
  return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
}

function adcProcessCandle(candle, state) {
  const { high, low, close } = candle;
  const hl2 = (high + low) / 2;
  const tr  = adcTR(high, low, state.prevClose);
  const atr = adcRMA(tr, state.prevATR);

  let arriba    = hl2 - ADC_MULT * atr;
  const arriba1 = state.prevArriba !== null ? state.prevArriba : arriba;
  if (state.prevClose !== null && state.prevClose > arriba1) arriba = Math.max(arriba, arriba1);

  let abajo    = hl2 + ADC_MULT * atr;
  const abajo1 = state.prevAbajo !== null ? state.prevAbajo : abajo;
  if (state.prevClose !== null && state.prevClose < abajo1) abajo = Math.min(abajo, abajo1);

  let tendencia = state.prevTendencia !== null ? state.prevTendencia : 1;
  if      (tendencia === -1 && close > abajo1)  tendencia = 1;
  else if (tendencia ===  1 && close < arriba1) tendencia = -1;

  const senialCompra = tendencia === 1  && state.prevTendencia === -1;
  const senialVenta  = tendencia === -1 && state.prevTendencia ===  1;

  state.prevClose = close; state.prevArriba = arriba; state.prevAbajo = abajo;
  state.prevTendencia = tendencia; state.prevATR = atr;

  return { tendencia, senialCompra, senialVenta };
}

async function adcFetchKlines(symbol, limit) {
  let lastErr;
  for (const base of BINANCE_KLINE_BASE) {
    try {
      const data = await netGet(`${base}?symbol=${symbol}&interval=${ADC_INTERVAL}&limit=${limit}`, 12000);
      return data.map((k, i) => ({
        time: Number(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]),
        closeTime: Number(k[6]),
        isClosed: i < data.length - 1 || Number(k[6]) < Date.now(),
      }));
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('Kline fetch failed');
}

async function adcWarmUp(symbol) {
  const state = adcGetState(symbol);
  if (state.warmUpDone || state.warmUpInProgress) return;
  state.warmUpInProgress = true;
  try {
    log('INFO', `[ADC] Calibración iniciada ${symbol}`);
    const candles = await adcFetchKlines(symbol, ADC_WARM_BARS + 2);
    const closed  = candles.filter(c => c.isClosed);

    state.prevClose = null; state.prevArriba = null; state.prevAbajo = null;
    state.prevTendencia = null; state.prevATR = null;

    for (const c of closed) adcProcessCandle(c, state);
    if (closed.length > 0) state.lastCandleTime = closed[closed.length - 1].time;

    state.warmUpDone = true; state.warmUpInProgress = false;
    log('INFO', `[ADC] Calibración OK ${symbol}`, {
      barras: closed.length,
      ciclo: state.prevTendencia === 1 ? 'ALCISTA' : 'BAJISTA',
    });

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('adc-warmup-done', {
        symbol, tendencia: state.prevTendencia,
      });
    }
  } catch (err) {
    state.warmUpInProgress = false;
    log('ERROR', `[ADC] Calibración fallida ${symbol}`, { error: err.message });
  }
}

async function adcEvaluateTick(symbol) {
  const state = adcGetState(symbol);
  if (!state.warmUpDone) return;
  try {
    const candles    = await adcFetchKlines(symbol, 3);
    const closed     = candles.filter(c => c.isClosed);
    if (!closed.length) return;
    const lastClosed = closed[closed.length - 1];
    if (state.lastCandleTime !== null && lastClosed.time <= state.lastCandleTime) return;

    const result = adcProcessCandle(lastClosed, state);
    state.lastCandleTime = lastClosed.time;

    const now = Date.now();
    if (result.senialCompra && now - state.lastLongMs  >= ADC_COOLDOWN_MS) {
      state.lastLongMs = now;
      adcFireAlert(symbol, 'LONG', lastClosed.close);
    }
    if (result.senialVenta  && now - state.lastShortMs >= ADC_COOLDOWN_MS) {
      state.lastShortMs = now;
      adcFireAlert(symbol, 'SHORT', lastClosed.close);
    }
  } catch (err) {
    log('WARN', `[ADC] Error ${symbol}`, { error: err.message });
  }
}

function adcFireAlert(symbol, type, price) {
  const ticker = symbol.replace('USDT', '');
  const isLong = type === 'LONG';
  const emoji  = isLong ? '🟢' : '🔴';
  const dir    = isLong ? 'below' : 'above';

  const notifBody =
    `${emoji} ${type}: ${ticker} @ ${price}\n` +
    `‼️ 10X Isolated | TF: 15m`;

  const fullBody =
    `${emoji} ( ${type} ): ${symbol}\n\n` +
    `‼️ 10X - Isolated\n\n` +
    `1️⃣ Entry 1: ${price}\n\n` +
    `For Entry 2: Place a limit order 2.5% ${dir} Entry 1\n\n` +
    `For Entry 3: Place a limit order 5% ${dir} Entry 1\n\n` +
    `🎯 TP1: Take partial profit and move SL to entry when +25% profit\n\n` +
    `🔓 Entry 1 target: 1x2\n\n` +
    `🔓 Entry 2 target: 1x3\n\n` +
    `🔓 Entry 3 target: 1x4\n\n` +
    `🕑 Timeframe: 15m.`;

  log('ALERT', `[ADC] ${type} ${symbol}`, { price });

  // OS desktop notification — bottom-right corner of desktop
  if (Notification.isSupported()) {
    const n = new Notification({
      title:   `${emoji} ADC ${type} — ${ticker}`,
      body:    notifBody,
      icon:    path.join(__dirname, 'assets', 'icon.png'),
      silent:  false,
      urgency: 'normal',
    });
    n.on('click', () => { if (mainWindow) mainWindow.focus(); });
    n.show();
  }

  // Send to renderer for card flash + alert sound only — no in-app overlay
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('adc-signal', {
      type, symbol, ticker, price, body: fullBody,
      time: new Date().toISOString(),
    });
  }
}

// ─────────────────────────────────────────────
//  WINDOWS
// ─────────────────────────────────────────────
let mainWindow  = null;
let adminWindow = null;

function createWindow(cfg) {
  const bounds      = cfg?.settings?.windowBounds || { width: 520, height: 680 };
  const alwaysOnTop = cfg?.settings?.alwaysOnTop  || false;

  mainWindow = new BrowserWindow({
    width: bounds.width, height: bounds.height, minWidth: 420, minHeight: 500,
    frame: false, transparent: false, backgroundColor: '#0a0d16',
    alwaysOnTop, resizable: true, maximizable: true, minimizable: true, skipTaskbar: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.on('resize', () => {
    if (!mainWindow) return;
    const [w, h] = mainWindow.getSize();
    const stored  = loadConfig();
    stored.settings.windowBounds = { width: w, height: h };
    saveConfig(stored);
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  log('INFO', 'Application started', { version: CURRENT_VERSION, platform: process.platform });
}

function createAdminWindow() {
  if (adminWindow) { adminWindow.focus(); return; }
  adminWindow = new BrowserWindow({
    width: 820, height: 680, minWidth: 720, minHeight: 560,
    frame: false, transparent: false, backgroundColor: '#050810',
    resizable: true, maximizable: true, minimizable: true, skipTaskbar: false,
    title: 'Sniper Alert — Admin',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  adminWindow.loadFile('admin.html');
  adminWindow.on('closed', () => { adminWindow = null; });
  log('INFO', 'Admin window opened');
}

function readLogs(maxLines = 300) {
  try {
    if (!fs.existsSync(LOG_FILE)) return { lines: [], path: LOG_FILE };
    const rawLines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const lines    = rawLines.slice(-maxLines).map(l => {
      try { return JSON.parse(l); } catch (_) { return { ts: '—', level: 'INFO', message: l }; }
    });
    return { lines, path: LOG_FILE };
  } catch (err) {
    log('ERROR', 'Log read failed', { error: err.message });
    return { lines: [], path: LOG_FILE };
  }
}

// ─────────────────────────────────────────────
//  IPC HANDLERS
// ─────────────────────────────────────────────
ipcMain.handle('config:load', () => loadConfig());
ipcMain.handle('config:save', (_, cfg) => {
  const ok = saveConfig(cfg);
  if (ok) log('INFO', 'Config saved');
  return ok;
});
ipcMain.handle('app:version', () => CURRENT_VERSION);

ipcMain.handle('tickers:fetch', async (_, { symbols, provider }) => {
  const ticks = await fetchAllTickers(symbols, provider);
  for (const tick of ticks) {
    setImmediate(() =>
      adcEvaluateTick(tick.symbol).catch(err =>
        log('WARN', `[ADC] bg error ${tick.symbol}`, { error: err.message })
      )
    );
  }
  return ticks;
});

ipcMain.handle('update:check',       () => checkForUpdates());
ipcMain.handle('update:openRelease', (_, url) =>
  shell.openExternal(url || 'https://github.com/CyberSecureAID/sniper-alert/releases')
);

ipcMain.handle('notification:send', (_, { title, body }) => {
  if (Notification.isSupported()) {
    const n = new Notification({
      title, body,
      icon: path.join(__dirname, 'assets', 'icon.png'),
      silent: false, urgency: 'normal',
    });
    n.on('click', () => { if (mainWindow) mainWindow.focus(); });
    n.show();
    log('ALERT', 'Notification sent', { title });
  }
});

ipcMain.handle('window:close',          () => { if (adminWindow?.isFocused()) { adminWindow.close(); } else { app.quit(); } });
ipcMain.handle('window:minimize',       () => { const w = adminWindow?.isFocused() ? adminWindow : mainWindow; if (w) w.minimize(); });
ipcMain.handle('window:maximize',       () => { const w = adminWindow?.isFocused() ? adminWindow : mainWindow; if (!w) return; w.isMaximized() ? w.unmaximize() : w.maximize(); });
ipcMain.handle('window:setAlwaysOnTop', (_, flag) => { if (mainWindow) mainWindow.setAlwaysOnTop(!!flag); });
ipcMain.handle('window:openAdmin',      () => createAdminWindow());

ipcMain.handle('providers:list', () => [
  { id: 'binance',     name: 'Binance'     },
  { id: 'kraken',      name: 'Kraken'      },
  { id: 'coingecko',   name: 'CoinGecko'   },
  { id: 'coinpaprika', name: 'CoinPaprika' },
]);

ipcMain.handle('log:write', (_, { level, message, meta }) => log(level || 'INFO', message, meta || {}));
ipcMain.handle('logs:read', () => readLogs(300));

ipcMain.handle('adc:status', () => {
  const result = {};
  for (const [symbol, state] of adcStates.entries()) {
    result[symbol] = { ready: state.warmUpDone, ciclo: state.prevTendencia };
  }
  return result;
});

ipcMain.handle('adc:calibrate', async (_, { symbol }) => {
  const state = adcGetState(symbol);
  if (state.warmUpDone) return { already: true, ciclo: state.prevTendencia };
  adcWarmUp(symbol).catch(err =>
    log('WARN', `[ADC] on-demand calibration error ${symbol}`, { error: err.message })
  );
  return { started: true };
});

// ─────────────────────────────────────────────
//  APP LIFECYCLE
// ─────────────────────────────────────────────
app.commandLine.appendSwitch('no-proxy-server');

app.whenReady().then(() => {
  try { fs.mkdirSync(USER_DATA, { recursive: true }); } catch (_) {}
  const cfg = loadConfig();
  createWindow(cfg);
  (cfg.tracked || []).forEach((sym, i) => {
    setTimeout(() => adcWarmUp(sym), i * 600);
  });
});

app.on('window-all-closed', () => {
  log('INFO', 'Application closed');
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow(loadConfig());
});
