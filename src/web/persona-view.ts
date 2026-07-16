// src/web/persona-view.ts — persona explorer builders: per-agent activity merge +
// comment-preserving manifest field splicing (spec 2026-07-16-persona-explorer).
import { parseDocument, isMap, isNode, isScalar } from "yaml";
import type { Store } from "../store/db.js";
import type { EventBus } from "../events.js";
import type { LoadedRegistry } from "../agents/registry/loader.js";
import type { AgentActivityInfo } from "./dto.js";

const HISTORY_WINDOW = 5000; // same window as org-view
const TIMELINE_CAP = 100;

export function buildAgentActivity(
  nameOrAlias: string,
  registry: LoadedRegistry,
  store: Store,
  bus: EventBus,
): AgentActivityInfo | null {
  const name = registry.agentOf.get(nameOrAlias);
  if (!name || !registry.agents.has(name)) return null;
  const canon = (agent: string) => registry.agentOf.get(agent) ?? agent;

  const timeline: AgentActivityInfo["timeline"] = [];
  for (const e of bus.history(0, HISTORY_WINDOW)) {
    const ev = e.event;
    if (ev.type === "agent.end" && canon(ev.agent) === name) {
      timeline.push({ ts: e.ts, kind: "run", summary: ev.context, ok: ev.ok });
    } else if (ev.type === "route.decision" && canon(ev.to) === name) {
      timeline.push({ ts: e.ts, kind: "route", summary: `${ev.via}: ${ev.reason}` });
    } else if (ev.type === "mail.sent" && (canon(ev.from) === name || canon(ev.to) === name)) {
      timeline.push({ ts: e.ts, kind: "mail", summary: `${ev.from} → ${ev.to} (${ev.kind})` });
    } else if (ev.type === "node.status" && canon(ev.agent) === name) {
      timeline.push({
        ts: e.ts, kind: "goal",
        summary: `${ev.goalId.slice(0, 8)}/${ev.nodeKey}: ${ev.status}`,
        ...(ev.status === "failed" ? { ok: false } : {}),
      });
    }
  }
  timeline.reverse(); // history is oldest-first

  const goals: AgentActivityInfo["goals"] = [];
  for (const g of store.listGoals(50)) {
    const nodes = store.listNodes(g.id).filter((n) => canon(n.agent) === name);
    if (nodes.length === 0) continue;
    goals.push({
      goalId: g.id, title: g.title, status: g.status,
      nodes: nodes.map((n) => ({ key: n.node_key, status: n.status })),
    });
  }

  const mail = store.listMail(name, 30).map((m) => ({
    id: m.id, ts: m.created_at, from: m.from_agent, to: m.to_agent,
    kind: m.kind, snippet: m.body.slice(0, 120), status: m.status,
  }));

  return { timeline: timeline.slice(0, TIMELINE_CAP), goals, mail };
}

const EDITABLE: Record<string, "scalar" | "block" | "number"> = {
  title: "scalar", charter: "block", persona: "block", prompt: "block",
  model: "scalar", maxTurns: "number",
};
/** Optional manifest keys we insert when absent; required keys throw instead. */
const OPTIONAL = new Set(["model", "maxTurns"]);
const PLAIN_SCALAR = /^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/;

/** Render one `key: value` replacement in the manifests' house style. */
function renderField(field: string, kind: "scalar" | "block" | "number", value: string | number): string {
  if (kind === "number") {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new Error(`${field} must be a positive integer`);
    }
    return `${field}: ${value}\n`;
  }
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  if (kind === "scalar") {
    if (value.includes("\n")) throw new Error(`${field} must be a single line`);
    return `${field}: ${PLAIN_SCALAR.test(value) ? value : JSON.stringify(value)}\n`;
  }
  // Block prose. Single-line values keep the house folded style (`>`); multi-line
  // values use a literal block (`|`) — folding would silently collapse the user's
  // line breaks to spaces on the next parse.
  const body = value.trim().split("\n").map((l) => (l.trim() === "" ? "" : `  ${l.trimEnd()}`)).join("\n");
  return `${field}: ${value.trim().includes("\n") ? "|" : ">"}\n${body}\n`;
}

/**
 * Rewrite one manifest field, leaving every other byte of the file untouched.
 * Parse to LOCATE, splice to EDIT — same rule as rewriteSkillsField (a full
 * Document.toString() round-trip re-emits the whole hand-authored file).
 * Throws on invalid field/value/yaml; the message doubles as the HTTP 400 body.
 */
export function spliceManifestField(text: string, field: string, value: string | number): string {
  const kind = EDITABLE[field];
  if (!kind) throw new Error(`field "${field}" is not editable`);
  const rendered = renderField(field, kind, value);

  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new Error(`yaml: ${doc.errors[0].message}`);
  const items = isMap(doc.contents) ? doc.contents.items : [];
  const pair = items.find((p) => isScalar(p.key) && p.key.value === field);

  if (!pair || !isNode(pair.key) || !isNode(pair.value)) {
    if (!OPTIONAL.has(field)) throw new Error(`manifest missing required field "${field}"`);
    const tools = items.find((p) => isScalar(p.key) && p.key.value === "tools");
    if (tools && isNode(tools.value)) {
      const end = tools.value.range![2];
      return text.slice(0, end) + rendered + text.slice(end);
    }
    return text === "" || text.endsWith("\n") ? text + rendered : `${text}\n${rendered}`;
  }
  const start = pair.key.range![0];
  const end = pair.value.range![2];
  return text.slice(0, start) + rendered + text.slice(end);
}
