# Security

This project is a local automation bridge. It should be treated as sensitive because it interacts with running desktop AI applications and local session state.

## What Is Not Stored

- No OpenAI, Anthropic, GitHub, or other API keys are committed.
- No OAuth access or refresh tokens are committed.
- No live transcript JSONL files are committed.
- No Claude Desktop `config.json`, `Local State`, or `~/.claude/.credentials.json` files are committed.

## Runtime Behavior

`scripts/claude_code_bridge.mjs` includes a CLI fallback that can read Claude Desktop's encrypted local OAuth cache using Windows DPAPI and sync a Claude Code credential file locally. This is runtime behavior only. The repository stores code that performs the sync, not the resulting credentials.

The `live-stdin` transport does not read or write OAuth credentials. It writes a stream-json user frame to the stdin pipe of an already-running Claude Desktop `claude-code` child process.

## Before Pushing

Run a syntax check:

```powershell
npm run check
```

Run a local secret scan over staged changes:

```powershell
git diff --cached | Select-String -Pattern "password|secret|api[_-]?key|token|authorization|Bearer"
```

Expected false positives include variable names such as `accessToken`, `refreshToken`, and `oauth:tokenCache`. Actual token values must never be staged.
