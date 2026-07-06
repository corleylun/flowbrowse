// Real-Chromium adversarial smoke for invariant #5 (no injection via the main-world
// action scripts). Runs the ACTUAL ElectronPageController.click/fill/inspect with
// hostile selectors and values embedded via JSON.stringify, and asserts that no
// attacker-controlled JS executed (a page global `window.__pwned` stays unset).
//
// The selectors/values below are crafted to break out of the JS string literal the
// controller builds, e.g.  document.querySelector("<SELECTOR>")  /  el.value = "<VALUE>".
// If JSON.stringify escaping is sound, none of them execute extra JS. Self-quits.
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { ElectronPageController } = require(path.join(__dirname, '..', 'dist', 'main', 'page-controller.js'));

// A page with a real input + button so click/fill/inspect have something to (legit) match.
const HTML =
  'data:text/html,' +
  encodeURIComponent(
    '<title>Inj</title><body>' +
      '<input id="real" name="real" />' +
      '<button id="btn">go</button>' +
      '<div id="probe">probe</div>' +
      // A field that discards writes (an oninput handler resets it) — stands in for a rich-text
      // editor that ignores direct value writes. Honest fill must report filled:false here.
      '<input id="reverts" oninput="this.value=\'REVERTED\'" />' +
      '<div id="ce" contenteditable="true"></div>' +
      '</body>',
  );

// U+2028 / U+2029 are valid JS line terminators that JSON.stringify does NOT escape.
const LS = ' ';
const PS = ' ';

// Each entry is a string the attacker controls. The intent of each is to escape the
// surrounding "..." literal and run `window.__pwned=...`.
const PAYLOADS = [
  `"); window.__pwned=1; ("`,
  `'); window.__pwned=1; ('`,
  `\\"); window.__pwned=1; ("`,
  `\\'); window.__pwned=1; //`,
  `${LS}window.__pwned=1;${LS}"`, // line-separator break-out (the JSON.stringify gotcha)
  `${PS}window.__pwned=1;${PS}"`,
  `</script><script>window.__pwned=1</script>`,
  '${window.__pwned=1}', // template-literal-ish, harmless inside a normal string literal
  `"+window.__pwned=1+"`,
  `"]; window.__pwned=1; ["`,
  `\n window.__pwned=1; \n`,
  `\r\n window.__pwned=1; \r\n`,
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  let failures = 0;
  const note = (m) => console.log('[inj]', m);
  try {
    await win.loadURL(HTML);
    const pc = new ElectronPageController(() => win.webContents);
    const wc = () => win.webContents;

    const pwned = async () => {
      // Returns true if any attacker JS set the flag.
      return wc().executeJavaScript('!!window.__pwned', false);
    };
    const reset = async () => {
      await wc().executeJavaScript('window.__pwned = undefined; true', false);
    };

    for (const payload of PAYLOADS) {
      // ---- click(selector = payload) ----
      await reset();
      try {
        await pc.click('main', payload);
      } catch (_e) {
        // A thrown selector-syntax error is fine; an EXECUTED payload is not.
      }
      if (await pwned()) {
        failures++;
        note('CLICK INJECTION EXECUTED for payload ' + JSON.stringify(payload));
      }

      // ---- fill(selector = '#real', value = payload) ----
      await reset();
      try {
        await pc.fill('main', '#real', payload);
      } catch (_e) {
        /* ignore */
      }
      if (await pwned()) {
        failures++;
        note('FILL(value) INJECTION EXECUTED for payload ' + JSON.stringify(payload));
      }

      // ---- fill(selector = payload, value = 'x') ----
      await reset();
      try {
        await pc.fill('main', payload, 'x');
      } catch (_e) {
        /* ignore */
      }
      if (await pwned()) {
        failures++;
        note('FILL(selector) INJECTION EXECUTED for payload ' + JSON.stringify(payload));
      }

      // ---- inspect(selector = payload) ----
      await reset();
      try {
        await pc.inspect('main', payload);
      } catch (_e) {
        /* ignore */
      }
      if (await pwned()) {
        failures++;
        note('INSPECT INJECTION EXECUTED for payload ' + JSON.stringify(payload));
      }
    }

    // Sanity: legit calls still work (selectors aren't over-sanitized into uselessness).
    const click = await pc.click('main', '#btn');
    const fill = await pc.fill('main', '#real', 'hello-world');
    const inspect = await pc.inspect('main', '#probe');
    const valueSet = await wc().executeJavaScript('document.getElementById("real").value', false);
    const legitOk =
      click.clicked === true &&
      fill.filled === true &&
      valueSet === 'hello-world' &&
      inspect.matched === true &&
      inspect.tagName === 'div';
    if (!legitOk) {
      failures++;
      note('LEGIT calls did not behave as expected: ' + JSON.stringify({ click, fill, valueSet, inspect }));
    }

    // Also confirm a legit fill of an injection-looking VALUE is stored verbatim (not executed).
    await reset();
    await pc.fill('main', '#real', '"); window.__pwned=1; ("');
    const verbatim = await wc().executeJavaScript('document.getElementById("real").value', false);
    if (await pwned()) {
      failures++;
      note('FILL value executed when it should have been stored as text');
    }
    if (verbatim !== '"); window.__pwned=1; ("') {
      failures++;
      note('FILL value not stored verbatim: ' + JSON.stringify(verbatim));
    }

    // Honesty (P1a): filling a field that discards the write must report filled:false, not lie.
    const honest = await pc.fill('main', '#reverts', 'should-not-stick');
    if (honest.filled !== false) {
      failures++;
      note('HONEST FILL: expected filled:false when the field reverts, got ' + JSON.stringify(honest));
    }
    // ...and a normal field that accepts the write must still report filled:true.
    const honestOk = await pc.fill('main', '#real', 'landed-ok');
    if (honestOk.filled !== true) {
      failures++;
      note('HONEST FILL: expected filled:true on a real input, got ' + JSON.stringify(honestOk));
    }

    // P1b: contenteditable fill must land and preserve newlines + emoji.
    const ce = await pc.fill('main', '#ce', 'line one\nline two 🚀');
    const ceText = await wc().executeJavaScript('document.getElementById("ce").innerText', false);
    if (ce.filled !== true) {
      failures++;
      note('CE FILL: expected filled:true on contenteditable, got ' + JSON.stringify(ce));
    }
    if (!/line one/.test(ceText) || !/line two/.test(ceText) || !/🚀/.test(ceText)) {
      failures++;
      note('CE FILL: text/emoji not preserved: ' + JSON.stringify(ceText));
    }

    if (failures === 0) {
      console.log('INJECTION-SMOKE PASS (no attacker JS executed across ' + PAYLOADS.length + ' payloads)');
    } else {
      console.log('INJECTION-SMOKE FAIL (' + failures + ' breakouts)');
    }
    process.exitCode = failures === 0 ? 0 : 1;
  } catch (e) {
    console.error('INJECTION-SMOKE ERROR', e && e.message ? e.message : e);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
});
