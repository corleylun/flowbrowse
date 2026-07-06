// Diagnose the address-bar navigation: load the chrome UI with its preload and check that
// window.safecobrowser is exposed and pressing Enter in #addr reaches the nav:go IPC. Self-quits.
const path = require('path');
const { app, BaseWindow, WebContentsView, ipcMain } = require('electron');

app.whenReady().then(async () => {
  let navCalled = null;
  ipcMain.handle('nav:go', (_e, url) => {
    navCalled = url;
  });
  // Stub the handlers the renderer calls during init so it doesn't error out.
  ipcMain.handle('ai:get-state', () => ({ tabId: 'default', mode: 'blocked', epoch: 0 }));
  ipcMain.handle('record:state', () => ({ recording: false, count: 0 }));
  ipcMain.handle('recipe:list', () => []);
  ipcMain.handle('container:list', () => ({
    current: 'default',
    containers: [{ id: 'default', name: 'Default', createdAt: 0 }],
  }));
  ipcMain.handle('tab:list', () => ({
    activeId: 't1',
    tabs: [{ id: 't1', containerId: 'default', containerName: 'Default', title: 'Example' }],
  }));
  ipcMain.handle('ui:activity', () => {});
  let autoState = { actions: false, runjs: false };
  ipcMain.handle('ui:get-auto-approve', () => autoState);
  ipcMain.handle('ui:auto-approve', (e, patch) => {
    autoState = { ...autoState, ...patch };
    e.sender.send('auto-approve:state', autoState);
  });
  ipcMain.handle('audit:recent', () => [
    { seq: 1, ts: Date.now(), tabId: 't1', toolName: 'read_page', mode: 'read', outcome: 'allowed' },
    { seq: 2, ts: Date.now(), tabId: 't2', toolName: 'run_js', mode: 'develop', outcome: 'denied', reason: 'permission_denied' },
  ]);

  const win = new BaseWindow({ show: false, width: 1000, height: 200 });
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '..', 'dist', 'preload', 'chrome-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.contentView.addChildView(view);

  const on = view.webContents.on.bind(view.webContents);
  on('console-message', (...args) => {
    const first = args[0];
    const msg = first && typeof first === 'object' && first.message ? first.message : args[2];
    const level = first && typeof first === 'object' && first.level ? first.level : args[1];
    if (String(level).includes('error') || String(msg).toLowerCase().includes('error')) {
      console.log('[renderer]', msg);
    }
  });

  try {
    await view.webContents.loadFile(path.join(__dirname, '..', 'dist', 'renderer', 'index.html'));
    const apiType = await view.webContents.executeJavaScript('typeof window.safecobrowser');
    await view.webContents.executeJavaScript(`(() => {
      const a = document.getElementById('addr');
      a.value = 'example.org';
      a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await new Promise((r) => setTimeout(r, 300));

    const tabCount = await view.webContents.executeJavaScript(
      "document.getElementById('tabstrip').children.length",
    );
    // Open the Activity panel and confirm it renders (filtered to the active tab t1 → 1 row).
    const activityRows = await view.webContents.executeJavaScript(`(() => {
      document.getElementById('activity-btn').click();
      return new Promise((res) => setTimeout(() => {
        const shown = document.getElementById('activity').classList.contains('show');
        const rows = document.querySelectorAll('#activity-list .act-row').length;
        res({ shown, rows });
      }, 150));
    })()`);

    // Toggle "Auto·act" and confirm it turns on.
    const autoOn = await view.webContents.executeJavaScript(`(() => {
      document.getElementById('auto-actions').click();
      return new Promise((res) => setTimeout(() =>
        res(document.getElementById('auto-actions').classList.contains('on')), 120));
    })()`);

    console.log('window.safecobrowser type:', apiType);
    console.log('nav:go called with:', JSON.stringify(navCalled));
    console.log('tab chips rendered:', tabCount);
    console.log('activity panel:', JSON.stringify(activityRows));
    console.log('auto-actions toggled on:', autoOn);
    const ok =
      apiType === 'object' &&
      navCalled === 'example.org' &&
      tabCount === 1 &&
      activityRows.shown === true &&
      activityRows.rows === 1 && // only the t1 record (active-tab filter)
      autoOn === true;
    console.log(ok ? 'UI-SMOKE PASS' : 'UI-SMOKE FAIL');
    process.exitCode = ok ? 0 : 1;
  } catch (e) {
    console.error('UI-SMOKE ERROR', e && e.message ? e.message : e);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
});
