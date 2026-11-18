const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vc', {
  on: (channel, cb) => ipcRenderer.on(channel, (_e, payload) => cb(payload)),
  audio: (samples) => ipcRenderer.send('audio', samples),
  speakDone: () => ipcRenderer.send('speak-done'),
  typed: (text) => ipcRenderer.send('typed', text),
  confirm: (yes) => ipcRenderer.send('confirm-answer', yes),
  orbClick: () => ipcRenderer.send('orb-click'),
  stop: () => ipcRenderer.send('stop'),
  log: (...a) => ipcRenderer.send('log', ...a),
  setInteractive: (on) => ipcRenderer.send('interactive', on),
  quit: () => ipcRenderer.send('quit'),
  menu: () => ipcRenderer.send('orb-menu'),
  visual: (state) => ipcRenderer.send('visual', state),
  level: (v) => ipcRenderer.send('level', v),
});
