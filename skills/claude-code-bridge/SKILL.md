---
name: claude-code-bridge
description: Exchange messages between Claude Desktop and Codex using the user's local bidirectional bridge. Use for Claude collaboration, supported session creation, session-specific prompts and replies, bridge troubleshooting, or reading an explicitly selected session. No browser or UI relay.
---

# Claude Code Bridge

## Preferred Bidirectional Path

This is the user's `heelee912/claude-codex-bridge` bridge. The installed scripts are self-contained; another session does not need a GitHub link or a checkout to use them.

- Codex to Claude Code: `scripts/claude_code_bridge.mjs` with the exact target ID and `--transport peer`.
- Claude to Codex: `scripts/codex_bridge.mjs` with the exact target thread ID. This is the normal return path. Claude's built-in `SendMessage` need not discover Codex and its failure is not a failure of this bridge.
- Never route through IAB, a focused window or the newest session. Respect the user's authorized targets and task scope.

Locate this skill under `$CODEX_HOME/skills/claude-code-bridge`, or `$HOME/.codex/skills/claude-code-bridge` when `CODEX_HOME` is unset. Use its bundled scripts instead of reinstalling or rebuilding the bridge.

```powershell
$root = "$env:USERPROFILE\.codex\skills\claude-code-bridge"
$claude = "$root\scripts\claude_code_bridge.mjs"
$codex = "$root\scripts\codex_bridge.mjs"
node $claude status --cwd "C:\path\to\project" --json
node $claude code peer-probe --session-id TARGET_CLAUDE_ID --json
node $claude code send --transport peer --session-id TARGET_CLAUDE_ID --sender-mode ACTUAL_SENDER_MODE --sender-session-id $env:CODEX_THREAD_ID --prompt-file "C:\Temp\instruction.md" --wait --json
node $claude code read --session-id TARGET_CLAUDE_ID --lines 10 --json
node $claude code peer-receipt --session-id TARGET_CLAUDE_ID --message-id REQUEST_UUID --json
node $codex status --thread TARGET_CODEX_ID
node $codex send --thread TARGET_CODEX_ID --prompt-file "C:\Temp\reply.md"
```

`ACTUAL_SENDER_MODE` is `bypass` only when the sender truly has full unrestricted access without approval; otherwise use `prompting`. Do not infer it from the recipient's mode. If `CODEX_THREAD_ID` is unavailable, resolve the actual sending thread explicitly rather than guessing.

Peer sends require both sender options. The outbox stores request IDs and states under `%USERPROFILE%\.claude-codex-bridge\peer-outbox`, not prompt text or account credentials. A duplicate unconfirmed prompt to the same recipient is refused even from another bridge process. Use `code peer-receipt --session-id ID --message-id UUID` to reconcile a delayed receipt or a send without `--wait`. It updates the outbox only when the exact request appears in that target's transcript. Confirmed requests can be sent again as an intentional new turn. Windows outbox locking uses an exclusive live named pipe, which the OS releases after a process crash; it does not leave persistent `.lock` files.

Pipe writes and an assistant's initial text are not completion of the assigned work. Confirm the matching target transcript and final response or return message. `codex_bridge.mjs` returning `app-acknowledged` confirms app acceptance; read the destination for actual receipt and completion.

## Starting A New Claude Code Session

Use `code start` when the live `LocalSessions` API is available. If it is unavailable, an explicitly authorized existing Claude session can use its native `mcp__ccd_session__spawn_task` tool:

```json
{"title":"Short session title","tldr":"Purpose of the new session","prompt":"Initial instruction","cwd":"C:\\path\\to\\project"}
```

Ask that exact Claude session through the peer transport to inspect its available tools and call `spawn_task` once. The returned `task_id` identifies a suggestion card, not a running session. The user must start the card. Do not duplicate it or activate a debugger or restart the app as an implicit fallback.

After the user starts it, Claude can use `list_sessions`, `get_session` and `list_events` under `mcp__ccd_session_mgmt__` to return the actual Desktop session ID, working directory and first reply. Git projects may start in a new worktree. A verified non-Git project opened in its original folder. Always verify the actual directory instead of promising either behavior.

Resolve the new CLI session ID from local metadata and the live runtime registry. Run `code peer-probe --session-id ID` and read its first response before handing it to the assigned collaborator. Preserve the created model and permissions unless the user requests changes.

A destination missing from local `codex_bridge status` is not proof that its ID is invalid. Verify its observed host and the local calling context. Do not substitute an unrelated session or start a coordinator turn merely to relay the message.

For an observed cloud host, keep the local app caller context separate from the destination. Pass both explicitly; do not guess the newest local thread. This uses the same app pipe without starting a coordinator model turn:

```powershell
node $codex status --thread EXACT_CLOUD_ID --context-thread EXACT_LOCAL_CALLER_ID --host-id OBSERVED_HOST_ID
node $codex send --thread EXACT_CLOUD_ID --context-thread EXACT_LOCAL_CALLER_ID --host-id OBSERVED_HOST_ID --prompt-file "C:\Temp\reply.md"
```

The bridge verifies the exact destination and host before sending. A local caller context is not the remote recipient or proof of the message author's identity. Acknowledgement and actual destination receipt remain separate.

For a reply-only read, the sender must publish an assistant message with the agreed request-specific tag as its complete first line:

```powershell
node $codex reply --thread EXACT_CLOUD_ID --context-thread EXACT_LOCAL_CALLER_ID --host-id OBSERVED_HOST_ID --reply-tag "[Claude reply REQUEST_UUID]" --after-cursor PREVIOUS_CURSOR
```

Omit `--after-cursor` on the first read. Optional `--message-id` and `--turn-id` pin a known reply. This performs one immediate `wait_threads` snapshot without reading history or sending a prompt. Only a matching assistant message is returned. Other commentary, tool data and unmatched text are not returned. A tag is a selection filter, not authenticated author identity. The API exposes the latest message, not a durable reply queue; an absent or superseded reply is not delivery confirmation. Never fall back to full history or repeat an unknown send to recover it.

## Explicit Permission Changes

Change a running Claude session's permissions only when the user explicitly requests that change. Ordinary message delivery must preserve the recipient's permission mode.

```powershell
node $claude code set-permission-mode --session-id EXACT_CLAUDE_ID --mode acceptEdits --dry-run --json
node $claude code set-permission-mode --session-id EXACT_CLAUDE_ID --mode acceptEdits --json
```

The dry run resolves the exact process and writable stdin pipe without sending a control request. A successful write is not confirmation that Claude accepted the mode; its control response goes to Desktop rather than this bridge. Verify the resulting recipient state before claiming activation. `bypassPermissions` requires a process launched with the corresponding allow/skip-permissions flag. Do not restart the app to add that flag as an automatic fallback. This command changes the running process only; a restarted Desktop session returns to its stored mode.

## Scope

Use this skill to control Claude Desktop sessions through Claude Desktop's own session APIs:

- Code: `window["claude.web"].LocalSessions`
- Cowork: `window["claude.web"].LocalAgentModeSessions`
- Raw Code/Cowork: Electron main-process `webContents.ipc._invokeHandlers` entries ending in `LocalSessions_$_...` or `LocalAgentModeSessions_$_...`
- Code live stdin: Claude Desktop's already-running `claude-code --resume <cliSessionId>` child process `stream-json` stdin pipe
- Code peer inbox: Claude's authenticated session-specific pipe from `.claude/sessions/<pid>.json`
- Code fallback: Claude Desktop's installed Claude Code CLI via `claude.exe --resume <cliSessionId>` after syncing Desktop OAuth into `~/.claude/.credentials.json`; use only after explicit user approval.

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

Code `send` requires an explicit `--session-id`. Accept either the exact Desktop `local_...` ID or its CLI session ID. Never infer the newest or focused recipient. Automatic order is renderer, raw, peer, then live stdin. Unknown or ambiguous identity fails before sending.

The peer transport resolves the selected live process from Claude's runtime registry, including children without a `--resume` argument. It verifies the session, checkout, process-start value and connected server PID. It uses only the local inbox key, without OAuth sync, restart or recipient settings changes.

Claude may hold an incoming peer message if sender permissions are unknown or differ. Declare `--sender-mode bypass|prompting --sender-session-id ID` only when those are the sender's actual current permissions and identity. The bridge passes Claude's canonical peer envelope; it never assumes bypass or rewrites the recipient's approval policy.

If neither renderer nor raw transport is live, `start` still fails. Code `send` must not use the CLI resume fallback automatically; use CLI resume only when the user explicitly approves it and the command passes `--allow-cli-fallback` or an explicit CLI transport. Cowork has no CLI resume fallback.

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
- `code send --prompt-file PATH --session-id ID --cwd PATH`: send only to the explicitly identified session.
- `code peer-probe --session-id ID`: verify the selected runtime and actual inbox server PID without sending a message.
- `code peer-receipt --session-id ID --message-id UUID`: reconcile a recorded request against its exact transcript without sending anything.
- `code send --transport peer --session-id ID --prompt-file PATH --wait`: use the authenticated live peer inbox.
- `cowork start --prompt "..." --cwd PATH`: create a Cowork session through `LocalAgentModeSessions.start`, force Cowork defaults, then send the prompt.
- `cowork send --prompt "..." --session-id local_...`: send to a Cowork session through `LocalAgentModeSessions.sendMessage`.
- `raw probe`: check direct eIPC handler visibility without sending a prompt. By default this is observation-only. Explicit `--bootstrap --attach-only` allows attach attempts but prevents a second instance launch. Restart remains explicit.
- `raw send --prompt "..." --cwd PATH`: send through direct eIPC handlers.
- `raw start --prompt "..." --cwd PATH`: create and send through direct eIPC handlers.
- `code send --raw-ipc --prompt "..." --cwd PATH`: raw eIPC mode from the normal Code command.
- `code send --transport cli --prompt "..." --cwd PATH`: send through Claude Code CLI resume, syncing Desktop OAuth first.
- `code send --transport live-stdin --prompt "..." --cwd PATH`: send into the already-running Claude Desktop Code child process for the matching session.
- `code send --transport live-stdin --prompt-file PATH --cwd PATH`: send a long prompt without putting the prompt body on the Windows command line.
- `auth-sync`: sync Claude Desktop OAuth into Claude Code CLI credentials without sending.
- `wait`: wait for a new assistant transcript entry.
- `read`: read recent transcript entries.
- `selftest`: validate payload construction and routing without touching Claude.

Examples:

```powershell
node $bridge code send --session-id local_... --cwd "C:\Users\USER\Desktop\Projects\SEMI" --prompt "Summarize the current work state." --wait
node $bridge code send --transport cli --session-id local_... --cwd "C:\Users\USER\Desktop\Projects\SEMI" --prompt "Summarize the current work state."
node $bridge auth-sync --json
node $bridge raw probe --cwd "C:\Users\USER\Desktop\Projects\SEMI" --json
node $bridge raw send --session-id local_... --cwd "C:\Users\USER\Desktop\Projects\SEMI" --prompt "Summarize the current work state." --wait
node $bridge code read --cwd "C:\Users\USER\Desktop\Projects\SEMI" --lines 12
node $bridge cowork send --session-id local_... --prompt "Check the repository state." --wait
```

## Forced Defaults

Peer sends preserve the running session's model, effort and permissions. The legacy renderer/raw and explicitly approved CLI paths use the defaults below; do not claim peer sends force them.

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

For long or non-ASCII prompts, prefer `--prompt-file`. Windows command-line argument length is limited, and Windows PowerShell text stdin can reinterpret UTF-8 through the active codepage. The bridge avoids both issues internally for `live-stdin` by passing a Base64-encoded UTF-8 stream-json frame to the PowerShell helper over stdin instead of a `-JsonLine` argument.

### Mandatory Windows Send Path

Treat a multi-line, Korean, quote-containing, JSON-containing, or user-authored prompt as file data from the start. Do not first try `--prompt` and add escaping after it fails.

1. Save the complete instruction as one UTF-8 file. Preserve its exact bytes until receipt is confirmed.
2. Run `status`, resolve the intended session, and use the narrowest safe transport.
3. For a live Code session, use `--transport peer` or verified `--transport live-stdin` with `--session-id ID --prompt-file PATH --wait`. UTF-8 structured frames pass to the PowerShell helper as Base64 over stdin, never interpolated shell source.
4. After `--wait`, read the intended transcript. Peer receipt requires the request UUID and a descendant assistant entry. A pipe-write acknowledgement alone is not delivery evidence. Assistant text may precede tool completion; confirm the final result separately. Do not resend an unknown request.

```powershell
$bridge = "$env:USERPROFILE\.codex\skills\claude-code-bridge\scripts\claude_code_bridge.mjs"
node $bridge status --cwd "C:\Users\USER\Desktop\Projects\SEMI" --json
node $bridge code peer-probe --session-id local_... --json
node $bridge code send --transport peer --session-id local_... --sender-mode ACTUAL_SENDER_MODE --sender-session-id SENDER_SESSION_ID --prompt-file "C:\Temp\claude-instruction.md" --wait --json
node $bridge code send --transport live-stdin --session-id local_... --cwd "C:\Users\USER\Desktop\Projects\SEMI" --prompt-file "C:\Temp\claude-instruction.md" --wait --json
node $bridge code read --session-id local_... --cwd "C:\Users\USER\Desktop\Projects\SEMI" --lines 20
```

`--transport cli` is not a safe repair for a complex Windows prompt: the current Claude Code CLI resume path still carries the final instruction as a positional CLI argument. Use it only for short, ASCII-only control messages after explicit user approval. If the full instruction must be preserved, return to a live Desktop transport or make the CLI implementation use a short file-reference envelope before invoking it. Do not silently fall back from `live-stdin` to CLI.

## Windows Argument Forwarding

Windows argument forwarding is a transport concern, not a quoting problem to be patched after failure. Treat user text, paths, JSON, Korean text, and prompts as payload data, never as PowerShell source.

- For ordinary fixed arguments, launch executables from Node with `spawn(executable, argumentArray)` or `execFileSync(executable, argumentArray)`. Do not build one command string and do not route caller-controlled values through `powershell.exe -Command`.
- For a PowerShell helper, invoke `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File helper.ps1` with only fixed scalar control arguments. Pass long, non-ASCII, quote-containing, or JSON payloads through UTF-8 stdin or a UTF-8 prompt file.
- When stdin must carry a structured frame, Base64-encode its UTF-8 bytes at the Node boundary and decode it inside the helper. This avoids the active Windows code page and prevents PowerShell from reparsing JSON, quotes, pipes, and backticks.
- Do not use `Start-Process -ArgumentList` as a generic forwarding layer. It serializes arguments and causes a second parse, which is unsafe for embedded quotes, trailing backslashes, empty values, Korean text, and JSON.
- Do not use `--%` for automated transport. It is an interactive PowerShell stop-parsing feature and cannot safely carry variables or runtime payloads.
- Keep the original payload in a temporary UTF-8 file when a child process needs a durable reference. Read the file with an explicit UTF-8 encoding, validate the received byte length and content hash when the operation is important, and remove it only after the child acknowledges receipt.

### Failure Classification And Retry Rule

Capture the first failure in JSON before any retry. Classify it as one of: command-line length, quote/reparse, code-page decoding, path resolution, target-process permissions, missing live child, or target session mismatch.

- Command-line length, quote/reparse, or code-page decoding: switch directly to `--prompt-file` plus `live-stdin`; do not add escaping or retry the same command.
- Path resolution: use an absolute Windows path and verify it can be read as UTF-8 before calling the bridge.
- Missing live child or target session mismatch: stop message delivery, rerun `status`/`list`, and select the confirmed session. Do not send to the latest session by guesswork.
- Target-process permissions: keep the current app unmodified and use an available renderer/raw transport. Do not patch `app.asar`, enable CDP, copy the Store app, or launch a second Claude instance as a workaround.

Never describe an invocation as sent merely because PowerShell started or a child process exists. Record transport kind, session ID, prompt-file byte length and SHA-256, then confirm the matching transcript entry.

If a Windows invocation fails, first classify it before retrying: command-line length, quoting/reparse, code-page decoding, path spacing, or target-process permissions. Change to the matching transport above; do not retry the same `-Command` or `Start-Process` pattern with more escaping.

For Code CLI resume mode, `bridge.available=false` and `rawIpc.available=false` are acceptable, but this mode is not an automatic fallback. Use it only after explicit user approval. The CLI must verify `claudeCodeCli.executable` and run `auth-sync` automatically unless `--no-auth-sync` is set.

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
