// Real-Chromium smoke for the `navigate` tool's controller path: drives the actual
// ElectronPageController.navigate against a local HTTP server (no network, no fakes) and checks
// the four behaviours unit tests can't reach — a committed load, a redirect reported honestly,
// a failed load returning ok:false with the Chromium error code, and a mid-load revoke that
// actually STOPS the navigation rather than just discarding its result. Self-quits.
const path = require('path');
const http = require('http');
const { app, BrowserWindow } = require('electron');
const { ElectronPageController } = require(path.join(__dirname, '..', 'dist', 'main', 'page-controller.js'));

// /page  → a normal page
// /go    → 302 to /page   (the "site bounced you to a login" case)
// /hang  → never responds  (so a revoke has something to interrupt)
const server = http.createServer((req, res) => {
  if (req.url === '/go') {
    res.writeHead(302, { Location: '/page' });
    res.end();
  } else if (req.url === '/hang') {
    // deliberately no response
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<title>SmokeNav</title><body><h1>navigated</h1></body>');
  }
});

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    const pc = new ElectronPageController(() => win.webContents);

    // 1. A plain load commits, and reports the committed url + title.
    const plain = await pc.navigate('main', `${base}/page`);
    check('plain load commits', plain.ok && plain.url === `${base}/page` && plain.title === 'SmokeNav',
      JSON.stringify(plain));

    // 2. A redirect reports the FINAL url, not the requested one — this is what lets an agent
    //    notice it was bounced to a login/consent page.
    const redirected = await pc.navigate('main', `${base}/go`);
    check('redirect reports the committed url', redirected.ok && redirected.url === `${base}/page`,
      JSON.stringify(redirected));

    // 3. A failed load is honest: ok:false + the Chromium error code, never a throw (a thrown
    //    handler reaches the agent as the opaque "tool handler failed").
    const failed = await pc.navigate('main', 'http://127.0.0.1:1/nope');
    check('failed load returns ok:false with a code',
      failed.ok === false && typeof failed.note === 'string' && failed.note.startsWith('ERR_'),
      JSON.stringify(failed));

    // 4. A revoke mid-load STOPS the navigation and surfaces as Revoked (not "load failed"),
    //    and the page must not have moved to the hanging url.
    const before = win.webContents.getURL();
    const ac = new AbortController();
    let live = true;
    const liveness = { isLive: () => live, signal: ac.signal };
    setTimeout(() => {
      live = false;
      ac.abort();
    }, 300);
    let revoked = null;
    try {
      const r = await pc.navigate('main', `${base}/hang`, liveness);
      revoked = { threw: false, result: r };
    } catch (e) {
      revoked = { threw: true, reason: e && e.reason, message: e && e.message };
    }
    check('mid-load revoke surfaces as Revoked', revoked.threw && revoked.reason === 'revoked',
      JSON.stringify(revoked));
    check('mid-load revoke actually stopped the load', win.webContents.getURL() === before,
      `url=${win.webContents.getURL()}`);

    const pass = results.every((r) => r.ok);
    console.log(pass ? 'NAVIGATE-SMOKE PASS' : 'NAVIGATE-SMOKE FAIL');
    process.exitCode = pass ? 0 : 1;
  } catch (e) {
    console.error('NAVIGATE-SMOKE ERROR', e && e.message ? e.message : e);
    process.exitCode = 1;
  } finally {
    win.destroy();
    server.close();
    app.quit();
  }
});
