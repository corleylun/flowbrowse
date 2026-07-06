// Render assets/safecobrowser-icon.svg → build/icon-1024.png using the bundled Electron
// (no external rasterizer needed). Transparent window preserves the rounded-corner alpha.
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '..', 'assets', 'safecobrowser-icon.svg'), 'utf8');
  const html =
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>' +
    '</head><body>' + svg + '</body></html>';

  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { offscreen: false },
  });

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 500));

  const img = await win.webContents.capturePage();
  const out = path.join(__dirname, '..', 'build', 'icon-1024.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // Normalize to exactly 1024 (capturePage returns physical px on retina).
  const resized = img.resize({ width: 1024, height: 1024, quality: 'best' });
  fs.writeFileSync(out, resized.toPNG());
  const s = resized.getSize();
  console.log('wrote', out, `${s.width}x${s.height}`);
  win.destroy();
  app.quit();
});
