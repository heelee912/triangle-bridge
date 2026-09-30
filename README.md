# Claude Codex Bridge

Local bidirectional bridge experiments between the Claude Desktop app and the Codex desktop app.

This repository contains two independent directions:

- `scripts/codex_bridge.mjs`: Claude-to-Codex. Calls the running Codex app's native thread tools through a standalone local named-pipe client.
- `scripts/claude_code_bridge.mjs`: Codex-to-Claude. Uses renderer/raw LocalSessions APIs, the session-specific peer inbox, or a verified live stdin pipe.

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
node .\scripts\claude_code_bridge.mjs code peer-probe --session-id <cli-or-desktop-session-id> --json
node .\scripts\claude_code_bridge.mjs code send --session-id <cli-or-desktop-session-id> --transport peer --sender-mode <actual-sender-mode> --sender-session-id <sender-session-id> --prompt-file .\prompt.txt --wait --json
node .\scripts\claude_code_bridge.mjs code send --session-id <desktop-session-id> --transport live-stdin --prompt-file .\prompt.txt --wait
```

Automatic Code send transport order:

```text
renderer -> raw -> peer -> live-stdin
```

`live-stdin` requires a matching already-running Claude Desktop `claude-code --resume <cliSessionId>` child process. The Claude app does not need to have that window focused, but the child process must be alive.

Every send requires an explicit session ID. Both the Desktop `local_...` ID and its exact CLI session ID are accepted. Unknown or ambiguous IDs fail before sending; focus and recency never choose a recipient. A CLI resume fallback requires explicit user approval and `--allow-cli-fallback` or `--transport cli`.

The peer path resolves Claude's `.claude/sessions/<pid>.json` runtime record. It checks the session, checkout, protocol and process start time, then verifies the connected named-pipe server PID. This identifies newly started Desktop children that have no `--resume` argument. The local inbox key is read only for the intended pipe connection; OAuth credentials and Claude model or permission settings are not changed.

Claude can hold a peer message when the sender permission mode is unknown or differs from the receiver. Declare the required `--sender-mode bypass|prompting --sender-session-id <actual-sender-session-id>` using the sender's actual permissions. The bridge uses Claude's canonical permission-parity envelope. It never assumes bypass permissions or changes the recipient's approval policy.

`written-unconfirmed` proves only a pipe write. `--wait` requires the matching request UUID in the intended transcript and a descendant assistant reply. A timeout is `unknown` or `transcript-confirmed-awaiting-reply`; never resend an uncertain request. An assistant text entry can precede tool completion, so inspect the final reply or the return message before claiming the requested work finished.
The local outbox at `~/.claude-codex-bridge/peer-outbox` records request IDs and states before writing. It refuses duplicate unconfirmed prompts to the same recipient across separate bridge invocations. It stores neither prompt bodies nor inbox keys. The shared home path avoids per-app Windows Store `LOCALAPPDATA` virtualization. Previous records are retained and consulted when needed.
Receipt polling reads only transcript bytes appended since the send began, and stops at a later human or peer turn. To confirm a delayed receipt or a send without `--wait`, run `code peer-receipt --session-id ID --message-id UUID --json`. This reads the exact target transcript, updates a matching outbox record and never resends the request. Windows locking uses an exclusive named-pipe reservation that the OS releases on process exit, not persistent lock files.

`raw probe` is observation-only unless `--bootstrap` is explicit. `--attach-only` prevents bootstrap from launching another app instance; restart requires `--restart-claude --yes`.

## Global Codex Skill

Install or update the self-contained global skill:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install_codex_skill.ps1
```

This installs `$claude-code-bridge` under `$CODEX_HOME/skills`, or `~/.codex/skills` by default. Future Codex sessions can invoke the skill directly without a repository link. It includes both communication directions. The installer updates only its listed bridge resources and preserves other files already in the skill folder.

For long or non-ASCII prompts, prefer `--prompt-file`. Windows command-line argument length is limited, and Windows PowerShell text stdin can reinterpret UTF-8 through the active codepage. The bridge avoids both issues internally for `live-stdin` by passing a Base64-encoded UTF-8 stream-json frame to the PowerShell helper over stdin instead of a `-JsonLine` argument.

## Security Notes

No API keys or account tokens are embedded in this repository.

The CLI resume fallback can read Claude Desktop's local OAuth cache and sync Claude Code credentials on the local machine. That behavior is runtime-only and writes only to the user's local `~/.claude/.credentials.json`; it does not place credentials in this repository.
It is not used automatically and requires explicit user approval.

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
  claude_peer_transport.mjs Exact session routing, peer frames and transcript receipts
  claude_peer_pipe.ps1      Windows pipe owner and process-start verification
  claude_peer_transport.test.mjs Routing, permission envelope and receipt regressions
skills/
  claude-code-bridge/
    SKILL.md                Codex skill instructions
```
