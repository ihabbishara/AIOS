import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Store, PersonalTaskRow } from "../store/db.js";

function text(s: string) { return { content: [{ type: "text" as const, text: s }] }; }

function fmt(rows: PersonalTaskRow[]): string {
  return rows.map((r) =>
    `  #${r.id} [${r.status}] ${r.title}` +
    `${r.due_date ? ` (due ${r.due_date})` : ""}` +
    `${r.project ? ` {${r.project}}` : ""}` +
    `${r.next_action ? `\n    next: ${r.next_action}` : ""}`,
  ).join("\n") || "(no tasks)";
}

export interface LifeopsServerDeps { store: Store; }

/** Direct-CRUD MCP server for the private task list. No gate, no outward effects. */
export function buildLifeopsServer(deps: LifeopsServerDeps) {
  const { store } = deps;

  const addTask = tool(
    "add_task", "Add an open loop / errand / follow-up to the private task list.",
    {
      title: z.string(),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      project: z.string().optional(),
      next_action: z.string().optional(),
      notes: z.string().optional(),
    },
    async (a) => {
      const id = store.addTask({
        title: a.title, due_date: a.due_date ?? null, project: a.project ?? null,
        next_action: a.next_action ?? null, notes: a.notes ?? null,
      });
      return text(`Added task #${id}: ${a.title}.`);
    },
  );

  const listTasks = tool(
    "list_tasks", "List tasks, optionally filtered by status (open/waiting/done/dismissed) and/or project.",
    { status: z.enum(["open", "waiting", "done", "dismissed"]).optional(), project: z.string().optional() },
    async (a) => text(fmt(store.listTasks(a.status, a.project))),
  );

  const updateTask = tool(
    "update_task", "Update fields of a task by id (any subset).",
    {
      id: z.number().int(),
      title: z.string().optional(),
      status: z.enum(["open", "waiting", "done", "dismissed"]).optional(),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      project: z.string().nullable().optional(),
      next_action: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
    },
    async (a) => {
      const { id, ...fields } = a;
      store.updateTask(id, fields);
      return text(`Task #${id} updated.`);
    },
  );

  const completeTask = tool("complete_task", "Mark a task done by id.", { id: z.number().int() },
    async (a) => { store.completeTask(a.id); return text(`Task #${a.id} done.`); });
  const dismissTask = tool("dismiss_task", "Dismiss a task (no longer relevant) by id.", { id: z.number().int() },
    async (a) => { store.dismissTask(a.id); return text(`Task #${a.id} dismissed.`); });

  return createSdkMcpServer({
    name: "lifeops", version: "0.1.0",
    tools: [addTask, listTasks, updateTask, completeTask, dismissTask],
  });
}
