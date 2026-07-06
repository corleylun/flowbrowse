// Real-Chromium smoke for run_js: ElectronPageController.runJs returns a value and can
// mutate the page. Self-quits.
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { ElectronPageController } = require(path.join(__dirname, '..', 'dist', 'main', 'page-controller.js'));

const HTML = 'data:text/html,' + encodeURIComponent('<title>Before</title><body><div id="x">orig</div></body>');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await win.loadURL(HTML);
    const dev = new ElectronPageController(() => win.webContents);

    const read = await dev.runJs('main', 'document.getElementById("x").textContent');
    const mutated = await dev.runJs(
      'main',
      'document.getElementById("x").textContent = "changed"; document.getElementById("x").textContent',
    );

    const ok = read === 'orig' && mutated === 'changed';
    console.log('RUN_JS read=', JSON.stringify(read), 'mutated=', JSON.stringify(mutated));
    console.log(ok ? 'DEV-SMOKE PASS' : 'DEV-SMOKE FAIL');
    process.exitCode = ok ? 0 : 1;
  } catch (e) {
    console.error('DEV-SMOKE ERROR', e && e.message ? e.message : e);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
});
