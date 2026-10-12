# Security and local data

Triangle Bridge uses the signed-in desktop applications on the current user's Windows account. Session discovery and transcript reads are local operations. Sends invoke the running target app, which uses its existing service connection.

No API keys, OAuth token values, personal paths, live session IDs, transcripts, or app state belong in the published package. Runtime locations are derived from the current environment and home directory. Package resources are explicitly selected; local app configuration and test output are excluded.

Claude live stdin and native peer sends do not read OAuth credentials. Creating a new Claude Desktop Code session uses Desktop's existing encrypted sign-in cache for the installed child binary's initial turn, passes it through that child environment, and imports the resulting session into Desktop. No credential file is written during this create path. The separately requested legacy CLI-resume diagnostic can sync a credential file locally; it is disabled as an automatic fallback.

Antigravity uses its existing loopback-only desktop endpoint and authenticated native client. It checks native app identity before calling session APIs. No debugger or browser is launched. Codex uses the current user's local native app pipes.

Permission changes require explicit target IDs and are read back. Antigravity permission presets apply to the target conversation's project when a mode is explicitly requested. Ordinary sends preserve permissions and models. The bridge does not restart or patch apps.

Session operations can launch the installed same-user desktop app or reopen its closed window. Installation paths come from the current Windows package manifest, standard installation locations and registered app paths. Startup waits for readiness before session mutations and never terminates a process, adds debugger flags or retries a message with unknown delivery. Passive discovery does not launch apps unless `--start-app` is explicit.

The local outbox records recipient IDs, request UUIDs, prompt hashes, and states; it stores neither prompt bodies nor inbox keys. Duplicate unconfirmed Claude and Antigravity inputs are blocked. Lost mutation acknowledgements are reported as unknown; inspect the exact target before making another attempt.

Before publication, run `npm run check`, `npm test`, and `npm pack --dry-run`. Inspect the staged source and package contents for actual credential values and personal data. Names such as `accessToken` in source are implementation variables, not published token values.
