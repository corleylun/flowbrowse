# SafeCoBrowser — Start Here

**SafeCoBrowser** is a macOS browser that lets your **own** AI agent — Claude Code, Codex, or
any MCP client — act on your logged-in sessions, under **per-tab, revocable, audited**
permission. The AI is **off by default**; you stay in control the whole time.

---

## 1. Install

1. Drag **SafeCoBrowser.app** to `/Applications`.
2. **Double-click to open** — it's signed & notarized by Apple, so no Gatekeeper warning.
3. Requires **macOS 12 (Monterey) or later**.

## 2. Browse, then invite the AI — per tab

- Use it like a normal browser. Log into your sites; sessions persist (like Chrome).
- The AI sees **nothing** until you pick a mode from the toolbar, **for that tab**:

  | Mode | The agent can… |
  |------|----------------|
  | **Off** (default) | nothing — normal browser |
  | **Read** | read the page + screenshot |
  | **Inspect** | + inspect elements, console, network |
  | **Assist** | + click & fill (each behind your approval) |
  | **Developer** | + run JavaScript (always approved) |

- **Stop AI** revokes instantly. Granting Read never exposes what happened while the AI
  was blind (e.g. your login).

## 3. Connect your AI agent over MCP

On launch, SafeCoBrowser starts a localhost server and writes its endpoint + token to
`~/.safecobrowser/endpoint.json`. Point your agent at it — for Claude Code:

```bash
TOKEN=$(node -pe "JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.safecobrowser/endpoint.json')).token")
claude mcp add --transport http safecobrowser http://127.0.0.1:8676/mcp \
  --header "Authorization: Bearer $TOKEN"
```

Your agent can now call SafeCoBrowser's tools — but **only within the mode you granted**, and
`click` / `fill` / `run_js` require your **approval** (or your per-tab auto-approve toggle).
The agent can **never** change the mode itself, and never gets your cookies, passwords, or
profile — only the brokered tools.

## 4. Everything is logged

Every action (allowed or denied) is written to a tamper-evident audit log at
`~/.safecobrowser/audit-log.jsonl`, viewable live in the in-app **Activity** panel.

---

## Learn more (included in this download)

- **`docs/safecobrowser_ai_agent_guide.md`** — the full guide for driving SafeCoBrowser as an AI
  agent: the tools, schemas, permission model, approval flow, and workflow patterns.
- **`docs/safecobrowser_cli_usage.md`** — the CLI reference (`safecobrowser status / tools /
  invoke / audit`).

Source & issues: https://github.com/corleylun/flowbrowse
