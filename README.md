# Claude Codex Bridge

Local bidirectional bridge experiments between the Claude Desktop app and the Codex desktop app.

This repository contains two independent directions:

- `scripts/codex_bridge.mjs`: Claude-to-Codex. Calls the running Codex app's native thread tools through a standalone local named-pipe client.
- `scripts/claude_code_bridge.mjs`: Codex-to-Claude. Sends to Claude Desktop Code sessions through renderer/raw LocalSessions paths when available, or through a live stdin transport for an already-running Claude Code child process.

It does not patch Claude Desktop, Codex, `app.asar`, WindowsApps copies, browser state, or UI controls.

## Claude to Codex

The default transport discovers the running Codex app's native tool pipe:

```text
\\.\pipe\codex-browser-use-<instance-id>
```

It uses length-prefixed JSON-RPC:

```text
[uint32 little-endian byteLength][utf8 JSON]
```

The send path is:

```text
tools/list -> read_thread (exact target check) -> send_message_to_thread
```

The target does **not** have to be the visible or focused thread. The app's native send function resumes the specified thread by ID and coordinates active-turn steering or a new turn. Viewing another thread does not change the target. Codex desktop must remain running and its native tool endpoint must be responsive.

This implementation has no OmniCodex imports, MCP connection, shared queue, server or configuration dependency. It does not start a separate Codex app-server or alter the target's model settings. Windows pipe discovery is currently supported.

Example:

```powershell
node .\scripts\codex_bridge.mjs status --thread <thread-id>
node .\scripts\codex_bridge.mjs send --thread <thread-id> --prompt-file .\message.txt
node .\scripts\codex_bridge.mjs read --thread <thread-id> --turn-limit 2
node .\scripts\codex_bridge.mjs --help
```

Use a UTF-8 file for Korean or multiline messages. `--conversation-id` remains an alias for `--thread`. Send and read require an explicit ID or an unambiguous `--name`; they do not guess the newest conversation.

`delivery: "app-acknowledged"` means the native send returned the intended thread ID. It does not mean the recipient has completed a reply. A lost acknowledgement is reported as `delivery: "unknown"` and is never automatically resent. Read the target before retrying.

The old `codex-ipc` owner-window protocol is retained only for explicit `--transport ipc` and `raw` diagnostics. It is not the default send path and is not an automatic fallback.

Version 0.2.0 was verified with an actual Claude-originated message received by Codex 26.924.2738.0 while the target turn was active. Foreground independence was checked against the installed app's ID-based resume/send implementation; a separate UI-switch experiment was not performed.

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

For long or non-ASCII prompts, prefer `--prompt-file`. Windows command-line argument length is limited, and Windows PowerShell text stdin can reinterpret UTF-8 through the active codepage. The bridge avoids both issues internally for `live-stdin` by passing a Base64-encoded UTF-8 stream-json frame to the PowerShell helper over stdin instead of a `-JsonLine` argument.

## Security Notes

No API keys or account tokens are embedded in this repository.

The CLI resume fallback can read Claude Desktop's local OAuth cache and sync Claude Code credentials on the local machine. That behavior is runtime-only and writes only to the user's local `~/.claude/.credentials.json`; it does not place credentials in this repository.

Before publishing changes, run:

```powershell
npm run check
npm test
git diff --cached | Select-String -Pattern "password|secret|api[_-]?key|token|authorization|Bearer"
```

## Repository Layout

```text
scripts/
  codex_bridge.mjs          Claude -> Codex CLI
  codex_app_pipe.mjs        Standalone native app-tool pipe transport
  codex_app_pipe.test.mjs   Framing, Unicode, routing and failure regressions
  claude_code_bridge.mjs    Codex -> Claude Desktop Code/Cowork bridge
  claude_live_stdin.ps1     Windows helper for app-owned Claude Code stdin pipes
skills/
  claude-code-bridge/
    SKILL.md                Codex skill instructions
```
