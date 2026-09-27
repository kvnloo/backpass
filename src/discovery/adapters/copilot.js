import path from "node:path";

import { emptyInteractionSignals } from "../../interaction.js";
import {
  attachToolResults,
  home,
  listDirs,
  parseJsonLine,
  readHeadLines,
  readJsonl,
  statOrNull,
} from "./shared.js";

/**
 * GitHub Copilot CLI: COPILOT_HOME or ~/.copilot/session-state/<session-id>/events.jsonl
 *
 * The event log is the evidence source. Checkpoints, plan.md, workspace artifacts and
 * session-store.db are derived/summary state and are never analyzed as transcript turns.
 * session.start.data.context.cwd is the deterministic project identity; repository /
 * branch metadata is carried when present. Missing or drifted sessions fail soft.
 */

const HEADER_LINES = 80;

export const name = "copilot";

export function configRoot() {
  const configured = process.env.COPILOT_HOME?.trim();
  return configured ? path.resolve(configured) : home(".copilot");
}

export function storeRoot() {
  return path.join(configRoot(), "session-state");
}

export function enumerate() {
  const out = [];
  for (const dir of listDirs(storeRoot())) {
    const file = path.join(dir, "events.jsonl");
    const stat = statOrNull(file);
    if (!stat || !stat.isFile()) continue;
    out.push({ key: file, path: file, mtimeMs: stat.mtimeMs, bytes: stat.size });
  }
  return out;
}

function githubRemote(repository, hostType) {
  const value = String(repository || "").trim();
  if (!value || (hostType && String(hostType).toLowerCase() !== "github")) return [];
  if (!/^[^/\\s]+\\/[^/\\s]+$/.test(value)) return [];
  return ["https://github.com/" + value.replace(/\\.git$/i, "") + ".git"];
}

function contextFromStart(entry) {
  if (entry?.type !== "session.start") return null;
  const data = entry.data || {};
  const context = data.context || {};
  if (!context.cwd) return null;
  return { data, context };
}

export function classify(candidate) {
  let start = null;
  let title = null;
  for (const line of readHeadLines(candidate.path, HEADER_LINES)) {
    const entry = parseJsonLine(line);
    if (!entry) continue;
    if (!start) start = contextFromStart(entry);
    if (entry.type === "session.title_changed" && entry.data?.title) title = String(entry.data.title);
  }
  if (!start) return null;

  const { data, context } = start;
  const parsedStart = Date.parse(data.startTime || "");
  return {
    id: data.sessionId || path.basename(path.dirname(candidate.path)),
    cwd: context.cwd,
    gitRoot: context.gitRoot || null,
    gitBranch: context.branch || null,
    remotes: githubRemote(context.repository, context.hostType),
    startedAt: Number.isFinite(parsedStart) ? parsedStart : candidate.mtimeMs,
    title,
    model: data.selectedModel || null,
    interactionSignals: emptyInteractionSignals(),
  };
}

function toolResult(data) {
  if (data?.result?.content != null) return data.result.content;
  if (data?.error?.message != null) return data.error.message;
  return "";
}

export function read(ref) {
  const entries = readJsonl(ref.path);
  const events = [];
  let model = null;

  for (const entry of entries) {
    const data = entry?.data || {};
    switch (entry?.type) {
      case "session.start":
        model = data.selectedModel || model;
        break;
      case "session.model_change":
        model = data.selectedModel || data.model || model;
        break;
      case "user.message":
        if (typeof data.content === "string" && data.content.trim()) {
          events.push({ kind: "message", role: "user", text: data.content });
        }
        break;
      case "assistant.message":
        if (typeof data.content === "string" && data.content.trim()) {
          events.push({ kind: "message", role: "assistant", text: data.content });
        }
        break;
      case "tool.execution_start":
        if (data.toolCallId && data.toolName) {
          events.push({
            kind: "tool",
            name: data.toolName,
            input: data.arguments,
            pendingId: data.toolCallId,
          });
        }
        break;
      case "tool.execution_complete":
        if (data.toolCallId) {
          events.push({
            kind: "tool-result",
            id: data.toolCallId,
            result: toolResult(data),
            status: data.success === false ? "error" : "completed",
          });
        }
        break;
      default:
        break;
    }
  }

  return { events: attachToolResults(events), model };
}

export function rawPath(ref) {
  return ref.path;
}
