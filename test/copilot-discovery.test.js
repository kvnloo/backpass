import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import * as copilot from "../src/discovery/adapters/copilot.js";
import { statOrNull } from "../src/discovery/adapters/shared.js";
import { prefetchRemoteTranscripts } from "../src/discovery/hosts.js";
import { readTranscript } from "../src/discovery/index.js";
import { SELF_SESSION_SENTINEL } from "../src/sentinel.js";
import { discoverProject, FIXTURES, initRepo, tmpdir, withRemoteEnv } from "./helpers/remote.js";

const FIXTURE = path.join(FIXTURES, "copilot-session", "events.jsonl");

/** One synthetic Copilot session directory under `<root>/session-state/<id>/`. */
function writeSession(root, id, { cwd = null, context = {}, firstUser = null, events = null } = {}) {
  const dir = path.join(root, "session-state", id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "events.jsonl");
  if (events) {
    fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
    return file;
  }
  const lines = fs
    .readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  for (const entry of lines) {
    if (entry.type === "session.start") {
      entry.data.sessionId = id;
      entry.data.context = { ...entry.data.context, cwd, gitRoot: cwd, ...context };
    }
    if (entry.type === "user.message" && firstUser) entry.data.content = firstUser;
  }
  fs.writeFileSync(file, lines.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return file;
}

function classifyFile(file) {
  const stat = statOrNull(file);
  return copilot.classify({ key: file, path: file, mtimeMs: stat.mtimeMs, bytes: stat.size });
}

function start(context, data = {}) {
  return { type: "session.start", data: { startTime: "2026-08-05T01:39:53.221Z", ...data, context } };
}

test("copilot repository identity is a GitHub remote only for a well-formed owner/repo on github", () => {
  const root = tmpdir("copilot-identity");
  const remotesFor = (id, context) =>
    classifyFile(writeSession(root, id, { events: [start({ cwd: "/repo/demo", ...context })] })).remotes;

  // An `s` in either segment and a trailing `.git` are both ordinary repository names.
  assert.deepEqual(remotesFor("a", { repository: "systems/services.git", hostType: "github" }), [
    "https://github.com/systems/services.git",
  ]);
  assert.deepEqual(remotesFor("b", { repository: "acme/demo" }), ["https://github.com/acme/demo.git"]);
  assert.deepEqual(remotesFor("c", { repository: "acme/demo", hostType: "ado" }), []);
  assert.deepEqual(remotesFor("d", { repository: "acme/demo/extra", hostType: "github" }), []);
  assert.deepEqual(remotesFor("e", { repository: "not a repo", hostType: "github" }), []);
  assert.deepEqual(remotesFor("f", {}), []);
});

test("copilot classify falls back to the directory name and file mtime, and needs a session.start cwd", () => {
  const root = tmpdir("copilot-classify");
  const bare = writeSession(root, "dir-named", { events: [start({ cwd: "/repo/demo" }, { startTime: undefined })] });
  const descriptor = classifyFile(bare);
  assert.equal(descriptor.id, "dir-named");
  assert.equal(descriptor.startedAt, statOrNull(bare).mtimeMs);
  assert.equal(descriptor.gitRoot, null);
  assert.equal(descriptor.model, null);

  const noCwd = writeSession(root, "no-cwd", { events: [start({ repository: "acme/demo" })] });
  assert.equal(classifyFile(noCwd), null);
  const garbage = path.join(root, "session-state", "garbage", "events.jsonl");
  fs.mkdirSync(path.dirname(garbage), { recursive: true });
  fs.writeFileSync(garbage, "not json\n{also not json\n");
  assert.equal(classifyFile(garbage), null);
  assert.deepEqual(copilot.read({ path: garbage }), { events: [], model: null });
});

test("copilot read pairs each tool result by call id, marks failures, and leaves an unfinished call open", () => {
  const root = tmpdir("copilot-tools");
  const file = writeSession(root, "tools", {
    events: [
      start({ cwd: "/repo/demo" }, { selectedModel: "claude-sonnet-5" }),
      { type: "user.message", data: { content: "Run both checks." } },
      { type: "user.message", data: { content: "   " } },
      { type: "tool.execution_start", data: { toolCallId: "c1", toolName: "bash", arguments: { command: "lint" } } },
      { type: "tool.execution_start", data: { toolCallId: "c2", toolName: "bash", arguments: { command: "test" } } },
      { type: "tool.execution_complete", data: { toolCallId: "c2", success: false, error: { message: "exit 1" } } },
      { type: "tool.execution_complete", data: { toolCallId: "c1", success: true, result: { content: "clean" } } },
      { type: "tool.execution_start", data: { toolCallId: "c3", toolName: "view", arguments: { path: "a.js" } } },
      { type: "session.unknown_future_event", data: { content: "ignored" } },
    ],
  });

  const { events, model } = copilot.read({ path: file });
  assert.equal(model, "claude-sonnet-5");
  assert.deepEqual(
    events.map((event) =>
      event.kind === "tool" ? [event.input.command ?? event.input.path, event.result] : event.text,
    ),
    ["Run both checks.", ["lint", "clean"], ["test", "exit 1"], ["a.js", undefined]],
  );
  assert.deepEqual(
    events.filter((event) => event.kind === "tool").map((event) => event.status),
    ["completed", "error", undefined],
  );
  assert.ok(events.every((event) => !("pendingId" in event)));
});

test("local discovery associates Copilot sessions by cwd or recorded repository and drops backpass's own", async () => {
  const localHome = tmpdir("copilot-local");
  const repoRoot = initRepo(path.join(localHome, "demo"), "git@github.com:acme/demo.git");
  const store = path.join(localHome, ".copilot");
  writeSession(store, "live", { cwd: repoRoot });
  writeSession(store, "gone", { cwd: "/vanished/checkout-7", context: { repository: "acme/demo" } });
  writeSession(store, "elsewhere", { cwd: "/vanished/other", context: { repository: "acme/other" } });
  writeSession(store, "self", { cwd: repoRoot, firstUser: `${SELF_SESSION_SENTINEL}\nAnalyze this session.` });
  // A session directory that never persisted an event log is not a candidate at all.
  fs.mkdirSync(path.join(store, "session-state", "empty-dir"));

  const result = await withRemoteEnv({ localHome, hosts: {} }, () =>
    discoverProject(repoRoot, { discovery: { harnesses: ["copilot"] } }),
  );

  assert.deepEqual(result.transcripts.map((t) => [t.nativeId, t.association.tier]).sort(), [
    ["gone", 2],
    ["live", 1],
  ]);
  assert.equal(result.perHarness.copilot.scanned, 4);
  assert.equal(result.perHarness.copilot.self, 1);
  assert.equal(result.perHarness.copilot.error, null);
  const live = result.transcripts.find((t) => t.nativeId === "live");
  assert.equal(live.harness, "copilot");
  assert.equal(live.id, "copilot-live");
  assert.equal(live.gitBranch, "main");
  assert.equal(live.model, "claude-sonnet-5");
  assert.equal(live.startedAt, Date.parse("2026-08-05T01:39:53.221Z"));
  assert.equal(live.host, null);
});

test("the shipped probe collects a host's relocated Copilot store and fetches the event log byte for byte", async () => {
  const localHome = tmpdir("copilot-remote-local");
  const remoteHome = tmpdir("copilot-remote-home");
  const repoRoot = initRepo(path.join(localHome, "demo"), "https://github.com/acme/demo.git");
  const remoteClone = initRepo(path.join(remoteHome, "code", "demo"), "git@github.com:acme/demo.git");
  const source = writeSession(path.join(remoteHome, "relocated"), "remote-1", { cwd: remoteClone });
  // COPILOT_HOME replaces the default root on the host; it does not add to it.
  writeSession(path.join(remoteHome, ".copilot"), "default-root", { cwd: remoteClone });
  writeSession(path.join(remoteHome, "relocated"), "remote-self", {
    cwd: remoteClone,
    firstUser: `${SELF_SESSION_SENTINEL}\nAnalyze this session.`,
  });

  const { transcripts, perHost, stats, config } = await withRemoteEnv(
    { localHome, hosts: { "mac-home": { home: remoteHome } } },
    async () => {
      const found = await discoverProject(repoRoot, {
        discovery: {
          harnesses: ["copilot"],
          hosts: [{ host: "mac-home", env: { COPILOT_HOME: "~/relocated" } }],
        },
      });
      const fetched = await prefetchRemoteTranscripts(found.transcripts, { config: found.config });
      return { ...found, stats: fetched };
    },
  );

  assert.equal(perHost[0].error, null);
  assert.equal(perHost[0].self, 1);
  assert.deepEqual(
    transcripts.map((t) => [t.harness, t.nativeId, t.host, t.association.tier, t.remote.kind]),
    [["copilot", "remote-1", "mac-home", 1.5, "raw"]],
  );
  assert.equal(stats.fetched, 1);

  const [transcript] = transcripts;
  const cached = transcript.remote.cachePath;
  assert.ok(cached.startsWith(path.join(config.state.root, "hosts")));
  assert.equal(fs.readFileSync(cached, "utf8"), fs.readFileSync(source, "utf8"));

  const raw = await readTranscript(transcript);
  assert.equal(raw.rawPath, cached);
  assert.equal(raw.model, "claude-sonnet-5");
  assert.deepEqual(
    raw.events.map((event) => (event.kind === "tool" ? `${event.name}: ${event.result}` : event.text)),
    ["Fix the parser regression.", "I will run the focused test.", "bash: 1 passing", "The parser test passes."],
  );
});
