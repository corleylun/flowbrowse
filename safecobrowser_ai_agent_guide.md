# SafeCoBrowser — AI Agent Guide

> How an external AI agent (Claude Code, Codex, or any MCP client) drives **SafeCoBrowser**:
> the tools, the permission model, how a call resolves, and the patterns that work.
>
> **One-sentence model:** SafeCoBrowser is a real, logged-in browser that the **human controls**.
> You (the agent) are a guest who can see and act **only inside the permission the human
> grants, per tab, right now** — and they can cut your access instantly. You are the "brain";
> SafeCoBrowser is the gated "body."

---

## 1. The golden rules (read first)

1. **You start with nothing.** Every tab is **Blocked** by default. Until the human raises the
   mode in the SafeCoBrowser UI, every **page/action** tool call returns `permission_denied`.
   (Four tools are off the ladder and always work: `get_mode` to check the current mode,
   `list_tabs`/`switch_tab` to see and move between tabs, and `submit_feedback`.) **Call `get_mode`
   first** to see where you stand instead of guessing.
2. **You cannot escalate yourself.** There is **no** tool/endpoint to change the permission
   mode. Only the human's UI can. Don't look for one; it doesn't exist by design.
3. **You act on the ACTIVE tab by default — or another tab if you pass `tab`.** Every tool call
   may carry an optional `tab` (an id from `list_tabs`) to target a *different* tab than the
   foreground one, without switching focus. The target tab's **own** permission mode is the only
   gate — a background tab the human left at **Off** (the default) is exactly as invisible to you
   as if you'd called it while it was active; a background tab the human explicitly granted Read/Act
   is usable at that grant, from any tab you're currently on. See §8.
4. **Access can vanish mid-call.** "Stop AI" or a mode change bumps a session epoch and makes
   your in-flight and future calls **fail closed** (`revoked` / `permission_denied`). Handle it
   gracefully; never assume a grant persists.
5. **You never get the profile.** No cookies, no password DB, no profile directory, no other
   sites' sessions. You get **only** the brokered tools below. (`run_js` can *read* page-context
   `document.cookie` if granted Developer mode — see §5.8 — but you never touch the cookie store.)
6. **Everything you do is logged.** Every call (allowed or denied) is written to a tamper-evident
   audit log the human can inspect. Act like it's on the record — it is.
7. **No retroactive leak.** When the human grants Read, you see the page **as it is at call
   time** — never what it showed while you were blind (e.g. their login). Don't ask for it.
8. **Some text may be redacted.** If the human's **privacy filter** is on, sensitive values appear
   as labels like `[Name]` / `[Account]` in everything you read. That's deliberate — work with the
   placeholder and never try to recover the hidden value (see §9).

---

## 2. Connecting

SafeCoBrowser runs a localhost control server (bound to `127.0.0.1` only) the moment the app
launches. There are two equivalent front-ends over the **same broker**: MCP and a CLI.

### 2.1 Discover the endpoint
On launch SafeCoBrowser writes:

```
~/.safecobrowser/endpoint.json   →   { "url": "http://127.0.0.1:8676", "token": "<bearer>" }
```

The bearer token is **required even on localhost**. The server also validates `Host`/`Origin`
against DNS-rebinding. If the file is missing, SafeCoBrowser isn't running.

**Remote / another machine.** By default the server binds to loopback only, so an agent on a
different PC can't reach it. Two ways to connect remotely:
- **Recommended — tunnel (encrypted):** forward the port from the remote PC and keep pointing at
  loopback, e.g. `ssh -N -L 8676:127.0.0.1:8676 you@host` (or use Tailscale). Nothing to enable
  in the app; traffic is encrypted by the tunnel.
- **Native LAN — Settings → Agent connection → "Allow LAN connections"** (default off). Rebinds
  to `0.0.0.0`, allowlists the machine's LAN IPs, and shows a LAN MCP URL
  (`http://<lan-ip>:<port>/mcp`) to use in place of `127.0.0.1`. The surface is **plaintext HTTP**
  — only for a trusted network; use the tunnel for anything over the internet. The bearer token +
  per-tab AI block still apply, and only the explicit LAN IPs are accepted (rebinding guard holds).

### 2.2 MCP (for Claude Code / Codex)
- **Endpoint:** `POST {url}/mcp` — MCP **Streamable HTTP**, stateless (one server/transport per
  request), `enableJsonResponse: true`.
- **Auth header:** `Authorization: Bearer <token>` (from `endpoint.json`).
- **Server name:** `safecobrowser`. It exposes exactly the tools in §5; each MCP tool call is
  forwarded straight to the broker.
- The MCP input schema is intentionally permissive (open object) — the **broker** does the real
  per-tool validation, so malformed input comes back as `invalid_input`, not a schema crash.

Example Claude Code registration (conceptual — read the live token from the file):
```jsonc
{
  "mcpServers": {
    "safecobrowser": {
      "transport": "http",
      "url": "http://127.0.0.1:8676/mcp",
      "headers": { "Authorization": "Bearer <token-from-~/.safecobrowser/endpoint.json>" }
    }
  }
}
```

### 2.3 CLI (same broker, handy for scripting/testing)
```
safecobrowser status                 # session status (and the active tab id)
safecobrowser tools                  # list available tools + their mode/risk/approval
safecobrowser invoke <tool> [json]   # invoke a tool through the broker
safecobrowser audit [n]              # last n audit records (default 20)
safecobrowser audit verify           # verify the audit log's hash chain
```
(Run as `node dist/cli/safecobrowser.js …` until a `bin` is installed.)
`status`/`tools`/`invoke` need SafeCoBrowser running; `audit` reads the local log and works offline.

A tool call returns a JSON **InvokeResult** (see §6). The CLI exits `0` on `ok`, `2` on denial.

---

## 3. The permission ladder

Modes are an ordered ladder. A tool declares the **minimum** mode it needs; the broker allows a
call only if the tab's **current** mode is at least that high.

| Mode | Value | Unlocks (cumulative) |
|------|-------|----------------------|
| **Blocked** | `blocked` | nothing — AI is off (default) |
| **Read** | `read` | `read_page`, `screenshot`, `locate`, `list_recipes`, `get_recipe` |
| **Inspect** | `inspect` | + `inspect_element`, `read_console`, `read_network` |
| **Act** (UI: *Assist*) | `act` | + `click`, `fill`, `scroll_to`, and the coordinate tools `move_to` / `click_at` / `scroll` / `press_key` / `type_text` (all behind approval) |
| **Develop** (UI: *Developer*) | `develop` | + `run_js` (full page control) |

- Higher modes include everything below (Act can also Read/Inspect).
- The human sets this **per tab** in the toolbar. **Read the current mode with `get_mode`**
  (or `safecobrowser status`, which now includes `mode`) — it's the active tab's mode, read-only.
  You still **cannot change** it; a `permission_denied` means the tab is below that tool's `minMode`,
  so ask the human to raise it. After a relaunch every tab resets to **Off** — `get_mode` is how you
  notice rather than hammering denied calls.
- **Do not nag.** If you're denied, state what mode you'd need and let the human decide.
- **Off-ladder tools sit beside this table:** `get_mode`, `list_tabs`, `switch_tab`, and
  `submit_feedback` aren't page operations, so they work at **any** mode (including Blocked) — see
  §4. They're governed by their own rules (a Settings toggle for the tab tools, approval for
  feedback), not by the ladder.

---

## 4. What you can and can't do at each mode

- **Blocked:** nothing. Every call → `permission_denied`.
- **Read:** summarize/extract the page, screenshot it, and **read the user's saved recipes** for
  this site (`list_recipes` / `get_recipe`) to learn how a task is done here. No DOM queries, no
  console/network, no actions.
- **Inspect:** everything in Read **plus** element inspection and console/network metadata — ideal
  for *diagnosing* a page (find selectors, read errors, see failed requests) without changing it.
- **Act / Assist:** everything above **plus** `click` and `fill`, each gated by an **approval
  card** (or the human's per-tab auto-approve). Use this to drive forms/buttons.
- **Any mode (off the ladder):** `submit_feedback` (approval-gated; §5.11), `list_tabs`, and
  `switch_tab` work regardless of the tab's mode — they aren't page operations. `list_tabs`/`switch_tab`
  are governed instead by the human's **Allow agent tab control** Settings toggle (default on);
  see §5.13–5.14.
- **Develop:** everything **plus** `run_js` — arbitrary JS in the page. Most powerful and most
  dangerous; its own explicit grant, always approval-gated, always logged.

---

## 5. The tools (full reference)

> Inputs are validated by the broker. Bad shapes return `invalid_input` (fail closed).
> Outputs below are the `output` field of a successful InvokeResult.

### 5.1 `read_page` — Read · Low risk · no approval
Read the current page.
- **Input:** none (`{}`)
- **Output:** `{ url, title, text, links: [{ href, text }] }`
- `text` is visible text (whitespace-collapsed); `links` are anchor hrefs + their text.

### 5.2 `screenshot` — Read · Low risk · no approval
Capture the current page as a PNG.
- **Input:** none (`{}`)
- **Output:** `{ mimeType: "image/png", base64 }`
- **Note:** the base64 is large — save it to a file rather than echoing it into the conversation.

### 5.2b `locate` — Read · Low risk · no approval
Resolve visible elements to **coordinates** by text or CSS selector — the fast half of the
computer-use loop. Use it to target `click_at` / `move_to` **without** a `screenshot` + vision pass:
the coordinates come straight from the page's layout (~20–30 ms), so acting becomes deterministic.
- **Input:** `{ text?: string, selector?: string }` (at least one; both are audited)
- **Output:** `{ query, count, matches: [{ matched, tag, x, y, rect, inViewport, obscured }] }`
- `x`/`y` are the element **centre in CSS viewport px** — the exact space `click_at`/`move_to` take.
- Prefer a match with `inViewport: true` and `obscured: false`. If the best match is
  `inViewport: false`, call **`scroll_to`** (§5.8b) to reveal it (locate is **read-only** — it never
  scrolls or changes the page).
- Pattern: `locate({ text: "Buy" })` → pick a clean match → `click_at({ x, y })`. On a DOM page this
  replaces the slow screenshot→find-the-pixel loop; keep the coordinate/screenshot path for
  canvas / no-DOM pages only.

### 5.3 `inspect_element` — Inspect · Low risk · no approval
Inspect one DOM element by CSS selector. (Selector is audited.)
- **Input:** `{ selector: string }`
- **Output:** `{ matched, tagName?, attributes?, text?, outerHTML?, rect? }`
- If nothing matches, `matched: false`. Use this to discover real selectors before acting.

### 5.4 `read_console` — Inspect · Low risk · no approval
Recent console messages.
- **Input:** `{ limit?: number }` (default `100`, max `1000`)
- **Output:** `[{ level, text, ts }]`

### 5.5 `read_network` — Inspect · Low risk · no approval
Recent network request **metadata** (not bodies).
- **Input:** `{ limit?: number }` (default `100`, max `1000`)
- **Output:** `[{ method, url, status?, ts }]`
- Great for diagnosing failed submits/API calls (look for non-2xx `status`).

### 5.6 `click` — Act · Medium risk · **approval required**
Click a visible element by CSS selector.
- **Input:** `{ selector: string }`
- **Output:** `{ clicked, matched, realInput?, note? }` — `matched` is the element's text/label.
- Blocks until the human approves (or auto-approve is on for actions). Selector is audited.
- **`realInput`** (see 5.6a) tells you *how* the click was delivered. If the human enabled **Real
  input** for the tab and the click was obscured by an overlay, `clicked` is `false` with a `note`
  like `target obscured` — it will **not** click the wrong thing; handle it (scroll, dismiss the
  overlay, retry) rather than assuming success.

#### 5.6a Real-input mode (you don't control this)
Each tab has a **user-set** "Real input" toggle. When it's on, `click`/`fill` are driven by **real,
trusted** input (the cursor actually moves and clicks; text is typed key by key) instead of
JavaScript-synthesized events — which is what some sites require (they reject `isTrusted:false`
events). You **cannot read or set this toggle**, and it never changes your permission mode; it only
changes how your `click`/`fill` are delivered. The result carries **`realInput: true|false`** so you
know which path ran (real input only fires on the active tab; otherwise it falls back to the JS path
and says so). It is **not** a stealth feature, and there is no tool to humanize timing or motion — if
a site still blocks real, trusted input, that's the site's policy; ask the human, don't try to evade.

### 5.7 `fill` — Act · Medium risk · **approval required**
Type a value into an input by CSS selector.
- **Input:** `{ selector: string, value: string }`
- **Output:** `{ filled, matched, note?, realInput? }`
- **Rich editors handled automatically.** For contenteditable / Lexical / Draft / ProseMirror,
  `fill` falls back to a real **paste-style insert** (preserves newlines + emoji), so most modern
  composers just work. React-controlled inputs are handled via the native value setter.
- **`filled` is honest.** After typing, SafeCoBrowser reads the field back and returns
  **`filled: false` (with a `note`)** only if the value *still* didn't land after those fallbacks —
  e.g. an editor that rejects synthetic input, or a readonly/page-validated field. **Do not assume
  success — check `filled`.** On a miss, the `note` suggests `run_js` or asking the user to paste.
- **The value is NEVER logged** (could be a password); the **selector IS** logged
  (`#email (value hidden)`), so the human can see *what field* you filled without exposing the
  value. Filling does **not** submit — submitting is a separate `click` you must request explicitly.

### 5.8 `run_js` — Develop · **High risk** · **approval required**
Run arbitrary JavaScript in the page and return its result.
- **Input:** `{ script: string }` (max 100,000 chars)
- **Output:** the script's return value (any JSON-serializable value)
- This is **full page control**: it can read `document.cookie` in page context, mutate the DOM,
  and exfiltrate. It is its own grant (never bundled into read-only access), the **script is shown
  to the human in the approval card**, and **every script is logged in full**. Prefer the
  narrower tools (Read/Inspect/Act) whenever they suffice; reach for `run_js` only when you must.

### 5.8a Computer-use coordinate tools — Act · Medium risk · **approval required**
When a page has no usable DOM for `click`/`fill` (canvas/WebGL apps, embedded content, obfuscated
markup), drive it by **coordinates read from a `screenshot`** — the same way a person points and
clicks. These deliver real, trusted input at a viewport point. All are Act-tier and approval-gated,
and the approval card shows the human a **screenshot with a crosshair on your target**, so they
approve *what* you're about to act on.

- **`move_to`** — `{ x, y }` → move the cursor.
- **`click_at`** — `{ x, y, button? }` (`left`|`right`) → real click at the point.
- **`scroll`** — `{ x, y, dy, dx? }` → wheel-scroll at the point. **Positive `dy` scrolls down**
  (like the DOM / `scrollBy`).
- **`press_key`** — `{ key }` → one key from a fixed allowlist: `Enter`, `Tab`, `Escape`,
  `Backspace`, `Delete`, `ArrowUp/Down/Left/Right`, `Home`, `End`, `PageUp`, `PageDown`, `Space`.
  No modifier chords, no F-keys (they could fire app/devtools shortcuts).
- **`type_text`** — `{ text }` → type at the **currently focused** field (focus it first with a
  `click_at`). Audited as a character count only — the text is never logged (it may be a secret).

**Coordinates are CSS viewport pixels**, origin = top-left of the page content. The `screenshot` is
your reference; if its pixel size differs from the viewport, scale your point by
`viewport / image`. Each call returns `{ done, realInput, note? }`; `done:false` with a `note` like
*coordinate input needs the active tab* means the tab wasn't in front (switch to it first). Prefer
the selector tools (`click`/`fill`) when the DOM is usable — they give the human a far more legible
approval card than a coordinate. These are **not** a stealth feature: real trusted input only, no
humanized motion or timing.

### 5.8b `scroll_to` — Act · Low risk · **approval required**
Bring an element into view by text or CSS selector, then get its **settled** coordinates. Use it
right after `locate` reports a match as `inViewport: false`, so one targeted scroll replaces the
blind "scroll a bit, screenshot, still not there, scroll again" loop on a long page.
- **Input:** `{ text?: string, selector?: string }` (at least one; audited)
- **Output:** `{ found, matched?, x?, y?, inViewport?, obscured?, note? }` — `x`/`y` are the centre
  **after** the scroll settles, ready for `click_at` / `move_to`.
- `found: false` (with a note) if nothing matches; a post-scroll `obscured: true` means something
  still covers it. The approval card shows your query text (e.g. *scroll to "Add to Bag"*), not a
  raw delta. Chain it: `locate` (find) → `scroll_to` (reveal) → `click_at` (act).

### 5.9 `list_recipes` — Read · Low risk · no approval
List the user's saved **recipes** (recorded, named how-to tutorials) for the current page's site.
- **Input:** none (`{}`)
- **Output:** `{ domain, recipes: [{ name, description?, steps }] }`
- Scoped to the **active tab's registrable domain** (e.g. on `mobile.x.com` you get `x.com`'s
  recipes). Empty list = no recipes for this site. Read-only; this never runs anything.

### 5.10 `get_recipe` — Read · Low risk · no approval
Read one recipe's annotated, step-by-step how-to so you can reproduce it with `click`/`fill`.
- **Input:** `{ name: string }` (a name from `list_recipes`)
- **Output:** `{ name, domain, description?, steps: [{ n, name?, description?, action, type, selector?, label?, value?, sensitive?, url? }] }`
- `action` is a human summary (e.g. `type "askmingli" into "Search"`, `press Enter to submit`);
  `selector`/`label` let you re-perform the step with your own tools. **Sensitive field values are
  withheld** (`sensitive: true`, no `value`) — you must ask the human to fill those.
- Pattern: on a site, call `list_recipes` → pick one → `get_recipe` → follow the steps using
  `click`/`fill` (each still approval-gated at Act). The recipe is *guidance*, not an auto-runner.
- **Follow the intent, not just the literal rows.** A recipe's `description` may describe a
  *generalizable pattern* (e.g. "the statements are in `dl.dl-row`; click each row's download
  button, incrementing the row index until none match — there may be more rows than were
  recorded"). When the live page has more items than the recorded steps, read the page and apply
  the pattern to **all** of them rather than replaying only the captured rows.

### 5.11 `submit_feedback` — Any mode · Medium risk · **approval required**
Send the user's feedback/opinion about SafeCoBrowser to FlowStations.
- **Input:** `{ message: string, email?: string }`
- **Output:** `{ sent: true }`
- **Works at any tab mode (even Off)** — feedback is not a page operation, so it isn't on the
  permission ladder. Its sole guard is the **approval card**: the **exact message is shown to the
  human** before anything is sent. Only `message`/`email` travel — **never page content**. The audit
  logs that feedback was sent and its length, not the body.
- Use it to relay *your own* assessment of the tool, or to forward feedback the user dictates. Put
  the opinion in `message`; do **not** paste page data or secrets.

### 5.12 `get_mode` — Any mode · Low risk · no approval
Read the active tab's current AI permission mode.
- **Input:** none (`{}`)
- **Output:** `{ tab, mode }` where `mode` is `blocked | read | inspect | act | develop`.
- **Works at any mode (even Off)** and needs no approval — it reveals only the human's own per-tab
  setting (no page/session data) and **cannot change** it. Call it to know what you can do instead of
  inferring from `permission_denied` — especially after a relaunch (all tabs reset to **Off**).

### 5.13 `list_tabs` — Any mode · Low risk · no approval
List the open tabs so you can find one to target (via `switch_tab`, or the per-call `tab` field —
see §8).
- **Input:** none (`{}`)
- **Output:** `{ tabs: [{ tab, active, mode, title, url }] }` — `tab` is the id (e.g. `t2`), `active`
  marks the foreground tab, `mode` is that tab's permission mode, and `title`/`url` are
  privacy-filtered. If the human has disabled agent tab control (a Settings toggle), only the active
  tab is returned.
- **Works at any mode (even Off)**; no approval. It reveals only tab metadata, never page content.

### 5.14 `switch_tab` — Any mode · Low risk · no approval
Bring another tab to the foreground; your **subsequent** tool calls default to it (unless they pass
their own `tab`).
- **Input:** `{ tab }` — an id from `list_tabs` (e.g. `{"tab":"t2"}`).
- **Output:** `{ switched, tab?, reason? }`. `switched:false` (with a `reason`) if the human has
  disabled tab control or the id is unknown.
- **Does NOT change any tab's mode.** Switching only re-targets the foreground among tabs the human
  has already set up — a tab that's **Off** still exposes nothing after you switch to it (call
  `get_mode` to confirm the new tab's mode, then ask the human to raise it if needed). You **cannot**
  open or close tabs; only the human can. Every switch is audit-logged and visibly changes the
  foreground, so the human always sees where you went.
- If you only need to act on another tab **once**, you usually don't need `switch_tab` at all — pass
  `tab` on the call itself (§8) and leave the human's foreground alone.

---

## 6. How a call resolves

Every invocation may include an optional `tab` (see §8) alongside its normal input, and returns an
**InvokeResult**:

```ts
// success
{ ok: true, output: <tool output> }
// denial / failure
{ ok: false, reason: <DenyReason>, message?: string }
```

### Deny reasons (all fail closed)
| `reason` | Meaning | What you should do |
|----------|---------|--------------------|
| `permission_denied` | Tab mode is below the tool's `minMode` (incl. AI Off), **or** you passed `tab` for a non-active tab while "Allow agent tab control" is off | Tell the human which mode you need; don't retry blindly |
| `invalid_input` | Input failed the tool's schema, **or** `tab` wasn't a string / didn't match any open tab | Fix the input (or the `tab` id via `list_tabs`) and retry |
| `approval_required` | Needed approval, none was granted (incl. card **timeout ~120s**) | Re-request only if the human still wants it |
| `approval_rejected` | The human pressed **Reject** | Stop. Do not retry the same action |
| `revoked` | Grant was pulled mid-flight ("Stop AI" / mode change / tab closed) | Treat access as gone; re-confirm before continuing |
| `timeout` | Handler exceeded its time budget | Retry once; if it persists, report it |
| `handler_error` | The tool threw while executing | Report the `message`; the page may be in an odd state |
| `unknown_tool` | No such tool | Check the name against `safecobrowser tools` |

### Approval flow (for `click`, `fill`, `run_js`)
1. You invoke the tool.
2. SafeCoBrowser shows the human an **approval card** with the concrete effect (selector, or the full
   `run_js` script). Your call **blocks** meanwhile.
3. The human **Approves** → the tool runs and you get `{ ok: true, ... }`.
   The human **Rejects** → `approval_rejected`. No answer within ~120s → `approval_required`.
4. The human may have **auto-approve** on for that tab (one toggle for actions = `click`/`fill`,
   a separate one for `run_js`). Then approved calls run **without a card** — but are still fully
   logged. You can't tell the difference from the result, and you shouldn't rely on it being on.
   Auto-approve applies whether or not that tab is the active one: a `tab`-targeted call (§8) on an
   auto-approved tab also runs card-less (still audited with its tab id).

---

## 7. Sessions, epochs, and instant revoke

- There is one authoritative session state per tab, carrying an **epoch**.
- Tool handlers and approvals re-check the **live epoch at execution time**. So even after a card
  is approved, if the human hits **Stop AI** before the click actually fires, the action does
  **not** run (`revoked`). This is what makes "instant revoke" real.
- **Practical consequence:** never treat a successful grant as durable. If you get `revoked` or a
  sudden `permission_denied`, the human pulled access — pause and re-confirm, don't hammer.

---

## 8. Multi-tab behavior

- SafeCoBrowser can have several tabs, each with its **own** container (isolated cookies/logins) and
  its **own** permission mode.
- **Every call defaults to the active (foreground) tab** (`safecobrowser status` → `tab`) — but any
  call may carry an optional `tab` field (an id from `list_tabs`) to target a *different* tab
  instead, without touching the human's foreground. E.g. `read_page` with no `tab` reads whatever the
  human is looking at; `{"tab":"t2"}` alongside any tool's normal input reads/acts on `t2` even while
  the human stays on `t1`.
- **The target tab's own mode is the only gate.** Targeting a tab does **not** grant you anything —
  a `tab` pointing at a tab the human left **Off** (the default) is denied exactly like calling that
  tab while it was active; a tab already granted Read/Act works at that grant. You still cannot open,
  close, or change the mode of any tab this way.
- **Fails closed on a bad `tab`:** a `tab` that isn't a string, or doesn't match any open tab, is
  rejected as `invalid_input` — it never silently falls back to the active tab.
- **`tab` targeting itself is gated by the human's "Allow agent tab control" setting** (default on).
  If it's off, a `tab` that differs from the active tab is denied (`permission_denied`); the active
  tab still works as always, and `list_tabs`/`switch_tab` behave as documented in §5.13–5.14.
- **Approval cards say when it's not the tab you're looking at.** If an approval-gated call (`click`,
  `fill`, `run_js`, …) targets a non-active tab, the card the human sees adds a `Tab: <title>` line
  (privacy-filtered) — so they aren't approving an effect on a tab they aren't even looking at. If the
  target tab has the human's **auto-approve** on, the call runs **without a card** (on any tab,
  foreground or background — auto-approve is the human's deliberate "don't ask me for this tab"); every
  such call is still recorded in the audit log with its tab id.
- **`list_tabs`** shows every open tab (id, active, mode, title, url); **`switch_tab {tab}`** moves the
  foreground so *subsequent, `tab`-less* calls default to it. Both are gated by **Allow agent tab
  control**; if it's off, `list_tabs` shows only the active tab and `switch_tab` is denied.
- **Switching (and targeting) is not escalation.** Neither changes any tab's mode; a tab at **Off**
  still exposes nothing either way. Call `get_mode` (optionally with `tab`) to confirm a tab's mode
  before relying on it. You **cannot open or close** tabs — only the human can.
- The grant **persists across navigation** within a tab (changing URL does not drop your access);
  only Stop AI / a mode change / closing the tab clears it.

---

## 9. The privacy filter (you may see redacted text)

The human can turn on a **privacy filter** — their own list of sensitive strings (name, address,
account numbers) that SafeCoBrowser replaces with labels like `[Name]` or `[Account]`. There is **no
tool** for it and you can't see or change it; like the permission mode, it's the human's control.

What it means for you:

- **What you read may be redacted.** `read_page`, `inspect_element`, `screenshot`, and even
  `run_js` all read the **rendered DOM**, which is exactly where redaction happens — so you'll see
  `[Name]` where the real value was. This is intentional: the human is hiding it from you (and from
  anyone watching their screen). Treat the label as a value you're not meant to have.
- **Don't try to defeat it.** Do not probe for the hidden value — no scraping attributes, input
  `.value`, network bodies, or storage to reconstruct it. If you genuinely need it to finish the
  task, **ask the human**; they can fill the field for you or turn the filter off.
- **It's best-effort, not total.** Redaction covers **visible text nodes only**. It does **not**
  redact form-field values, element attributes, URLs in `read_network` metadata, or text that's
  reformatted/abbreviated/split across elements — so you may still encounter a real value there. If
  you do, treat it as sensitive: use it only for the task at hand and don't echo it back into the
  conversation or anywhere it isn't needed.

---

## 10. Workflow patterns that work

- **Look before you leap.** In Inspect/Act, call `read_page` (and `inspect_element`) to find the
  *real* selectors before `click`/`fill`. Don't guess selectors blindly.
- **Diagnose with Inspect.** For "why did this fail?", combine `read_console` + `read_network`
  (look for non-2xx statuses) before proposing a fix.
- **Fill then submit, deliberately.** `fill` never submits. After filling, request the submit as
  its own `click` so the human approves the consequential step explicitly.
- **Re-read after navigation.** If a `click` navigates the page, call `read_page` again — your
  prior DOM knowledge is stale.
- **Screenshots for visual checks**, saved to a file (the base64 is big).
- **Respect denials as signal.** `approval_rejected` means "no" — pick a different approach, don't
  re-ask the same thing. `permission_denied` means "raise the mode," which only the human can do.
- **Minimize `run_js`.** Prefer Read/Inspect/Act tools; they're lower-risk, clearer in the audit
  log, and less likely to be rejected. Use `run_js` only when nothing narrower works, and keep the
  script tight and readable (the human reads it in the card).
- **Working across tabs — discover, target (or switch), re-check, then act.** Every call defaults to
  the active tab but can pass `tab` to reach another one directly:

  1. **`list_tabs`** → see what's open. Each entry has `tab` (the id, e.g. `t2`), `active`, `mode`,
     and a privacy-filtered `title`/`url`. Match by title/url, not by guessing the id.
  2. **`get_mode {"tab":"t2"}`** → check that tab's **own** mode before relying on it — targeting
     grants you nothing, so an untouched tab is often **Off**. If so, ask the human to raise it.
  3. Now pass `{"tab":"t2", ...}` on your normal Read/Inspect/Act calls to reach it — no need to
     move the human's foreground for a one-off read/action. Use **`switch_tab {"tab":"t2"}`** instead
     when you expect to make several calls there, or want the human's screen to follow along (an
     approval card for a background-tab call is labeled `Tab: <title>`, but switching is more visible).
     `switched:false` with a `reason` means the human disabled tab control (`list_tabs` then shows
     only the active tab) or the id was wrong.

  Example — "summarize the Gmail tab" (one-off, no need to switch focus):
  ```bash
  safecobrowser invoke list_tabs                              # find which id is Gmail → say t3
  safecobrowser invoke get_mode --tab t3                       # → {"tab":"t3","mode":"blocked"}  (ask human to grant Read)
  safecobrowser invoke read_page --tab t3                       # once at Read, this reads the Gmail tab — t1 stays foreground
  ```
  You **cannot open or close** tabs, and targeting a tab never raises its mode — an off-ladder read
  like `get_mode`/`list_tabs` works regardless, but page tools still need that tab's own grant.

---

## 11. What you must NOT do / cannot do

- ❌ Change the permission mode, or look for a backdoor to. (Only the human's UI can.)
- ❌ Access cookies/passwords/the profile directory, or other sites' sessions.
- ❌ See blind-period content (anything before Read was granted on this tab).
- ❌ Act on a tab the human hasn't granted — passing `tab` only picks *which* tab; it never raises
  that tab's mode. A background tab left at **Off** (the default) is exactly as closed to you as the
  active tab would be at Off. And if the human disabled "Allow agent tab control," `tab` can't target
  anything but the active tab at all.
- ❌ Open or close tabs — only the human can. (`switch_tab`/`tab` only move focus/targeting among
  existing tabs.)
- ❌ Assume a grant lasts. It can be revoked between two of your calls.
- ❌ Treat `fill` as submit, or chain a hidden submit into another action — submitting is its own
  approved `click`.
- ❌ Try to recover values hidden by the human's privacy filter (§9).

---

## 12. The audit log

- Every brokered decision (allowed **and** denied) is appended to
  `~/.safecobrowser/audit-log.jsonl`, hash-chained for tamper-evidence, surviving restart.
- `click`/`inspect_element` log their **selector**; `run_js` logs the **full script**; `fill`
  logs the **selector but never the value**; `switch_tab` logs the **target tab id** (`→ t2`).
- The human can review it live in the in-app **Activity** panel, or via `safecobrowser audit` /
  `safecobrowser audit verify`.
- Implication for you: be transparent and minimal. Anything you do is attributable.

---

## 13. Cheat sheet

```bash
# Is SafeCoBrowser up? which tab is active?
safecobrowser status

# What can I call right now?
safecobrowser tools

# Tabs (any mode; gated by the human's "Allow agent tab control" setting)
safecobrowser invoke list_tabs                  # every open tab: id, active, mode, title, url
safecobrowser invoke switch_tab '{"tab":"t2"}'  # bring t2 to the front; later calls target it
                                                # then: get_mode → (ask human to raise mode) → read/act

# Read tier
safecobrowser invoke read_page
safecobrowser invoke screenshot

# Inspect tier
safecobrowser invoke inspect_element '{"selector":"form button[type=\"submit\"]"}'
safecobrowser invoke read_console '{"limit":50}'
safecobrowser invoke read_network '{"limit":50}'

# Act tier (each prompts the human unless auto-approve is on)
safecobrowser invoke click '{"selector":"a[href*=\"/contact\"]"}'
safecobrowser invoke fill  '{"selector":"#email","value":"hi@example.com"}'

# Develop tier (always shows the script to the human)
safecobrowser invoke run_js '{"script":"document.title"}'

# Audit
safecobrowser audit 20
safecobrowser audit verify
```

**Result shape:** `{ ok: true, output: … }` or `{ ok: false, reason, message? }`.
**If denied:** consult §6, say what you need, and let the human decide. You are a guest with a
key the host can revoke at any moment — work that way.
