import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCreateCliArgs, createCodeSession, findImportedSession } from "./claude_session_create.mjs";

const sessionId = "11111111-2222-4333-8444-555555555555";

function fixture(t, options = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-create-test-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const transcript = path.join(cwd, `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, "{}\n", "utf8");
  const calls = [];
  const deps = {
    executablePath: "claude.exe",
    inferenceToken: () => "test-only-token",
    runCli: async (exe, args, payload) => {
      calls.push({ exe, args, payload });
      return { code: 0, stdout: JSON.stringify({ session_id: sessionId, result: "READY" }), stderr: "" };
    },
    transcriptPath: () => transcript,
    openUrl: (url) => calls.push({ url }),
    listCodeSessions: () => [{ sessionId: "local_test", cliSessionId: sessionId, cwd, permissionMode: "acceptEdits" }],
    ...options,
  };
  return { cwd, transcript, calls, deps };
}

test("create preserves prompt on stdin and imports only the requested CLI identity", async (t) => {
  const f = fixture(t);
  const prompt = 'Unicode: \uD55C\uAE00 "quoted"\nnext line';
  const result = await createCodeSession({ cwd: f.cwd, sessionId, prompt, permissionMode: "acceptEdits" }, f.deps);
  assert.equal(f.calls[0].payload.input, prompt);
  assert.equal(f.calls[0].args.includes(prompt), false);
  assert.equal(f.calls[0].payload.env.CLAUDE_CODE_OAUTH_TOKEN, "test-only-token");
  assert.equal(f.calls[1].url, `claude://resume?session=${sessionId}`);
  assert.equal(result.desktopSessionId, "local_test");
  assert.equal(result.desktopImported, true);
  assert.equal(JSON.stringify(result).includes("test-only-token"), false);
});

test("failed first turn never opens Desktop or creates a second session", async (t) => {
  let attempts = 0;
  const f = fixture(t, {
    runCli: async () => { attempts++; return { code: 1, stdout: "", stderr: "fixture failure" }; },
    openUrl: () => assert.fail("must not open after failure"),
  });
  await assert.rejects(createCodeSession({ cwd: f.cwd, sessionId, prompt: "test" }, f.deps), (error) => {
    assert.equal(error.details.stage, "first-turn");
    assert.equal(error.details.sessionId, sessionId);
    return true;
  });
  assert.equal(attempts, 1);
});

test("missing transcript blocks import even after a successful first turn", async (t) => {
  const f = fixture(t, { openUrl: () => assert.fail("must not import a missing transcript") });
  fs.unlinkSync(f.transcript);
  await assert.rejects(createCodeSession({ cwd: f.cwd, sessionId, prompt: "test" }, f.deps), (error) => error.details.stage === "transcript");
});

test("import timeout retains the created identity and never retries creation", async (t) => {
  const f = fixture(t, { listCodeSessions: () => [] });
  await assert.rejects(createCodeSession({ cwd: f.cwd, sessionId, prompt: "test", importTimeoutMs: 0 }, f.deps), (error) => {
    assert.equal(error.details.stage, "desktop-import");
    assert.equal(error.details.cliSessionId, sessionId);
    assert.equal(error.details.deepLink, `claude://resume?session=${sessionId}`);
    return true;
  });
  assert.equal(f.calls.filter((call) => call.exe).length, 1);
});

test("ambiguous imported identities and invalid permissions are rejected", () => {
  assert.throws(() => findImportedSession([
    { sessionId: "local_a", cliSessionId: sessionId },
    { sessionId: "local_b", cliSessionId: sessionId },
  ], sessionId), /lists 2 sessions/);
  assert.throws(() => buildCreateCliArgs({ sessionId, permissionMode: "invalid" }), /permission-mode/);
  assert.equal(buildCreateCliArgs({ sessionId, permissionMode: "acceptEdits" }).includes("--allow-dangerously-skip-permissions"), false);
});
