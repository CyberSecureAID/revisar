'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sniperAPI', {
  // Config
  loadConfig:  ()              => ipcRenderer.invoke('config:load'),
  saveConfig:  (cfg)           => ipcRenderer.invoke('config:save', cfg),
  getVersion:  ()              => ipcRenderer.invoke('app:version'),

  // Tickers
  fetchTickers: (symbols, prov) => ipcRenderer.invoke('tickers:fetch', { symbols, provider: prov }),
  getProviders: ()              => ipcRenderer.invoke('providers:list'),

  // Updates
  checkUpdate:  ()              => ipcRenderer.invoke('update:check'),
  openRelease:  (url)           => ipcRenderer.invoke('update:openRelease', url),

  // Notifications (OS-level only)
  sendNotification: ({ title, body }) => ipcRenderer.invoke('notification:send', { title, body }),

  // Window
  closeWindow:    ()     => ipcRenderer.invoke('window:close'),
  minimizeWindow: ()     => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: ()     => ipcRenderer.invoke('window:maximize'),
  setAlwaysOnTop: (flag) => ipcRenderer.invoke('window:setAlwaysOnTop', flag),
  openAdmin:      ()     => ipcRenderer.invoke('window:openAdmin'),

  // Logs
  getLogs: ()                       => ipcRenderer.invoke('logs:read'),
  log:     (level, message, meta)   => ipcRenderer.invoke('log:write', { level, message, meta }),

  // ADC — Algoritmo de Detección de Ciclos
  getAdcStatus:   ()       => ipcRenderer.invoke('adc:status'),
  calibrateAdc:   (symbol) => ipcRenderer.invoke('adc:calibrate', { symbol }),

  onAdcSignal:     (cb) => { ipcRenderer.on('adc-signal',      (_, d) => cb(d)); },
  onAdcWarmupDone: (cb) => { ipcRenderer.on('adc-warmup-done', (_, d) => cb(d)); },
  offAdcSignal:    ()   => { ipcRenderer.removeAllListeners('adc-signal'); },
  offAdcWarmupDone:()   => { ipcRenderer.removeAllListeners('adc-warmup-done'); },
});
