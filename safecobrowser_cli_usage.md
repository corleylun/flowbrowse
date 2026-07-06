# SafeCoBrowser CLI — Usage

`safecobrowser` is a thin command-line client for a **running SafeCoBrowser session**. It talks to the
same broker-gated control surface as the MCP endpoint, so anything an AI agent can do over MCP,
you can do (and test) from the shell.

Like every SafeCoBrowser surface, the CLI **cannot change the permission mode** — that stays with the
human in the SafeCoBrowser UI. The CLI can only call tools *within* whatever mode the **target** tab
is in — by default the active tab, or another open tab via `invoke --tab <id>` (see §2, `invoke`).

---

## 1. Running it

Until a `bin` is installed, run it via Node:

```bash
node dist/cli/safecobrowser.js <command> [args]
```

Optional convenience alias:

```bash
alias safecobrowser='node /Volumes/MacData/macOS/JoinTab/dist/cli/safecobrowser.js'
```

(The rest of this doc writes `safecobrowser …` for brevity.)

### Prerequisites
- **SafeCoBrowser must be running** for `status`, `tools`, and `invoke`. On launch it writes
  `~/.safecobrowser/endpoint.json` (`{ "url": "http://127.0.0.1:8676", "token": "<bearer>" }`), which
  the CLI auto-discovers. No flags, no config.
- **`audit`** reads the local log directly and works **even when SafeCoBrowser is not running**.
- The control server binds to `127.0.0.1` only and requires the bearer token (handled for you).
  To drive it from **another machine**, either tunnel the port (`ssh -N -L 8676:127.0.0.1:8676 …`
  or Tailscale — recommended, encrypted), or enable **Settings → Agent connection → "Allow LAN
  connections"** (default off; plaintext, trusted networks only) and point the CLI's endpoint at
  the shown LAN URL.

---

## 2. Commands

### `safecobrowser status`
Show session status: the **active tab id** (the tab your tool calls hit) and its **permission mode**.
```bash
$ safecobrowser status
{ "ok": true, "tab": "t2", "mode": "read" }
```
> `mode` is read-only — the control API reports it but has **no** way to change it (only the user's
> UI can). Agents can read the same value via the `get_mode` tool.

### `safecobrowser tools`
List the tools the broker exposes, with each tool's minimum mode, risk, and whether it needs approval.
```bash
$ safecobrowser tools
{
  "tools": [
    { "name": "get_mode",        "minMode": "blocked", "risk": "low",    "requiresApproval": false },
    { "name": "list_tabs",       "minMode": "blocked", "risk": "low",    "requiresApproval": false },
    { "name": "switch_tab",      "minMode": "blocked", "risk": "low",    "requiresApproval": false },
    { "name": "read_page",       "minMode": "read",    "risk": "low",    "requiresApproval": false },
    { "name": "screenshot",      "minMode": "read",    "risk": "low",    "requiresApproval": false },
    { "name": "locate",          "minMode": "read",    "risk": "low",    "requiresApproval": false },
    { "name": "list_recipes",    "minMode": "read",    "risk": "low",    "requiresApproval": false },
    { "name": "get_recipe",      "minMode": "read",    "risk": "low",    "requiresApproval": false },
    { "name": "inspect_element", "minMode": "inspect", "risk": "low",    "requiresApproval": false },
    { "name": "read_console",    "minMode": "inspect", "risk": "low",    "requiresApproval": false },
    { "name": "read_network",    "minMode": "inspect", "risk": "low",    "requiresApproval": false },
    { "name": "click",           "minMode": "act",     "risk": "medium", "requiresApproval": true  },
    { "name": "fill",            "minMode": "act",     "risk": "medium", "requiresApproval": true  },
    { "name": "scroll_to",       "minMode": "act",     "risk": "low",    "requiresApproval": true  },
    { "name": "move_to",         "minMode": "act",     "risk": "medium", "requiresApproval": true  },
    { "name": "click_at",        "minMode": "act",     "risk": "medium", "requiresApproval": true  },
    { "name": "scroll",          "minMode": "act",     "risk": "medium", "requiresApproval": true  },
    { "name": "press_key",       "minMode": "act",     "risk": "medium", "requiresApproval": true  },
    { "name": "type_text",       "minMode": "act",     "risk": "medium", "requiresApproval": true  },
    { "name": "submit_feedback", "minMode": "blocked", "risk": "medium", "requiresApproval": true  },
    { "name": "run_js",          "minMode": "develop", "risk": "high",   "requiresApproval": true  }
  ]
}
```

### `safecobrowser invoke <tool> [input] [--tab <id>]`
Invoke a tool through the broker. `[input]` is one of: a **JSON literal**, **`-`** to read JSON
from **stdin**, or **`--input-file <path>`** (`-f`) to read it from a file — the last two avoid
shell quoting/arg-length limits for large `run_js` scripts. Omit for no-arg tools.
```bash
$ safecobrowser invoke read_page
{ "ok": true, "output": { "url": "https://example.com/", "title": "Example", "text": "…", "links": [ … ] } }
$ cat script.json | safecobrowser invoke run_js -          # JSON from stdin
$ safecobrowser invoke run_js --input-file script.json     # JSON from a file
```
- On success: prints `{ "ok": true, "output": … }` and exits **0**.
- On denial/failure: prints `{ "ok": false, "reason": "…", "message": "…" }` and exits **2**.
- Approval-gated tools (`click`, `fill`, `submit_feedback`, `run_js`) **block** until the human Approves/Rejects in the
  UI (or auto-approve is on). Reject → `approval_rejected`; ~120s no answer → `approval_required`.
- **`--tab <id>`** (an id from `invoke list_tabs`) targets that tab instead of the active one, e.g.
  `safecobrowser invoke read_page --tab t2`. It's just an extra flag — combine it with any input form:
  `safecobrowser invoke fill '{"selector":"#email","value":"hi@x.com"}' --tab t2`. The target tab's
  **own** mode is the only gate (a `tab` you haven't granted anything is denied exactly like the active
  tab would be); an unknown `tab` id or a non-string value is rejected outright, never silently
  redirected to the active tab. If the human turned off **Allow agent tab control**, `--tab` can only
  equal the active tab. An approval card for a `--tab`-targeted call is labeled with that tab's title
  so the human isn't approving an effect on a tab they aren't looking at. If that tab has the human's
  auto-approve on, the call runs **without a card** (auto-approve is honored on any tab, foreground or
  background — it's the human's deliberate "don't ask for this tab") and is recorded in the audit log.

### `safecobrowser audit [n]`
Show the last **n** audit records (default **20**). Works offline.
```bash
$ safecobrowser audit 5
#41 2026-06-20T10:39:12.004Z ALLOWED <t1> read_page [read]
#42 2026-06-20T10:40:01.882Z ALLOWED <t1> click [act] — a[href*="/contact"]
#43 2026-06-20T10:41:55.310Z ALLOWED <t1> fill [act] — #email (value hidden)
#44 2026-06-20T10:42:08.991Z DENIED  <t1> click [act] approval_rejected
#45 2026-06-20T10:43:20.140Z ALLOWED <t1> click [act] — button[type="submit"] [real input]
```
Format: `#<seq> <ISO time> <OUTCOME> <tabId> <toolName> [<mode>] <reason?> — <detail?>`.
A trailing **`[real input]`** on an allowed `click`/`fill` means the human had the tab's **Real
input** toggle on, so it was delivered as real trusted input (cursor move + click / per-key typing)
rather than synthesized events. `invoke click/fill` results also include `realInput: true|false`.
`fill` shows the **selector** but never the value; `click`/`inspect_element` show the selector;
`run_js` shows the full script.

### `safecobrowser audit verify`
Re-walk the audit log's tamper-evident hash chain.
```bash
$ safecobrowser audit verify
audit OK — 45 record(s) verified            # exit 0
# or, if tampered:
audit TAMPERED — chain broken at record #12 (11 ok before it)   # exit 2
```

### `safecobrowser help`
Print usage. (`help`, `--help`, `-h`, or no command.)

---

## 3. Tool invocation reference

Each call requires its **target tab** to be at least the listed mode (set by the human in the UI) —
the active tab by default, or another open tab via `--tab <id>` (§2).

| Tool | Needs mode | Example |
|------|-----------|---------|
| `get_mode` | any | `safecobrowser invoke get_mode` |
| `list_tabs` | any | `safecobrowser invoke list_tabs` |
| `switch_tab` | any | `safecobrowser invoke switch_tab '{"tab":"t2"}'` |
| `read_page` | Read | `safecobrowser invoke read_page` |
| `screenshot` | Read | `safecobrowser invoke screenshot` |
| `list_recipes` | Read | `safecobrowser invoke list_recipes` |
| `get_recipe` | Read | `safecobrowser invoke get_recipe '{"name":"Search AskMingLi"}'` |
| `inspect_element` | Inspect | `safecobrowser invoke inspect_element '{"selector":"form button"}'` |
| `read_console` | Inspect | `safecobrowser invoke read_console '{"limit":50}'` |
| `read_network` | Inspect | `safecobrowser invoke read_network '{"limit":50}'` |
| `click` | Act | `safecobrowser invoke click '{"selector":"a[href*=\"/contact\"]"}'` |
| `fill` | Act | `safecobrowser invoke fill '{"selector":"#email","value":"hi@example.com"}'` |
| `submit_feedback` | any (approval) | `safecobrowser invoke submit_feedback '{"message":"great tool"}'` |
| `run_js` | Develop | `safecobrowser invoke run_js '{"script":"document.title"}'` |

### Inputs & outputs
- **`list_tabs`** → `{ tabs:[{ tab, active, mode, title, url }] }` — every open tab (titles/URLs privacy-filtered). If the user has disabled agent tab control, only the active tab is returned.
- **`switch_tab`** `{ tab }` → `{ switched, tab?, reason? }` — brings tab `tab` to the foreground so later calls target it. `switched:false` (+`reason`) if tab control is disabled or the id is unknown. Switching never changes a tab's mode.
- **`read_page`** → `{ url, title, text, links:[{href,text}] }`
- **`screenshot`** → `{ mimeType:"image/png", base64 }` (large — pipe to a file, see §5)
- **`inspect_element`** `{ selector }` → `{ matched, tagName?, attributes?, text?, outerHTML?, rect? }`
- **`read_console`** `{ limit? }` (default 100, max 1000) → `[{ level, text, ts }]`
- **`read_network`** `{ limit? }` (default 100, max 1000) → `[{ method, url, status?, ts }]`
- **`click`** `{ selector }` → `{ clicked, matched }`
- **`fill`** `{ selector, value }` → `{ filled, matched }` (value never logged; fill ≠ submit)
- **`run_js`** `{ script }` (≤100,000 chars) → the script's return value

> **Quoting tip:** wrap the JSON in single quotes and escape inner double quotes:
> `'{"selector":"input[name=\"email\"]"}'`.

---

## 4. Result shape & exit codes

Every `invoke` prints one JSON object:
```ts
{ ok: true,  output: <tool output> }            // success
{ ok: false, reason: <code>, message?: string } // denial / failure
```

| Command | Exit 0 | Exit 2 | Exit 1 |
|---------|--------|--------|--------|
| `invoke` | `ok: true` | `ok: false` (any deny reason) | bad usage / not running |
| `audit verify` | chain OK | chain tampered | — |
| `status`/`tools` | success | — | not running / error |

### Deny `reason` values
`permission_denied` (mode too low / AI off, or `--tab` targets a non-active tab while tab control is
disabled) · `invalid_input` (bad JSON shape, or `--tab` is unknown/not a string) ·
`approval_required` (no approval, incl. timeout) · `approval_rejected` (human said no) ·
`revoked` (Stop AI / mode change mid-call) · `timeout` (handler too slow) ·
`handler_error` (tool threw) · `unknown_tool`.

---

## 5. Recipes

```bash
# Save a screenshot to a PNG
safecobrowser invoke screenshot \
  | node -e 'const r=JSON.parse(require("fs").readFileSync(0));require("fs").writeFileSync("/tmp/shot.png",Buffer.from(r.output.base64,"base64"))'

# Pretty-print just the page text
safecobrowser invoke read_page | node -pe 'JSON.parse(require("fs").readFileSync(0)).output.text'

# Find failed requests (non-2xx) for debugging
safecobrowser invoke read_network '{"limit":100}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).output.filter(e=>e.status&&e.status>=400)'

# Fill a form, then submit as a separate (approved) step
safecobrowser invoke fill '{"selector":"#email","value":"hi@example.com"}'
safecobrowser invoke click '{"selector":"button[type=\"submit\"]"}'

# Work on another tab WITHOUT moving the human's foreground: find it, confirm its mode, target it
safecobrowser invoke list_tabs                     # find the id by title/url → say t2
safecobrowser invoke get_mode --tab t2             # t2 has its OWN mode (targeting grants nothing)
safecobrowser invoke read_page --tab t2            # once t2 is at Read, this reads t2 — t1 stays active

# ...or, if you'll be making several calls there, bring it to the foreground instead:
safecobrowser invoke switch_tab '{"tab":"t2"}'     # → {"switched":true,"tab":"t2"}
safecobrowser invoke read_page                     # now t2 is the default target too
```
> If `switch_tab` returns `{"switched":false,"reason":"tab switching is disabled in Settings"}`, the
> user turned off **Allow agent tab control** — `list_tabs` then shows only the active tab and the
> human drives focus.

---

## 6. Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `SafeCoBrowser is not running (no ~/.safecobrowser/endpoint.json)` | Launch SafeCoBrowser first. |
| `invoke` returns `permission_denied` | The active tab's mode is below the tool's minimum. Ask the human to raise the mode (Read/Inspect/Assist/Developer) in the toolbar. The CLI cannot raise it. |
| `invoke` **hangs** on `click`/`fill`/`run_js` | It's waiting for the human's approval card. Approve/Reject in the UI, or turn on the tab's auto-approve. |
| `approval_required` after a pause | The card timed out (~120s) with no answer. |
| `revoked` | The human hit **Stop AI**, changed the mode, or closed the tab mid-call. Re-confirm before continuing. |
| `invalid_input` | The JSON shape is wrong for that tool (see §3). |
| `audit` prints `(no audit log yet)` | Nothing has been logged on this machine yet. |
| Calls hit the wrong window | Only one SafeCoBrowser should run; the CLI targets whichever instance wrote `endpoint.json`. Quit stray instances. |

---

## 7. Relationship to MCP

The CLI and the MCP endpoint (`POST {url}/mcp`) are **two front-ends over one broker**. Same tools,
same permission checks, same audit log, same inability to change the mode. Use the CLI for
scripting/manual testing; wire MCP for Claude Code / Codex. For the agent-facing version of all
this, see **`safecobrowser_ai_agent_guide.md`**.
