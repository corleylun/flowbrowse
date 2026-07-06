// Real-Chromium smoke for the computer-use coordinate tier. Proves coordinate clicks land as
// isTrusted events on the right element, scroll/typing work, and previewAt captures a screenshot
// with a mapped crosshair. Self-quits.
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { ElectronPageController } = require(path.join(__dirname, '..', 'dist', 'main', 'page-controller.js'));

const HTML =
  'data:text/html,' +
  encodeURIComponent(`<body style="margin:0">
    <button id="go" style="position:absolute;left:40px;top:40px;width:120px;height:40px">Go</button>
    <input id="q" style="position:absolute;left:40px;top:120px;width:200px;height:30px">
    <div style="position:absolute;top:2000px">bottom</div>
    <script>
      window.__log = { clicks: [], keys: [] };
      document.getElementById('go').addEventListener('click', (e) => window.__log.clicks.push({ id: 'go', isTrusted: e.isTrusted }));
      document.getElementById('q').addEventListener('keydown', (e) => window.__log.keys.push({ key: e.key, isTrusted: e.isTrusted }));
    </script>
  </body>`);

const read = (wc, expr) => wc.executeJavaScript(expr, true);
const rectCenter = (wc, sel) => read(wc, `(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()`);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 500, height: 400 });
  const wc = win.webContents;
  const checks = [];
  const ok = (name, cond) => { checks.push(!!cond); console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}`); };

  try {
    await win.loadURL(HTML);
    win.focus();
    wc.focus();
    await new Promise((r) => setTimeout(r, 300)); // let the window actually grab focus before input
    const pc = new ElectronPageController(() => wc, { isActiveTab: () => true });

    // 1. click_at the Go button's centre → trusted click on the right element.
    const goc = await rectCenter(wc, '#go');
    const c = await pc.clickAt('t', goc.x, goc.y, 'left');
    await new Promise((r) => setTimeout(r, 50));
    let log = await read(wc, 'window.__log');
    ok('click_at reports done+realInput', c.done === true && c.realInput === true);
    ok('click_at landed a TRUSTED click on the target', log.clicks.some((x) => x.id === 'go' && x.isTrusted === true));

    // 2. click_at the input to focus, then type_text → value lands, trusted keystrokes.
    await read(wc, 'window.__log = { clicks: [], keys: [] }');
    const qc = await rectCenter(wc, '#q');
    await pc.clickAt('t', qc.x, qc.y, 'left');
    await pc.typeText('t', 'hi');
    await new Promise((r) => setTimeout(r, 50));
    log = await read(wc, 'window.__log');
    const qval = await read(wc, "document.getElementById('q').value");
    ok('type_text set the focused field', qval === 'hi');
    ok('type_text keystrokes are TRUSTED', log.keys.length > 0 && log.keys.every((k) => k.isTrusted === true));

    // 3. scroll → window scrolls.
    await pc.scrollAt('t', 100, 100, 400, 0);
    await new Promise((r) => setTimeout(r, 80));
    const sy = await read(wc, 'window.scrollY');
    ok('scroll moved the page', sy > 0);

    // 4. previewAt → screenshot + mapped marker.
    const p = await pc.previewAt('t', goc.x, goc.y);
    ok('previewAt returns an image', p && typeof p.image === 'string' && p.image.length > 100);
    ok('previewAt maps a crosshair point', p && typeof p.x === 'number' && typeof p.y === 'number' && p.w > 0 && p.h > 0);

    // 5. background-tab honesty: not active → no input, honest note.
    const bg = new ElectronPageController(() => wc, { isActiveTab: () => false });
    await read(wc, 'window.__log = { clicks: [], keys: [] }');
    const r = await bg.clickAt('t', goc.x, goc.y, 'left');
    log = await read(wc, 'window.__log');
    ok('inactive tab: no click dispatched, honest note', r.done === false && /active tab/.test(r.note || '') && log.clicks.length === 0);

    const passed = checks.every(Boolean);
    console.log(passed ? 'COORD-SMOKE PASS' : 'COORD-SMOKE FAIL');
    process.exitCode = passed ? 0 : 1;
  } catch (e) {
    console.error('COORD-SMOKE ERROR', e && e.message ? e.message : e);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
});
