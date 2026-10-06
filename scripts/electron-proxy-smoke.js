// Real-Chromium smoke for the global proxy. Needs internet and a LOGGING proxy on 127.0.0.1:18080
// (see PROXY_LOG) that speaks HTTP CONNECT and SOCKS5 and writes one line per connection.
// Checks the cases unit tests can't: that applying a proxy and reloading the SAME site really goes
// through it (closeAllConnections), that a dead proxy fails closed, and that turning it off goes direct.
// Usage: PROXY_LOG=/path/to/log node scripts/electron-proxy-smoke.js   (self-quits)
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, session } = require('electron');
const { toElectronProxy } = require(path.join(__dirname, '..', 'dist', 'settings', 'proxy.js'));

const LOG = process.env.PROXY_LOG;
if (!LOG) { console.error('set PROXY_LOG'); process.exit(2); }
const lines = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean) : []);
const cfg = (kind, port) => ({ enabled: true, kind, host: '127.0.0.1', port, username: '' });
let failed = 0;
const check = (name, ok, extra) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };

app.whenReady().then(async () => {
  const sess = session.fromPartition('persist:proxy-smoke-' + Date.now());
  const win = new BrowserWindow({ show: false, webPreferences: { session: sess } });
  const load = (url) => win.loadURL(url).then(() => 'ok', (e) => e.code || String(e));
  const apply = async (c) => { await sess.setProxy(toElectronProxy(c)); await sess.closeAllConnections(); };
  const mark = () => lines().length;

  let r = await load('https://example.com/?direct');
  check('direct load works', r === 'ok', r);
  check('direct load did not touch the proxy', mark() === 0);

  let m = mark();
  await apply(cfg('http', 18080));
  r = await load('https://example.com/?via-http');
  check('HTTP proxy: same site, reload goes through the proxy', r === 'ok' && lines().slice(m).some((l) => /CONNECT example\.com:443/.test(l)), lines().slice(m).join(' | '));

  m = mark();
  await apply(cfg('socks5', 18080));
  r = await load('https://example.com/?via-socks');
  check('SOCKS5 proxy: hostname sent to the proxy, goes through it', r === 'ok' && lines().slice(m).some((l) => /SOCKS5 example\.com:443/.test(l)), lines().slice(m).join(' | '));

  m = mark();
  await apply(cfg('http', 18999));
  r = await load('https://example.com/?dead');
  check('dead proxy fails closed (load fails, nothing goes direct)', r !== 'ok' && mark() === m, r);

  m = mark();
  await apply({ enabled: false, kind: 'http', host: '', port: 0, username: '' });
  r = await load('https://example.com/?off');
  check('turning the proxy off goes direct again', r === 'ok' && mark() === m, r);

  // WebRTC must not reach STUN outside the proxy: with the policy on, ICE gathering yields no candidates.
  const gather = () => win.webContents.executeJavaScript(`new Promise((res) => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    const types = [];
    pc.onicecandidate = (e) => { if (e.candidate) types.push(e.candidate.type + ':' + (e.candidate.address || '')); else res(types); };
    pc.createDataChannel('x'); pc.createOffer().then((o) => pc.setLocalDescription(o));
    setTimeout(() => res(types), 6000);
  })`);
  await apply({ enabled: false, kind: 'http', host: '', port: 0, username: '' });
  win.webContents.setWebRTCIPHandlingPolicy('default');
  await load('https://example.com/?rtc-default');
  const open = await gather();
  win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  await load('https://example.com/?rtc-locked');
  const locked = await gather();
  check('WebRTC default policy gathers candidates (control)', open.length > 0, open.join(','));
  check('WebRTC disable_non_proxied_udp yields NO candidates (no real-IP leak)', locked.length === 0, locked.join(','));

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  app.exit(failed ? 1 : 0);
});
