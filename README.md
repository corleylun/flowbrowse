# SafeCoBrowser

**SafeCoBrowser is an open-source AI co-browsing browser for macOS** that lets you bring Claude Code, Codex, or any MCP agent into your logged-in browser — only when you allow it, per tab, with an instant kill switch and a full audit log.

It is the browser where AI joins only when invited: the *permission + audit layer* for letting an AI agent act on your accounts — off by default, granted in the moment, killable instantly, and logged. Your everyday browser stays untouched, and the agent never receives your cookies, saved passwords, or profile.

**Links:** [Website](https://flowstations.net/safecobrowser) · [What is SafeCoBrowser?](https://flowstations.net/safecobrowser/what-is) · [Docs](https://flowstations.net/safecobrowser/docs) · [Claude Code quickstart](https://flowstations.net/safecobrowser/claude-code-quickstart) · [Codex quickstart](https://flowstations.net/safecobrowser/codex-quickstart) · [Download (macOS)](https://flowstations.net/downloads/SafeCoBrowser-2026-06-30.zip)

> Status: **v1 MVP — engineering-complete and security-reviewed, not yet market-validated.** macOS-first.
>
> Part of the **[FlowStations](https://flowstations.net)** local-first developer-tools family (alongside **FlowProxy** & **FlowTest**).

*Keywords: AI co-browsing browser, AI browser, MCP browser, Claude Code browser, Codex browser, logged-in browser automation, agentic browser, user-controlled AI browsing, open-source AI browser for macOS.*

---

## Why it's different

- **Isolated, not an extension.** SafeCoBrowser is a *separate* browser with its own persistent profile. Only what you deliberately do *in SafeCoBrowser* is ever in scope — your everyday browser stays untouched.
- **Off by default, per tab.** The AI sees nothing until you grant a mode for a tab, and **Stop AI** revokes instantly. A grant persists across navigation until you change the mode or hit Stop AI — so stop the AI when you're done before browsing to something private.
- **Bring your own agent.** SafeCoBrowser exposes its capabilities over a local **MCP server + CLI** — point your own Claude Code / Codex at it. SafeCoBrowser is the controlled "body"; your agent is the "brain."
- **The agent can never escalate itself.** Only *you*, in the UI, can change the permission mode. The agent surface can read/act only within the mode you grant.
- **Record → mask → replay.** Capture your own flows as reusable recipes — with sensitive fields (passwords, cards, OTPs, keys) masked *in-page* before they ever leave the renderer.
- **Multi-tab, a container per tab.** Each tab can run in its own isolated **container** (separate cookies/logins) — a clean room per client or project — and carries its own permission mode. Open tabs and their pages are **restored on relaunch**.
- **Watch it live, or let it run.** An in-app **Activity** panel streams every AI action per tab; optional per-tab **auto-approve** lets trusted `click`/`fill` (or `run_js`) through without a card — still fully logged.
- **Everything is logged.** Every brokered decision is written to a durable, hash-chained audit log you can view and verify.

---

## Quick start

```bash
npm install
npm start          # builds, then launches SafeCoBrowser
```

You'll get a browser window. The AI is **Off** by default — pick a mode from the toolbar dropdown to grant access to the current tab.

On launch, SafeCoBrowser starts a localhost control server and writes its endpoint + token to `~/.safecobrowser/endpoint.json`.

### Connect your own Claude Code / Codex (MCP)

```bash
TOKEN=$(node -pe "JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.safecobrowser/endpoint.json')).token")
claude mcp add --transport http safecobrowser http://127.0.0.1:8676/mcp \
  --header "Authorization: Bearer $TOKEN"
```

Now your agent can call SafeCoBrowser's tools — but every call is gated by the mode you've granted in the UI, and effectful/`run_js` calls require your approval in an action card.

### The bundled CLI

```bash
node dist/cli/safecobrowser.js status                          # session status
node dist/cli/safecobrowser.js tools                            # list available tools
node dist/cli/safecobrowser.js invoke read_page                # call a tool (gated by mode)
node dist/cli/safecobrowser.js audit 20                         # view the last 20 audit records
node dist/cli/safecobrowser.js audit verify                     # verify the audit hash chain
```

The CLI auto-discovers the running app; `audit` works even when SafeCoBrowser isn't running.

---

## Permission modes

Set per tab, by you, in the toolbar. Each tier unlocks more tools:

| Mode | Color | Tools unlocked | Approval |
|------|-------|----------------|----------|
| **Off** (Blocked) | grey | — (AI sees nothing) | — |
| **Read** | blue | `read_page`, `screenshot`, `locate` | no |
| **Inspect** | teal | + `inspect_element`, `read_console`, `read_network` | no |
| **Assist** (Act) | amber | + `click`, `fill`, `scroll_to` | **yes** (per action) |
| **Developer** | red | + `run_js` (full page control) | **yes** (script shown) |

**Stop AI** instantly revokes the grant (and cancels any in-flight call). Approval-required actions show an action card with the concrete effect (e.g. the exact `run_js` script).

Four tools are **off the ladder** (they aren't page operations, so they work at any mode — including Off): **`get_mode`** lets the agent read the active tab's current mode (read-only — it still can't *change* it) instead of guessing from denials; **`list_tabs`** / **`switch_tab`** let the agent see the open tabs and bring one to the foreground (gated by a Settings toggle, default on — switching never changes a tab's mode, so an Off tab still exposes nothing); and **`submit_feedback`** sends your/your agent's feedback (approval-gated, never page content). And **`fill` is honest** — it reads the field back and reports `filled: false` (with a hint) if the value didn't actually land, with a paste-style insert so modern rich-text editors (Lexical / Draft / ProseMirror) work.

**Background-tab targeting.** Any tool call may carry an optional `tab` (an id from `list_tabs`, or CLI `invoke --tab <id>`) to act on a tab **other than the foreground one** — without switching your view. The target tab's **own** AI grant is the only gate: a tab left **Off** (default) stays invisible; one you granted is usable at that grant. Unknown/mistyped ids are rejected outright (never a silent fall-back to the active tab), and — when *Agent tab control* is off — non-active targets are denied without revealing whether the id exists. If a background-tab action isn't auto-approved, its approval card is labeled `Tab: <title>` so you know which tab you're approving. Auto-approve, if you set it on that tab, is honored anywhere (it's your deliberate "don't ask") and the action is still logged with its tab id.

**Real input (per-tab toggle).** Some sites reject JavaScript-synthesized events (they check `event.isTrusted`). Flip the toolbar's **Real input** toggle on a tab and its `click`/`fill` are driven by **real, trusted** input through Chromium's input pipeline — the cursor moves to the element and clicks, and text is typed key by key — instead of synthesized events. It's a *you*-only switch (the agent can't read or set it, and it never changes the permission mode), it only affects event *trust* not what the agent can do, and the audit log labels those actions `[real input]`. It is **not** a stealth/bot-evasion layer — there's no humanized motion or randomized timing, just real input that genuinely lands. Off by default; resets when you Stop AI or switch the tab's container.

**Computer-use coordinate tools.** For canvas/WebGL apps and pages with no usable DOM, the agent can act by **coordinates it reads off a screenshot** — `move_to`, `click_at`, `scroll`, `press_key`, `type_text` — delivering real trusted input at a viewport point (the "computer use" paradigm). These are Act-tier and approval-gated, and because a bare `(x, y)` is poor consent, **the approval card shows a screenshot with a crosshair on the exact target** so you approve *what* gets clicked. The screenshot is shown live in the card only — never written to the audit log. `press_key` is allowlisted (navigation/editing keys, no modifier chords); `type_text` logs a character count, never the text.

**`locate` + `scroll_to` (fast DOM targeting).** The coordinate tools above are slow on a real DOM because the agent has to *visually* find the target in a screenshot. **`locate`** (Read-tier, no approval) resolves elements to coordinates straight from the page's layout by text or CSS selector (~20 ms vs a screenshot + vision pass), returning each match's centre + `inViewport`/`obscured` flags — so `locate` → `click_at` is deterministic and near-instant. **`scroll_to`** (Act-tier, approval — the card shows the query, e.g. *scroll to "Add to Bag"*) brings an off-viewport match into view and returns its settled coordinates. Together they make the loop `locate` (find) → `scroll_to` (reveal) → `click_at` (act), and keep the raw coordinate/screenshot path for canvas / no-DOM pages only.

**Remote control (opt-in LAN).** By default the control/MCP server binds to `127.0.0.1` only. **Settings → Agent connection → "Allow LAN connections"** (default off) rebinds it to all interfaces and allowlists the machine's LAN IPs, so an agent on **another computer** can drive this browser over the same broker-gated MCP + CLI surface. The Host allowlist stays the DNS-rebinding guard (even bound wide, only loopback + the explicit LAN IPs are accepted), and the bearer token + per-tab AI block are unchanged — LAN adds reachability, not capability. It's **plaintext HTTP**, so the card warns: trusted networks only; for the internet keep it off and use an SSH/Tailscale tunnel instead.

---

## Recipes (record & replay)

> **Note:** the record/replay **UI is currently hidden** in the toolbar (deferred for a later pass). The capture/masking/replay engine is fully intact — re-enable by removing `hidden` on `#recorder-group` in the toolbar.

Recording is a **separate, user-owned switch** from AI access — it captures *your* actions, not the AI's.

1. Click **● Record** and interact with the page (clicks + form entry are captured as semantic actions).
2. **Stop**, name it, **Save** → stored under `~/.safecobrowser/recipes/`.
3. Pick it from **Recipes** and **▶ Replay**.

**Masking:** sensitive fields (password, credit-card, CVV, SSN, OTP/2FA, bank, crypto seed/key, passport, DOB, …) are masked *in the page* at capture time — the value never leaves the renderer, and masked fields are skipped on replay (you fill them manually).

---

## Audit log

Every broker decision (allow / deny / error, with reason) is appended to `~/.safecobrowser/audit-log.jsonl`, hash-chained for tamper-evidence, and survives restart.

`safecobrowser audit verify` re-walks the chain. **Honest guarantee:** it detects accidental corruption and naive in-place edits / deletions / reordering. It does **not** resist a determined local attacker who can rewrite the whole file (no external anchor/signature) and does not detect tail truncation. An external anchor (signed checkpoints / SIEM) is roadmap for the enterprise governance plane.

---

## Settings & feedback

A **⚙ Settings** panel in the toolbar covers:

- **User-Agent** — a global override (presets + custom), applied to every tab/container.
- **Approvals** — how long an approval card waits before it auto-**denies** (fail-closed; default 120s).
- **Agent tab control** — whether the agent may enumerate tabs (`list_tabs`) and switch the foreground (`switch_tab`). Default **on**; turn it off to restore single-active-tab visibility (the agent then sees only the tab you put in front). Switching never changes a tab's mode.
- **Agent connection** — your MCP endpoint + bearer token, one-click copy of the `claude mcp add` command, and **Regenerate token** (rotates the live server's bearer, instantly revoking any connected agent).
- **Send feedback** — a box to tell us what works (including your agent's opinion). There's also an approval-gated **`submit_feedback`** agent tool, so your agent can relay feedback. It's **not on the permission ladder** (feedback isn't a page operation, so it works at any tab mode); the exact text is shown for your approval, and no page content is ever sent.

## Architecture

```
Your CLI agent ──MCP/HTTP──┐
You (CLI)      ──/api──────┤
                           ▼
                   ControlServer  (localhost, bearer-token + Host/Origin gate)
                           │
                           ▼
                   Broker  ← the single chokepoint (fail-closed)
              mode gate · input validation · approval · session epoch · audit
                           │  (tools never get raw webContents)
                           ▼
              Tools → PageController → Electron WebContentsView (the page)
```

- **`src/core/`** — the security core: `Broker` (single chokepoint, fail-closed), `SessionManager` (per-tab mode + epoch), `Tool` contract, approval, audit.
- **`src/tools/`** — read / inspect / act / dev tools (Electron-free, over controller interfaces).
- **`src/server/` + `src/mcp/`** — the MCP server, JSON control API, and auth.
- **`src/recorder/`** — capture, masking, recipes, replay.
- **`src/audit/`** — the durable hash-chained sink.
- **`src/main/`, `src/preload/`, `src/renderer/`** — the Electron app, bridges, and toolbar UI.

See [`SPEC.md`](SPEC.md) (full vision), [`CLAUDE.md`](CLAUDE.md) (direction + security non-negotiables), and [`BUILD_PLAN.md`](BUILD_PLAN.md) (phased plan).

**Using SafeCoBrowser with an agent:** [`safecobrowser_ai_agent_guide.md`](safecobrowser_ai_agent_guide.md) (drive SafeCoBrowser as an AI agent over MCP/CLI) and [`safecobrowser_cli_usage.md`](safecobrowser_cli_usage.md) (the CLI reference).

---

## Security model (non-negotiables)

- The **broker is the single path** to any tool. Fail-closed: unknown tool, insufficient mode, invalid input, missing/rejected approval, mid-flight revocation, or a handler error all **deny**.
- **Only the user sets the mode.** No MCP/CLI/API path can change it.
- **Instant revoke is real** — a session epoch is re-checked at execution time; effectful tools re-check liveness immediately before the irreversible step.
- **Tool handlers never receive raw DOM/cookies/session** — only a brokered controller.
- **Masking happens in-page** — sensitive values never reach the main process.
- **The browser profile is never exposed** to the agent.

---

## Development

```bash
npm run build      # tsc → dist/
npm start          # build + launch
npm test           # (alias) — or run the suites directly:
node --test dist/core/*.test.js dist/server/*.test.js dist/tools/*.test.js \
            dist/main/*.test.js dist/recorder/*.test.js dist/audit/*.test.js
```

Real-Chromium smokes (each self-quits):

```bash
./node_modules/.bin/electron scripts/electron-read-smoke.js       # read path
./node_modules/.bin/electron scripts/electron-dev-smoke.js        # run_js
./node_modules/.bin/electron scripts/electron-capture-smoke.js    # capture + masking
./node_modules/.bin/electron scripts/electron-injection-smoke.js  # action-script injection
```

**Stack:** Electron + TypeScript, Chromium via `WebContentsView`, the official `@modelcontextprotocol/sdk`, `zod`.

### Package as a macOS app

```bash
npm run dist:mac
```

Produces a double-clickable **`release/mac/SafeCoBrowser.app`** (drag it to `/Applications`). The build is **unsigned** (local use), so the first launch needs **right-click → Open** to get past Gatekeeper (or `xattr -dr com.apple.quarantine release/mac/SafeCoBrowser.app`). Distributing to other machines would require Apple Developer code-signing + notarization. The app uses the default Electron icon until a custom `.icns` is added.

---

## Roadmap (not in v1)

- Isolated-world reads (CDP) so a hostile page can't shadow what's read.
- New-window / popup policy (now that multi-tab has landed).
- Developer-ID code-signing + notarization for distributable builds (see *Package as a macOS app*).
- External audit anchor (signing / SIEM) for an enterprise governance plane.
- LLM generalization of recipes (parameterized, not just literal replay).
- Windows support.

---

## License

Licensed under [AGPL-3.0-only](LICENSE). The intent is an open core with a separately-licensed future enterprise governance layer.
