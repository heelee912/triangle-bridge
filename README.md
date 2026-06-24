# Claude Codex Bridge

Local bidirectional bridge experiments between the Claude Desktop app and the Codex desktop app.

This repository contains two independent directions:

- `scripts/codex_bridge.mjs`: Claude-to-Codex. Connects to the live Codex desktop IPC router and sends a user turn to the owner window for an open Codex thread.
- `scripts/claude_code_bridge.mjs`: Codex-to-Claude. Sends to Claude Desktop Code sessions through renderer/raw LocalSessions paths when available, or through a live stdin transport for an already-running Claude Code child process.

It does not patch Claude Desktop, Codex, `app.asar`, WindowsApps copies, browser state, or UI controls.

## Claude to Codex

Codex desktop exposes a live IPC router:

```text
\\.\pipe\codex-ipc
```

The bridge speaks Codex's length-prefixed JSON protocol:

```text
[uint32 little-endian byteLength][utf8 JSON]
```

The send path uses:

```text
thread-follower-start-turn
```

with the confirmed schema:

```json
{
  "conversationId": "<codex-thread-id>",
  "turnStartParams": {
    "input": [
      {
        "type": "text",
        "text": "message",
        "text_elements": []
      }
    ],
    "clientUserMessageId": "<uuid>",
    "serviceTier": null
  }
}
```

Example:

```powershell
node .\scripts\codex_bridge.mjs status
node .\scripts\codex_bridge.mjs send --conversation-id <thread-id> --prompt "reply exactly bridge ok"
```

If `--conversation-id` is omitted, the script attempts to use the newest thread ID from the local Codex session index.

## Codex to Claude

The preferred Claude Desktop API surfaces are:

- Code: `window["claude.web"].LocalSessions`
- Cowork: `window["claude.web"].LocalAgentModeSessions`
- Raw eIPC: Electron main process handler registry entries ending in `LocalSessions_$_...` or `LocalAgentModeSessions_$_...`

When renderer/raw bridges are unavailable but Claude Desktop already has a running Code child process, the `live-stdin` transport writes a Claude Code stream-json user frame into the app-owned stdin pipe for that child process:

```json
{"type":"user","message":{"role":"user","content":"message"}}
```

Example:

```powershell
node .\scripts\claude_code_bridge.mjs status --cwd "C:\path\to\project" --json
node .\scripts\claude_code_bridge.mjs code send --cwd "C:\path\to\project" --transport live-stdin --prompt "reply exactly ok" --wait
node .\scripts\claude_code_bridge.mjs code send --cwd "C:\path\to\project" --transport live-stdin --prompt-file .\prompt.txt --wait
```

Automatic Code send transport order:

```text
renderer -> raw -> live-stdin -> cli
```

`live-stdin` requires a matching already-running Claude Desktop `claude-code --resume <cliSessionId>` child process. The Claude app does not need to have that window focused, but the child process must be alive.

For long prompts, prefer `--prompt-file`. Windows command-line argument length is limited; the bridge avoids that limit internally for `live-stdin` by passing the stream-json frame to the PowerShell helper over stdin instead of a `-JsonLine` argument.

## Security Notes

No API keys or account tokens are embedded in this repository.

The CLI resume fallback can read Claude Desktop's local OAuth cache and sync Claude Code credentials on the local machine. That behavior is runtime-only and writes only to the user's local `~/.claude/.credentials.json`; it does not place credentials in this repository.

Before publishing changes, run:

```powershell
npm run check
git diff --cached | Select-String -Pattern "password|secret|api[_-]?key|token|authorization|Bearer"
```

## Repository Layout

```text
scripts/
  codex_bridge.mjs          Claude -> Codex IPC bridge
  claude_code_bridge.mjs    Codex -> Claude Desktop Code/Cowork bridge
  claude_live_stdin.ps1     Windows helper for app-owned Claude Code stdin pipes
skills/
  claude-code-bridge/
    SKILL.md                Codex skill instructions
```
