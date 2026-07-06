// Real-Chromium smoke for Phase 5 capture + masking: the capture preload must record a
// normal field's value but MASK a password field's value (null) before it leaves the page.
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { Recorder } = require(path.join(__dirname, '..', 'dist', 'recorder', 'recorder.js'));

const HTML =
  'data:text/html,' +
  encodeURIComponent(
    '<body><input id="email" name="email" type="text">' +
      '<input id="pw" name="password" type="password">' +
      '<button id="go">Go</button></body>',
  );

app.whenReady().then(async () => {
  const recorder = new Recorder();
  recorder.start();
  ipcMain.on('record:action', (_e, action) => recorder.add(action));

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'dist', 'preload', 'capture-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  try {
    await win.loadURL(HTML);
    await win.webContents.executeJavaScript(
      `(() => {
        const email = document.getElementById('email');
        email.value = 'alice@example.com';
        email.dispatchEvent(new Event('change', { bubbles: true }));
        const pw = document.getElementById('pw');
        pw.value = 'SuperSecret123';
        pw.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('go').click();
      })()`,
      true,
    );
    await new Promise((r) => setTimeout(r, 250)); // let IPC settle

    const actions = recorder.actions();
    const email = actions.find((a) => a.type === 'fill' && a.selector === '#email');
    const pw = actions.find((a) => a.type === 'fill' && a.selector === '#pw');
    const click = actions.find((a) => a.type === 'click' && a.selector === '#go');

    const ok =
      email && email.value === 'alice@example.com' && email.masked === false &&
      pw && pw.value === null && pw.masked === true &&
      click && click.label === 'Go';

    console.log('ACTIONS', JSON.stringify(actions));
    console.log(ok ? 'CAPTURE-SMOKE PASS' : 'CAPTURE-SMOKE FAIL');
    process.exitCode = ok ? 0 : 1;
  } catch (e) {
    console.error('CAPTURE-SMOKE ERROR', e && e.message ? e.message : e);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
});
