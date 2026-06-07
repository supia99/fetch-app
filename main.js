const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('path');

const WINDOW_ICON_PATH = path.join(__dirname, 'assets', 'icons', 'frm-mecha-03.png');
const APP_ICON = nativeImage.createFromPath(WINDOW_ICON_PATH);

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 900,
    minWidth: 900,
    minHeight: 700,
    icon: APP_ICON.isEmpty() ? undefined : APP_ICON,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  if (process.platform === 'linux' && !APP_ICON.isEmpty()) {
    win.setIcon(APP_ICON);
  }
}

app.whenReady().then(() => {
  if (process.platform === 'linux') {
    app.setDesktopName('fetch-app.desktop');
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
