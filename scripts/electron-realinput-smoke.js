// Real-Chromium smoke for real-input mode (plan step 3). Proves what the fake-sink unit tests
// cannot: that the real-input path delivers genuine isTrusted events through Chromium, that real
// typing lands in a live field, that the JS path stays synthetic (isTrusted:false), and that the
// occlusion guard refuses a trusted click on a covered element. Self-quits.
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { ElectronPageController } = require(path.join(__dirname, '..', 'dist', 'main', 'page-controller.js'));

const HTML =
  'data:text/html,' +
  encodeURIComponent(`<body style="margin:0">
    <button id="go" style="position:absolute;left:40px;top:40px;width:120px;height:40px">Go</button>
    <input id="q" style="position:absolute;left:40px;top:120px;width:200px;height:30px">
    <button id="hidden" style="position:absolute;left:40px;top:200px;width:120px;height:40px">Hidden</button>
    <div id="overlay" style="position:absolute;left:0px;top:180px;width:400px;height:80px;background:rgba(0,0,0,.5)"></div>
    <script>
      window.__log = { clicks: [], keys: [] };
      document.getElementById('go').addEventListener('click', (e) => window.__log.clicks.push({ id: 'go', isTrusted: e.isTrusted }));
      document.getElementById('hidden').addEventListener('click', (e) => window.__log.clicks.push({ id: 'hidden', isTrusted: e.isTrusted }));
      const q = document.getElementById('q');
      q.addEventListener('keydown', (e) => window.__log.keys.push({ key: e.key, isTrusted: e.isTrusted }));
    </script>
  </body>`);

const read = (wc, expr) => wc.executeJavaScript(expr, true);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 500, height: 400 });
  const wc = win.webContents;
  const checks = [];
  const ok = (name, cond) => {
    checks.push({ name, cond: !!cond });
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}`);
  };

  try {
    await win.loadURL(HTML);
    win.focus();
    await new Promise((r) => setTimeout(r, 150));

    // --- Real-input controller (toggle on, tab active) ---
    const real = new ElectronPageController(() => wc, { realInputFor: () => true, isActiveTab: () => true });

    // 1. Real click → isTrusted:true on the page, honest result.
    const c = await real.click('t', '#go');
    await new Promise((r) => setTimeout(r, 50));
    let log = await read(wc, 'window.__log');
    ok('real click reports clicked+realInput', c.clicked === true && c.realInput === true);
    ok('real click landed as a TRUSTED event', log.clicks.some((x) => x.id === 'go' && x.isTrusted === true));

    // 2. Real fill → value lands, keystrokes are trusted.
    await read(wc, 'window.__log = { clicks: [], keys: [] }');
    const f = await real.fill('t', '#q', 'hi');
    await new Promise((r) => setTimeout(r, 50));
    log = await read(wc, 'window.__log');
    const qval = await read(wc, "document.getElementById('q').value");
    ok('real fill reports filled+realInput', f.filled === true && f.realInput === true);
    ok('real fill actually set the field value', qval === 'hi');
    ok('real keystrokes are TRUSTED', log.keys.length > 0 && log.keys.every((k) => k.isTrusted === true));

    // 3. Occlusion guard → covered button is NOT clicked.
    await read(wc, 'window.__log = { clicks: [], keys: [] }');
    const h = await real.click('t', '#hidden');
    await new Promise((r) => setTimeout(r, 50));
    log = await read(wc, 'window.__log');
    ok('obscured target is refused (clicked:false)', h.clicked === false && /obscured/.test(h.note || ''));
    ok('no trusted click reached the covered button', !log.clicks.some((x) => x.id === 'hidden'));

    // 4. JS path (toggle off) → synthetic, isTrusted:false.
    await read(wc, 'window.__log = { clicks: [], keys: [] }');
    const js = new ElectronPageController(() => wc, { realInputFor: () => false });
    const jc = await js.click('t', '#go');
    await new Promise((r) => setTimeout(r, 50));
    log = await read(wc, 'window.__log');
    ok('JS path reports realInput:false', jc.clicked === true && jc.realInput === false);
    ok('JS click is SYNTHETIC (isTrusted:false)', log.clicks.some((x) => x.id === 'go' && x.isTrusted === false));

    const passed = checks.every((c) => c.cond);
    console.log(passed ? 'REALINPUT-SMOKE PASS' : 'REALINPUT-SMOKE FAIL');
    process.exitCode = passed ? 0 : 1;
  } catch (e) {
    console.error('REALINPUT-SMOKE ERROR', e && e.message ? e.message : e);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
});
