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

// Use Binance 24hr ticker which returns BOTH live price and stats in one call
// This eliminates the price/stats desync issue
const BINANCE_TICKER_BASE = [
  'https://api.binance.com/api/v3/ticker/24hr',
  'https://data.binance.com/api/v3/ticker/24hr',
  'https://api.binance.us/api/v3/ticker/24hr',
];

const BINANCE_KLINE_BASE = [
  'https://api.binance.com/api/v3/klines',
  'https://data.binance.com/api/v3/klines',
  'https://api.binance.us/api/v3/klines',
];

// Single call returns both price and stats, no desync possible
async function fetchBinanceTicker24hr(symbol) {
  let lastErr;
  for (const base of BINANCE_TICKER_BASE) {
    try {
      const raw = await netGet(`${base}?symbol=${symbol}`, 6000);
      if (raw && raw.lastPrice) {
        return makeTick(
          symbol,
          raw.lastPrice,
          raw.priceChangePercent,
          raw.volume,
          raw.highPrice,
          raw.lowPrice,
          'Binance'
        );
      }
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('Binance fetch failed');
}

async function fetchViaBinance(symbols) {
  const results = await Promise.allSettled(symbols.map(fetchBinanceTicker24hr));
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
//  Supertrend con Pine Script v6 logic, Binance Spot klines
//  Incluye cálculo de distancia porcentual a la línea ADC
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
      currentArriba: null, currentAbajo: null, currentTendencia: null,
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

  state.prevClose = close;
  state.prevArriba = arriba;
  state.prevAbajo = abajo;
  state.prevTendencia = tendencia;
  state.prevATR = atr;

  state.currentArriba = arriba;
  state.currentAbajo = abajo;
  state.currentTendencia = tendencia;

  return { tendencia, senialCompra, senialVenta, arriba, abajo };
}

// Calculate percentage distance from current live price to ADC line
function calcAdcDistance(price, state) {
  if (!state.warmUpDone || !price || price <= 0) return null;

  let adcLine = null;
  if (state.currentTendencia === 1 && state.currentArriba !== null) {
    adcLine = state.currentArriba;
  } else if (state.currentTendencia === -1 && state.currentAbajo !== null) {
    adcLine = state.currentAbajo;
  }

  if (adcLine === null || adcLine <= 0) return null;

  // Distance: positive = price above ADC line, negative = price below ADC line
  const distance = ((price - adcLine) / adcLine) * 100;
  return {
    distancePct: parseFloat(distance.toFixed(3)),
    adcLine: parseFloat(adcLine.toFixed(8)),
    trend: state.currentTendencia === 1 ? 'LONG' : 'SHORT',
  };
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

async function adcEvaluateTick(symbol, currentPrice) {
  const state = adcGetState(symbol);
  if (!state.warmUpDone) return;

  try {
    const candles    = await adcFetchKlines(symbol, 3);
    const closed     = candles.filter(c => c.isClosed);
    if (!closed.length) return;
    const lastClosed = closed[closed.length - 1];

    if (state.lastCandleTime !== null && lastClosed.time <= state.lastCandleTime) {
      // No new candle, but still send distance update with the CURRENT live price
      if (currentPrice && currentPrice > 0 && state.warmUpDone) {
        const distInfo = calcAdcDistance(currentPrice, state);
        if (distInfo && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('adc-distance', { symbol, ...distInfo, price: currentPrice });
        }
      }
      return;
    }

    const result = adcProcessCandle(lastClosed, state);
    state.lastCandleTime = lastClosed.time;

    // Always use the live price (currentPrice) for distance, not the closed candle close
    const priceForDist = (currentPrice && currentPrice > 0) ? currentPrice : lastClosed.close;
    const distInfo = calcAdcDistance(priceForDist, state);
    if (distInfo && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('adc-distance', { symbol, ...distInfo, price: priceForDist });
    }

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
    // On kline fetch error, still send distance with live price if we have ADC state
    if (currentPrice && currentPrice > 0 && state.warmUpDone) {
      const distInfo = calcAdcDistance(currentPrice, state);
      if (distInfo && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('adc-distance', { symbol, ...distInfo, price: currentPrice });
      }
    }
    log('WARN', `[ADC] Error ${symbol}`, { error: err.message });
  }
}

function adcFireAlert(symbol, type, price) {
  const ticker = symbol.replace('USDT', '');
  const isLong = type === 'LONG';
  const emoji  = isLong ? '🟢' : '🔴';
  const dir    = isLong ? 'below' : 'above';

  const notifBody =
    `${emoji} ${type}: ${ticker} @ $${price.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 8})}\n` +
    `‼️ 10X Isolated | TF: 15m`;

  const fullBody =
    `${emoji} ( ${type} ): ${symbol}\n\n` +
    `‼️ 10X - Isolated\n\n` +
    `1️⃣ Entry 1: $${price.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 8})}\n\n` +
    `For Entry 2: Place a limit order 2.5% ${dir} Entry 1\n\n` +
    `For Entry 3: Place a limit order 5% ${dir} Entry 1\n\n` +
    `🎯 TP1: Take partial profit and move SL to entry when +25% profit\n\n` +
    `🔓 Entry 1 target: 1x2\n\n` +
    `🔓 Entry 2 target: 1x3\n\n` +
    `🔓 Entry 3 target: 1x4\n\n` +
    `🕑 Timeframe: 15m.`;

  log('ALERT', `[ADC] ${type} ${symbol}`, { price });

  if (Notification.isSupported()) {
    const n = new Notification({
      title:   `${emoji} ADC ${type} — ${ticker}`,
      body:    notifBody,
      icon:    path.join(__dirname, 'assets', 'icon.png'),
      silent:  false,
      urgency: 'critical',
    });
    n.on('click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
    n.show();
  }

  showPersistentAlert(symbol, type, price, fullBody);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('adc-signal', {
      type, symbol, ticker, price, body: fullBody,
      time: new Date().toISOString(),
    });
  }
}

// ─────────────────────────────────────────────
//  PERSISTENT ALERT WINDOW
// ─────────────────────────────────────────────
let alertWindow = null;

function showPersistentAlert(symbol, type, price, body) {
  if (alertWindow && !alertWindow.isDestroyed()) {
    alertWindow.close();
    alertWindow = null;
  }

  alertWindow = new BrowserWindow({
    width: 460,
    height: 540,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: false,
    backgroundColor: '#0a0d16',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    }
  });

  const ticker = symbol.replace('USDT', '');
  const isLong = type === 'LONG';
  const priceFormatted = typeof price === 'number'
    ? price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 })
    : price;

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com;">
<title>🚨 ADC Alert</title>
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Rajdhani:wght@600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden;font-family:'Rajdhani',sans-serif;background:#050810;color:#fff;-webkit-font-smoothing:antialiased;}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;position:relative;}
.bg-pulse{position:absolute;inset:0;pointer-events:none;animation:bgPulse 0.8s ease infinite;}
@keyframes bgPulse{0%,100%{background:${isLong ? 'rgba(0,229,160,0.04)' : 'rgba(255,56,96,0.04)'};}50%{background:${isLong ? 'rgba(0,229,160,0.12)' : 'rgba(255,56,96,0.12)'};}}
.close-btn{
  position:absolute;top:12px;right:14px;
  background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);
  color:#fff;width:28px;height:28px;border-radius:50%;font-size:16px;
  display:flex;align-items:center;justify-content:center;cursor:pointer;
  transition:background 0.2s,transform 0.2s;-webkit-app-region:no-drag;z-index:10;
}
.close-btn:hover{background:rgba(255,56,96,0.5);border-color:#ff3860;transform:scale(1.1);}
.drag-area{position:absolute;top:0;left:0;right:44px;height:44px;-webkit-app-region:drag;}
.container{text-align:center;padding:30px 28px;position:relative;z-index:1;width:100%;}
.signal-emoji{font-size:52px;margin-bottom:8px;display:block;animation:bounce 0.6s ease infinite alternate;}
@keyframes bounce{from{transform:translateY(0);}to{transform:translateY(-8px);}}
.signal-type{
  font-size:42px;font-weight:700;letter-spacing:3px;margin-bottom:4px;
  color:${isLong ? '#00e5a0' : '#ff3860'};
  text-shadow:0 0 20px ${isLong ? 'rgba(0,229,160,0.6)' : 'rgba(255,56,96,0.6)'};
  animation:textGlow 1s ease infinite alternate;
}
@keyframes textGlow{from{text-shadow:0 0 10px ${isLong ? 'rgba(0,229,160,0.4)' : 'rgba(255,56,96,0.4)'};}to{text-shadow:0 0 30px ${isLong ? 'rgba(0,229,160,0.9)' : 'rgba(255,56,96,0.9)'},0 0 60px ${isLong ? 'rgba(0,229,160,0.4)' : 'rgba(255,56,96,0.4)'};}}
.ticker{font-family:'Share Tech Mono',monospace;font-size:22px;color:#7a86a8;margin-bottom:16px;letter-spacing:4px;}
.price-box{
  background:rgba(0,0,0,0.4);border:1px solid ${isLong ? 'rgba(0,229,160,0.3)' : 'rgba(255,56,96,0.3)'};
  border-radius:10px;padding:14px 20px;margin-bottom:16px;
}
.price-label{font-family:'Share Tech Mono',monospace;font-size:9px;color:#3a4260;text-transform:uppercase;letter-spacing:2px;margin-bottom:6px;}
.price-value{font-family:'Share Tech Mono',monospace;font-size:26px;font-weight:700;color:${isLong ? '#00e5a0' : '#ff3860'};}
.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px;}
.info-cell{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:8px;padding:10px;}
.info-key{font-family:'Share Tech Mono',monospace;font-size:8px;color:#3a4260;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px;}
.info-val{font-family:'Share Tech Mono',monospace;font-size:12px;color:#e8f0ff;font-weight:600;}
.time-display{font-family:'Share Tech Mono',monospace;font-size:9px;color:#3a4260;margin-bottom:14px;}
.dismiss-btn{
  width:100%;padding:11px;background:${isLong ? 'rgba(0,229,160,0.15)' : 'rgba(255,56,96,0.15)'};
  border:1px solid ${isLong ? 'rgba(0,229,160,0.4)' : 'rgba(255,56,96,0.4)'};
  color:${isLong ? '#00e5a0' : '#ff3860'};font-family:'Rajdhani',sans-serif;
  font-weight:700;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;
  border-radius:8px;cursor:pointer;transition:background 0.2s,transform 0.15s;
}
.dismiss-btn:hover{background:${isLong ? 'rgba(0,229,160,0.3)' : 'rgba(255,56,96,0.3)'}; transform:translateY(-1px);}
.dismiss-btn:active{transform:scale(0.98);}
.border-glow{
  position:absolute;inset:0;border-radius:0;pointer-events:none;
  border:1px solid ${isLong ? 'rgba(0,229,160,0.2)' : 'rgba(255,56,96,0.2)'};
  animation:borderPulse 1.2s ease infinite;
}
@keyframes borderPulse{0%,100%{opacity:0.3;}50%{opacity:1;}}
</style>
</head>
<body>
<div class="bg-pulse"></div>
<div class="border-glow"></div>
<div class="drag-area"></div>
<button class="close-btn" onclick="window.sniperAPI.closeAlertWindow()" title="Cerrar alerta">×</button>
<div class="container">
  <span class="signal-emoji">${isLong ? '🟢' : '🔴'}</span>
  <div class="signal-type">ADC ${type}</div>
  <div class="ticker">${ticker} / USDT</div>
  <div class="price-box">
    <div class="price-label">Precio de señal</div>
    <div class="price-value">$${priceFormatted}</div>
  </div>
  <div class="info-grid">
    <div class="info-cell">
      <div class="info-key">Timeframe</div>
      <div class="info-val">15 min</div>
    </div>
    <div class="info-cell">
      <div class="info-key">Apalancamiento</div>
      <div class="info-val">10× Isolated</div>
    </div>
    <div class="info-cell">
      <div class="info-key">Dirección</div>
      <div class="info-val" style="color:${isLong ? '#00e5a0' : '#ff3860'}">${isLong ? '▲ LONG' : '▼ SHORT'}</div>
    </div>
    <div class="info-cell">
      <div class="info-key">Algoritmo</div>
      <div class="info-val">ADC v3.4</div>
    </div>
  </div>
  <div class="time-display" id="time-display">—</div>
  <button class="dismiss-btn" onclick="window.sniperAPI.closeAlertWindow()">
    ✓ Entendido — Cerrar alerta
  </button>
</div>
<script>
  document.getElementById('time-display').textContent = new Date().toLocaleString('es-ES', {
    day:'2-digit', month:'2-digit', year:'numeric',
    hour:'2-digit', minute:'2-digit', second:'2-digit'
  });
<\/script>
</body>
</html>`;

  alertWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  alertWindow.once('ready-to-show', () => {
    if (alertWindow && !alertWindow.isDestroyed()) {
      alertWindow.show();
      alertWindow.focus();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('start-persistent-sound', { type, symbol, price });
      }
    }
  });
  alertWindow.on('closed', () => {
    alertWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('stop-persistent-sound');
    }
  });
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
  // For each ticker, immediately send ADC distance update with the fresh live price
  // then evaluate for new candles in background
  for (const tick of ticks) {
    // Send distance update immediately with live price (no kline fetch needed)
    const state = adcGetState(tick.symbol);
    if (state.warmUpDone && tick.price > 0) {
      const distInfo = calcAdcDistance(tick.price, state);
      if (distInfo && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('adc-distance', { symbol: tick.symbol, ...distInfo, price: tick.price });
      }
    }
    // Background: check for new candles and potential signals
    setImmediate(() =>
      adcEvaluateTick(tick.symbol, tick.price).catch(err =>
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

ipcMain.handle('window:close', () => {
  if (alertWindow && !alertWindow.isDestroyed()) { alertWindow.close(); return; }
  if (adminWindow && !adminWindow.isDestroyed() && adminWindow.isFocused()) { adminWindow.close(); return; }
  app.quit();
});
ipcMain.handle('window:close-alert', () => {
  if (alertWindow && !alertWindow.isDestroyed()) { alertWindow.close(); }
});
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
    result[symbol] = {
      ready: state.warmUpDone,
      ciclo: state.prevTendencia,
      adcLine: state.currentTendencia === 1 ? state.currentArriba : state.currentAbajo,
      tendencia: state.currentTendencia,
    };
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

ipcMain.handle('adc:get-distance', (_, { symbol, price }) => {
  const state = adcGetState(symbol);
  if (!state.warmUpDone) return null;
  return calcAdcDistance(price, state);
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
