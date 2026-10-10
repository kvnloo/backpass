import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { State } from "../src/state.js";

/**
 * A denied tool request on a completed turn is counted, end to end.
 *
 * acpx exits 5 (PERMISSION_DENIED) when any request in the turn was denied, even when the
 * turn then finished with a complete JSON answer. `openSession`'s `prompt()` keeps that
 * answer and reports how many requests were denied (`src/acpx.js`); `analyzeTranscripts`
 * is what has to carry the number into the evidence file and the run summary
 * (`src/analyze.js`). The unit tests stop at `sessionPrompt`, so this drives the real CLI:
 * three sessions, two of which end at exit 5 with a different number of denials each, and
 * reads back the same evidence files and `--json` summary a user would.
 *
 * It also pins the call path. Analysis reaches the exit-5 handling only through a named
 * session, which `runModelCall` picks whenever the role has an effort - the default for
 * every harness but OpenCode. The fake records each prompt's argv to show that is the path
 * taken here, with no effort flag passed.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "backpass.js");

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-denied-bin-"));
const fakePi = path.join(binDir, "pi");
const fakeAcpx = path.join(binDir, "acpx");
const callLog = path.join(binDir, "calls.jsonl");

/** Denied requests per session; a session not listed here exits clean. */
const DENIALS = { thrice: 3, twice: 2 };

fs.writeFileSync(fakePi, `#!${process.execPath}\nprocess.exit(0);\n`);
fs.chmodSync(fakePi, 0o755);
fs.writeFileSync(
  fakeAcpx,
  `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (argv.includes("config") && argv.includes("show")) {
  process.stdout.write(JSON.stringify({ agents: {} }) + "\\n");
  process.exit(0);
}
if (argv.includes("--file")) {
  const prompt = fs.readFileSync(argv[argv.indexOf("--file") + 1], "utf8");
  const session = /Do the (\\S+) work\\./.exec(prompt)[1];
  fs.appendFileSync(${JSON.stringify(callLog)}, JSON.stringify({ session, argv }) + "\\n");
  process.stdout.write(JSON.stringify({ positive: [], negative: [], gaps: [], usedRawTranscript: false }) + "\\n");
  const denied = ${JSON.stringify(DENIALS)}[session] || 0;
  for (let i = 0; i < denied; i += 1) {
    process.stderr.write("[acpx] error: PERMISSION_DENIED tool request denied\\n");
  }
  process.stderr.write("[acpx] tokens: input=4 output=20 total=24\\n");
  process.exit(denied ? 5 : 0);
}
process.exit(0);
`,
);
fs.chmodSync(fakeAcpx, 0o755);

function git(args, cwd) {
  spawnSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-denied-repo-")));
  git(["init", "--quiet", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "test"], dir);
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Agent instructions\n\n- Run `make build` before every push.\n");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "memory"], dir);
  return dir;
}

/** A Pi session, non-trivial, whose first user message names it for the fake. */
function writeSession(home, id, cwd) {
  const dir = path.join(home, ".pi", "agent", "sessions", id);
  fs.mkdirSync(dir, { recursive: true });
  const entries = [
    { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd },
    { type: "message", message: { role: "user", content: `Do the ${id} work.` } },
    { type: "message", message: { role: "assistant", content: "Working on it." } },
    { type: "message", message: { role: "user", content: "Now run the tests too." } },
    { type: "message", message: { role: "assistant", content: "Tests pass." } },
  ];
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

test("denied requests on completed turns reach the evidence files and the run summary", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-denied-home-"));
  const dir = initRepo();
  for (const id of ["thrice", "twice", "clean"]) writeSession(home, id, dir);

  const result = spawnSync(
    process.execPath,
    [CLI, "analyze", "--harness", "pi", "--since", "all", "--analysis-agent", "pi", "--jobs", "1", "--json"],
    {
      cwd: dir,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        BACKPASS_ACPX_BIN: fakeAcpx,
        NO_COLOR: "1",
      },
      encoding: "utf8",
      timeout: 30000,
    },
  );
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, output);

  // Every prompt went through a named session: that is where exit 5 is handled.
  const calls = fs
    .readFileSync(callLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(calls.map((call) => call.session).sort(), ["clean", "thrice", "twice"]);
  for (const call of calls) {
    assert.match(call.argv[call.argv.indexOf("-s") + 1] || "", /^backpass-analysis-/, call.argv.join(" "));
    assert.equal(call.argv.includes("exec"), false, call.argv.join(" "));
  }

  const { summary } = JSON.parse(result.stdout);
  assert.deepEqual([summary.analyzed, summary.failed], [3, 0], "an exit-5 turn with an answer is not a failure");
  // An uninitialised counter sums to NaN, which the JSON report prints as null.
  assert.equal(summary.deniedRequests, 5, `the run summary totals the denials: ${result.stdout}`);

  // Read the persisted analysis contract after the CLI has exited, not its model output.
  const evidence = new State(dir).listEvidence();
  const stored = Object.fromEntries(
    evidence.map((record) => [path.basename(record.transcript.path, ".jsonl"), record]),
  );
  assert.deepEqual(Object.keys(stored).sort(), ["clean", "thrice", "twice"]);
  for (const record of evidence) assert.equal(record.status, "ok", JSON.stringify(record));
  assert.equal(stored.thrice.deniedRequests, 3, "each evidence file keeps its own count");
  assert.equal(stored.twice.deniedRequests, 2, "each evidence file keeps its own count");
  assert.equal("deniedRequests" in stored.clean, false, "a turn with no denial records none");

  assert.match(output, /pi denied 3 tool request\(s\)/, "the denial is surfaced as a warning");
});
