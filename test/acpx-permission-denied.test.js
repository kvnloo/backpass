import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-acpx-permission-denied-"));
const promptFile = path.join(dir, "prompt.md");
fs.writeFileSync(promptFile, "analyze this\n");

const fakeAcpx = path.join(dir, "acpx");
fs.writeFileSync(
  fakeAcpx,
  `#!${process.execPath}
const argv = process.argv.slice(2);
if (argv.includes("sessions") && argv.includes("new")) {
  // A non-zero create with no auth/spawn signature reads as "no session support".
  process.exit(process.env.FAKE_ACPX_SESSIONS === "unsupported" ? 1 : 0);
}
if (argv.includes("exec") && argv.includes("--file")) {
  const mode = process.env.FAKE_ACPX_MODE;
  const code = Number(process.env.FAKE_ACPX_EXIT || 5);
  if (mode === "json-denied") {
    process.stdout.write(JSON.stringify({
      positive: [],
      negative: [],
      gaps: [],
      usedRawTranscript: false
    }) + "\\n");
    process.stderr.write("[acpx] error: PERMISSION_DENIED tool request denied\\n");
    process.stderr.write("[acpx] error: PERMISSION_DENIED tool request denied\\n");
    process.stderr.write("[acpx] tokens: input=6 output=30 total=36\\n");
    process.exit(code);
  }
  process.stdout.write("permission denied before a usable answer\\n");
  process.stderr.write("[acpx] error: PERMISSION_DENIED tool request denied\\n");
  process.exit(code);
}
if (argv.includes("sessions") && argv.includes("close")) process.exit(0);
if (argv.includes("-s") && argv.includes("--file")) {
  if (process.env.FAKE_ACPX_MODE === "json-denied") {
    process.stdout.write(JSON.stringify({
      positive: [],
      negative: [],
      gaps: [],
      usedRawTranscript: false
    }) + "\\n");
    process.stderr.write("[acpx] error: PERMISSION_DENIED tool request denied\\n");
    process.stderr.write("[acpx] tokens: input=4 output=20 total=24\\n");
    process.exit(5);
  }
  process.stdout.write("permission denied before a usable answer\\n");
  process.stderr.write("[acpx] error: PERMISSION_DENIED tool request denied\\n");
  process.exit(5);
}
process.exit(0);
`,
);
fs.chmodSync(fakeAcpx, 0o755);

process.env.BACKPASS_ACPX_BIN = fakeAcpx;
const { AcpxError, execOneShot, sessionPrompt } = await import("../src/acpx.js");
const { sanitizeEvidence } = await import("../src/analyze.js");

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("exit 5 keeps a completed parseable JSON turn and records the denied request", async () => {
  process.env.FAKE_ACPX_MODE = "json-denied";
  const result = await sessionPrompt({
    agent: "claude",
    sessionName: "backpass-permission-json",
    promptFile,
    cwd: dir,
    timeoutSeconds: 5,
  });

  assert.doesNotThrow(() => JSON.parse(result.text));
  assert.equal(result.deniedRequests, 1);
  assert.ok(
    result.notes.some((note) => /denied 1 tool request/.test(note)),
    result.notes.join("\n"),
  );
  assert.deepEqual(result.usage, { input: 4, output: 20, total: 24 });
});

test("exit 5 without parseable JSON remains fatal", async () => {
  process.env.FAKE_ACPX_MODE = "text-denied";
  await assert.rejects(
    () =>
      sessionPrompt({
        agent: "claude",
        sessionName: "backpass-permission-text",
        promptFile,
        cwd: dir,
        timeoutSeconds: 5,
      }),
    (err) => {
      assert.ok(err instanceof AcpxError, String(err));
      assert.match(err.message, /session prompt failed \(exit 5\)/);
      return true;
    },
  );
});

const oneShot = () => execOneShot({ agent: "claude", promptFile, cwd: dir, timeoutSeconds: 5 });

/** Run `fn` with only these FAKE_ACPX_* switches set, then put the environment back. */
async function withFake(env, fn) {
  const keys = ["FAKE_ACPX_MODE", "FAKE_ACPX_EXIT", "FAKE_ACPX_SESSIONS"];
  const saved = keys.map((key) => process.env[key]);
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    keys.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    });
  }
}

test("one-shot exit 5 keeps a completed parseable JSON answer and counts each denied request", async () => {
  const result = await withFake({ FAKE_ACPX_MODE: "json-denied" }, oneShot);

  assert.deepEqual(JSON.parse(result.text), { positive: [], negative: [], gaps: [], usedRawTranscript: false });
  assert.equal(result.deniedRequests, 2);
  assert.ok(
    result.notes.some((note) => /claude denied 2 tool request\(s\).*keeping the completed answer/.test(note)),
    result.notes.join("\n"),
  );
  assert.deepEqual(result.usage, { input: 6, output: 30, total: 36 });
});

test("one-shot exit 5 without parseable JSON remains fatal", async () => {
  await assert.rejects(
    () => withFake({ FAKE_ACPX_MODE: "text-denied" }, oneShot),
    (err) => {
      assert.ok(err instanceof AcpxError, String(err));
      assert.match(err.message, /acpx claude exec failed \(exit 5\): .*PERMISSION_DENIED/);
      assert.equal(err.code, 5);
      return true;
    },
  );
});

test("one-shot keeps no answer from any other non-zero exit, parseable JSON or not", async () => {
  for (const mode of ["json-denied", "text-denied"]) {
    for (const code of [1, 2, 4, 6]) {
      await assert.rejects(
        () => withFake({ FAKE_ACPX_MODE: mode, FAKE_ACPX_EXIT: String(code) }, oneShot),
        (err) => {
          assert.ok(err instanceof AcpxError, `${mode} exit ${code}: ${err}`);
          assert.match(err.message, new RegExp(`acpx claude exec failed \\(exit ${code}\\)`));
          return true;
        },
        `${mode} exit ${code}`,
      );
    }
  }
});

test("a session-less harness that falls back to one-shot still reports the denied requests and the note", async () => {
  const result = await withFake({ FAKE_ACPX_MODE: "json-denied", FAKE_ACPX_SESSIONS: "unsupported" }, () =>
    sessionPrompt({
      agent: "claude",
      sessionName: "backpass-permission-fallback",
      promptFile,
      cwd: dir,
      timeoutSeconds: 5,
    }),
  );

  assert.doesNotThrow(() => JSON.parse(result.text));
  assert.equal(result.deniedRequests, 2);
  const notes = result.notes.join("\n");
  assert.match(notes, /fell back to exec one-shot/);
  assert.match(notes, /denied 2 tool request/);
});

test("model evidence carries no denied-request count of its own", () => {
  // The count comes from the harness exit, not from the model's JSON. A default on the
  // evidence would overwrite the recorded count when the two are stored together.
  const evidence = sanitizeEvidence({ positive: [], negative: [], gaps: [], deniedRequests: 7 });
  assert.equal("deniedRequests" in evidence, false);
  assert.deepEqual({ deniedRequests: 2, ...evidence }.deniedRequests, 2);
});
