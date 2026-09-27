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
if (argv.includes("sessions") && argv.includes("new")) process.exit(0);
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
const { AcpxError, sessionPrompt } = await import("../src/acpx.js");

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
  assert.ok(result.notes.some((note) => /denied 1 tool request/.test(note)), result.notes.join("\n"));
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
