# 🎯 Sniper Alert

A local-first, privacy-respecting crypto price monitor with glassmorphism UI, built on Electron.  
No account, no cloud, no subscription. Everything runs on your machine.

---

## Features (v1.1.0)

- **Price target alerts** — fire when a coin hits a specific USD price
- **24h % rise / drop alerts** — trigger on percentage thresholds
- **Native OS notifications** — system-level alerts with sound
- **Glassmorphism UI** — dark, premium, always-on-top widget
- **Local persistence** — config stored as JSON in your user data folder
- **Plugin architecture** — add new alert types without touching core code
- **Auto-update detection** — checks a public GitHub version manifest, no server needed
- **Structured logging** — all events logged to `sniper-alert.log` in user data

---

## Setup

```bash
# Install dependencies
npm install

# Run in development
npm start

# Build distributable
npm run build          # Current platform
npm run build:win      # Windows portable exe
npm run build:mac      # macOS .dmg
npm run build:linux    # Linux AppImage
```

---

## Project Structure

```
sniper-alert/
├── main.js                  ← Electron main process (IPC, persistence, notifications)
├── index.html               ← Renderer UI (all styles + app bootstrap)
├── package.json
├── version.json             ← Local changelog; also hosted on GitHub for update checks
│
├── src/
│   ├── preload.js           ← Secure IPC bridge (contextBridge)
│   └── core/
│       ├── alert-engine.js      ← Plugin-based alert evaluation
│       ├── data-fetcher.js      ← Binance API + normalization
│       └── notification-manager.js  ← Cooldown, flash, sound, OS notifications
│
└── assets/
    └── icon.png             ← App icon (provide your own)
```

---

## Adding a Custom Alert Plugin (e.g. Pine Script indicator)

1. Create a file in `src/plugins/`, e.g. `src/plugins/rsi-alert.js`

```js
// Extend BaseAlertPlugin (available as window.__BaseAlertPlugin)
class RSIAlertPlugin extends window.__BaseAlertPlugin {
  get id()   { return 'rsi_alert'; }
  get name() { return 'RSI Oversold/Overbought'; }

  defaultConfig() { return { oversold: 30, overbought: 70 } }

  evaluate(tick, alertData) {
    // tick = { symbol, price, change24h, volume, high24h, low24h }
    // Your Pine Script logic translated to JS goes here
    const rsi = computeRSI(tick);   // your implementation
    const triggered = rsi < alertData.oversold || rsi > alertData.overbought;
    return {
      triggered,
      message: triggered ? `RSI ${rsi.toFixed(1)} — ${tick.symbol}` : null
    };
  }
}

// Register with the global engine
window.__SniperAlertEngine.registerPlugin(new RSIAlertPlugin());
```

2. Add a `<script>` tag to `index.html` after the core modules:

```html
<script src="src/plugins/rsi-alert.js"></script>
```

That's it. The alert engine and UI will pick it up automatically.

---

## Update System

The app reads `version.json` from:

```
https://raw.githubusercontent.com/CyberSecureAID/sniper-alert/main/version.json
```

To publish a new version:
1. Update `package.json` → `version`
2. Update `version.json` → `version`, `changelog`, `releaseUrl`
3. Push to GitHub main branch
4. Users clicking "Check for updates" will see the new version

**No server, no CI, no cost.** Just a static JSON file in your repo.

---

## Config Location

Your alerts and settings are stored here:

| Platform | Path |
|----------|------|
| Windows  | `%APPDATA%\sniper-alert\config.json` |
| macOS    | `~/Library/Application Support/sniper-alert/config.json` |
| Linux    | `~/.config/sniper-alert/config.json` |

Logs are at the same location: `sniper-alert.log`

---

## Security

- `nodeIntegration: false` — renderer has no direct Node access
- `contextIsolation: true` — preload runs in isolated context
- All IPC calls go through the typed `sniperAPI` bridge
- No external telemetry, analytics, or network calls except Binance public API and GitHub raw for update checks

---

## License

MIT — free to use, modify, and distribute.
