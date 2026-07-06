// Real-Chromium smoke for the Phase 3 read path: loads a known page and runs the
// actual ElectronPageController.extract/screenshot (no fakes). Self-quits.
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { ElectronPageController } = require(path.join(__dirname, '..', 'dist', 'main', 'page-controller.js'));

const HTML =
  'data:text/html,' +
  encodeURIComponent(
    '<title>SmokeTitle</title><body><h1>Hello</h1><p>marker-xyz-123</p>' +
      '<a href="https://a.test/x">LinkA</a></body>',
  );

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await win.loadURL(HTML);
    const pc = new ElectronPageController(() => win.webContents);
    const extract = await pc.extract('main');
    const shot = await pc.screenshot('main');

    const okText =
      extract.title === 'SmokeTitle' &&
      /marker-xyz-123/.test(extract.text) &&
      extract.links.length === 1 &&
      extract.links[0].href === 'https://a.test/x';
    const okShot = shot.mimeType === 'image/png' && typeof shot.base64 === 'string';

    console.log('EXTRACT', JSON.stringify({ title: extract.title, hasMarker: /marker-xyz-123/.test(extract.text), links: extract.links.length }));
    console.log('SCREENSHOT', shot.mimeType, 'base64Len=', shot.base64.length);
    console.log(okText && okShot ? 'READ-SMOKE PASS' : 'READ-SMOKE FAIL');
    process.exitCode = okText && okShot ? 0 : 1;
  } catch (e) {
    console.error('READ-SMOKE ERROR', e && e.message ? e.message : e);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
});
