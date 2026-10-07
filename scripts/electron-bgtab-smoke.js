// Real-Chromium smoke: selector click/fill with REAL input on a BACKGROUND (hidden) tab, through the actual
// ElectronPageController. Checks the click lands, typing lands, and that the coordinate tools still refuse
// a non-active tab. Self-quits.
const path = require('path');
const { app, BaseWindow, WebContentsView } = require('electron');
const { ElectronPageController } = require(path.join(__dirname, '..', 'dist', 'main', 'page-controller.js'));

const html = 'data:text/html,<title>start</title><body style="margin:0"><button id=go style="position:absolute;left:100px;top:100px;width:200px;height:80px" onclick="document.title=\'CLICKED\'">go</button><input id=q style="position:absolute;left:100px;top:300px;width:200px"></body>';
let failed = 0;
const check = (n, ok, x) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); if (!ok) failed++; };

app.whenReady().then(async () => {
  const win = new BaseWindow({ width: 900, height: 700, show: true });
  const mk = () => { const v = new WebContentsView({ webPreferences: { sandbox: true } }); win.contentView.addChildView(v); v.setBounds({ x: 0, y: 0, width: 900, height: 700 }); return v; };
  const fg = mk(), bg = mk();
  await fg.webContents.loadURL(html); await bg.webContents.loadURL(html);
  bg.setVisible(false);
  const views = { fg, bg };
  const pc = new ElectronPageController((id) => views[id].webContents, {
    realInputFor: () => true,
    isActiveTab: (id) => id === 'fg',
    highlight: () => {},
  });
  let r = await pc.click('bg', '#go', undefined, undefined);
  await new Promise((r2) => setTimeout(r2, 300));
  // Read document.title through the page: a hidden view's window title can lag.
  const title = (v) => v.webContents.executeJavaScript('document.title');
  check('real click on a hidden background tab lands', r.clicked === true && r.realInput === true && (await title(bg)) === 'CLICKED', JSON.stringify(r));
  check('the foreground tab was untouched', (await title(fg)) === 'start');
  const f = await pc.fill('bg', '#q', 'hello', undefined, undefined);
  const v = await bg.webContents.executeJavaScript('document.getElementById("q").value');
  check('real typing into a hidden background tab lands', f.filled === true && f.realInput === true && v === 'hello', JSON.stringify(f));
  const c = await pc.clickAt('bg', 150, 140, 'left', undefined);
  check('coordinate tools still refuse a non-active tab', c.done === false && /active tab/.test(c.note || ''), JSON.stringify(c));
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  app.exit(failed ? 1 : 0);
});
