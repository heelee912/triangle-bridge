---
name: claude-code-bridge
description: Send prompts to Claude Desktop Code and Cowork sessions through Claude Desktop LocalSessions APIs, using the renderer wrapper or raw eIPC handler bridge, not browser or UI automation. Use when asked to create/send/wait/read Claude Desktop Code or Cowork sessions from Codex.
---

# Claude Code Bridge

## Scope

Use this skill to control Claude Desktop sessions through Claude Desktop's own session APIs:

- Code: `window["claude.web"].LocalSessions`
- Cowork: `window["claude.web"].LocalAgentModeSessions`
- Raw Code/Cowork: Electron main-process `webContents.ipc._invokeHandlers` entries ending in `LocalSessions_$_...` or `LocalAgentModeSessions_$_...`
- Code live stdin: Claude Desktop's already-running `claude-code --resume <cliSessionId>` child process `stream-json` stdin pipe
- Code fallback: Claude Desktop's installed Claude Code CLI via `claude.exe --resume <cliSessionId>` after syncing Desktop OAuth into `~/.claude/.credentials.json`

Do not use Chrome/Browser automation, agbrowse, mouse/keyboard UI automation, `app.asar` patching, CDP port patching, or WindowsApps copy patching.

Raw eIPC mode is allowed only through a live Claude Desktop main-process inspector. It must discover the full `$eipc_message$...` channel names from the runtime handler registry and then call those registered handlers. Do not hard-code version-specific full channel names from static source.

## Transport Order

Default `start`/`send` use the renderer wrapper path:

1. Existing Claude main-process inspector endpoint, if available.
   - The CLI evaluates in Electron main process.
   - It finds the Claude renderer with `webContents.getAllWebContents()`.
   - It calls `webContents.executeJavaScript()` to run the wrapper call in the renderer.
   - `status` also probes `webContents.ipc._invokeHandlers` for eIPC suffixes such as `LocalSessions_$_getAll`.
2. Existing Claude renderer DevTools endpoint, if explicitly available.
3. Non-destructive bootstrap attempts may try to attach to the existing main process or launch a second instance with inspector flags. Restart is allowed only when explicitly requested with `--restart-claude --yes`.

Raw `start`/`send` use the direct eIPC handler path:

1. Existing Claude main-process inspector endpoint, if available.
2. Runtime registry probe for required handler suffixes.
3. Direct handler invocation with the live `webContents.mainFrame` sender frame.
4. Non-destructive bootstrap attempts. Restart is allowed only when explicitly requested with `--restart-claude --yes`.

Code `send` has an additional fallback:

1. If renderer/raw transports are unavailable, resolve the latest matching Code session metadata.
2. If Claude Desktop already has a running `claude-code --resume <cliSessionId>` child process for that session, `--transport live-stdin` writes a `stream-json` user frame to the app-owned stdin pipe.
3. If no live child exists, decrypt Claude Desktop's Chromium `oauth:tokenCache` using the current Windows user's DPAPI-protected `Local State` key.
4. Copy the Desktop `user:sessions:claude_code` OAuth token into `~/.claude/.credentials.json`, creating a timestamped backup if it changes.
5. Spawn Claude Desktop's installed `claude.exe` with `--resume <cliSessionId>`, `--model claude-opus-4-8`, `--effort xhigh`, `--settings {"ultracode":true}`, and bypass permission mode.

If neither renderer nor raw transport is live, `start` still fails. Code `send` should use the CLI resume fallback unless `--transport renderer`, `--transport raw`, or `--no-auth-sync` is explicitly requested. Cowork has no CLI resume fallback.

## Commands

Run the bundled script:

```powershell
$bridge = "$env:USERPROFILE\.codex\skills\claude-code-bridge\scripts\claude_code_bridge.mjs"
node $bridge status --cwd "C:\Users\USER\Desktop\Projects\SEMI" --json
```

Common commands:

- `status`: show bridge availability, eIPC registry probe, recent Code/Cowork sessions, and running Claude processes.
- `list`: list known local session metadata.
- `code start --prompt "..." --cwd PATH`: create a Code session through `LocalSessions.start`, force Code defaults, then send the prompt.
- `code send --prompt "..." --cwd PATH`: send to the latest matching Code session through `LocalSessions.sendMessage`.
- `cowork start --prompt "..." --cwd PATH`: create a Cowork session through `LocalAgentModeSessions.start`, force Cowork defaults, then send the prompt.
- `cowork send --prompt "..." --session-id local_...`: send to a Cowork session through `LocalAgentModeSessions.sendMessage`.
- `raw probe`: check direct eIPC handler visibility without sending a prompt.
- `raw send --prompt "..." --cwd PATH`: send through direct eIPC handlers.
- `raw start --prompt "..." --cwd PATH`: create and send through direct eIPC handlers.
- `code send --raw-ipc --prompt "..." --cwd PATH`: raw eIPC mode from the normal Code command.
- `code send --transport cli --prompt "..." --cwd PATH`: send through Claude Code CLI resume, syncing Desktop OAuth first.
- `code send --transport live-stdin --prompt "..." --cwd PATH`: send into the already-running Claude Desktop Code child process for the matching session.
- `auth-sync`: sync Claude Desktop OAuth into Claude Code CLI credentials without sending.
- `wait`: wait for a new assistant transcript entry.
- `read`: read recent transcript entries.
- `selftest`: validate payload construction and routing without touching Claude.

Examples:

```powershell
node $bridge code send --cwd "C:\Users\USER\Desktop\Projects\SEMI" --prompt "Summarize the current work state." --wait
node $bridge code send --transport cli --cwd "C:\Users\USER\Desktop\Projects\SEMI" --prompt "Summarize the current work state."
node $bridge auth-sync --json
node $bridge raw probe --cwd "C:\Users\USER\Desktop\Projects\SEMI" --json
node $bridge raw send --cwd "C:\Users\USER\Desktop\Projects\SEMI" --prompt "Summarize the current work state." --wait
node $bridge code read --cwd "C:\Users\USER\Desktop\Projects\SEMI" --lines 12
node $bridge cowork send --session-id local_... --prompt "Check the repository state." --wait
```

## Forced Defaults

Code is fixed to:

- `model`: `claude-opus-4-8`
- `effort`: `xhigh`
- `ultracode`: `true` via `LocalSessions.applyFlagSettings`
- `permissionMode`: `bypassPermissions`

Cowork is fixed to:

- `model`: `claude-opus-4-8[1m]`
- `effort`: `max`
- `permissionMode`: `bypassPermissions`

If any force operation (`setModel`, `setEffort`, `applyFlagSettings`) fails, the send/start command must fail instead of continuing silently.

## Bridge Requirement

Always run `status` before `start` or `send`.

For wrapper mode, if `bridge.available` is `false`, do not send through the wrapper path.

For raw mode, run `raw probe` first. If `rawIpc.available` is `false`, do not send through raw IPC.

For Code live-stdin mode, `bridge.available=false` and `rawIpc.available=false` are acceptable, but a matching running Claude Desktop `claude-code --resume <cliSessionId>` child process must exist. This does not sync or store OAuth tokens.

For Code CLI resume mode, `bridge.available=false` and `rawIpc.available=false` are acceptable. The CLI must verify `claudeCodeCli.executable` and run `auth-sync` automatically unless `--no-auth-sync` is set.

When a main-process inspector is already open, pass it explicitly if needed:

```powershell
node $bridge status --main-inspect-port 9229 --json
node $bridge raw probe --main-inspect-port 9229 --json
```

When a renderer DevTools endpoint is already open, pass it explicitly:

```powershell
node $bridge status --cdp-url "http://127.0.0.1:9222" --json
```

The current Claude Desktop build contains an internal "Enable Main Process Debugger" menu action that calls Node inspector open while the app is already running. If that action has been enabled manually or by an equivalent non-patching route, `raw probe` should observe the handler registry without app restart.

## Transcript Store

Code session metadata is read from:

```text
%APPDATA%\Claude\claude-code-sessions\<accountId>\<orgId>\local_*.json
```

Code transcript JSONL is read from:

```text
%USERPROFILE%\.claude\projects\<encoded-cwd>\<cliSessionId>.jsonl
```

Cowork metadata is read from:

```text
%APPDATA%\Claude\local-agent-mode-sessions\<accountId>\<orgId>\local_*.json
```
