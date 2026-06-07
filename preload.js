const { contextBridge, clipboard } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  readClipboardText: () => clipboard.readText(),
});
