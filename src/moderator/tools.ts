import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { resolve } from "node:path";
import type { JobManager } from "../engine/jobs.js";
import type { Store } from "../store/db.js";
import type { VaultWriter } from "../vault/writer.js";
import { roles } from "../agents/roles/index.js";
import type { ActionGate } from "../kernel/gate.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

export interface ModeratorToolsDeps {
  jobs: JobManager;
  store: Store;
  vault: VaultWriter;
  projectsRoot: string;
  /** Origin of the message currently being handled — set before each query. */
  origin: { channel: string; chatId: string };
  /** One-shot specialist consultation (synchronous — used by ask_specialist). */
  consult: (role: string, question: string) => Promise<{ text: string }>;
  gate: ActionGate;
  /** Registered executor types, for the tool description. */
  actionTypes: string[];
}

export function buildModeratorServer(deps: ModeratorToolsDeps) {
  const runPlaybook = tool(
    "run_playbook",
    "Start a background job that runs a playbook (multi-agent pipeline). Returns immediately with a job id; you are notified on completion.",
    {
      playbook: z.string().describe("Playbook name, e.g. software-feature"),
      title: z.string().describe("Short human title for the job"),
      request: z.string().describe("Full task description handed to the specialist agents — include all context they need"),
      project_dir: z.string().optional().describe("Absolute path to the target project directory (required for software playbooks)"),
    },
    async (args) => {
      if (args.project_dir) {
        const dir = resolve(args.project_dir);
        if (!dir.startsWith(resolve(deps.projectsRoot))) {
          return text(`Refused: project_dir must be under ${deps.projectsRoot}`);
        }
      }
      const job = deps.jobs.createJob({
        playbook: args.playbook,
        title: args.title,
        request: args.request,
        projectDir: args.project_dir,
        channel: deps.origin.channel,
        chatId: deps.origin.chatId,
      });
      return text(`Job started: ${job.id} (${job.slug}, playbook ${job.playbook}). You will be notified on completion.`);
    },
  );

  const jobStatus = tool(
    "job_status",
    "Get status of a job by id, or list recent jobs when no id given.",
    { job_id: z.string().optional() },
    async (args) => {
      if (args.job_id) {
        const job = deps.store.getJob(args.job_id);
        return text(job ? JSON.stringify(job, null, 2) : `No job ${args.job_id}`);
      }
      const jobs = deps.store.listJobs(10).map((j) => `${j.created_at} ${j.id} [${j.status}] ${j.title}`);
      return text(jobs.join("\n") || "No jobs yet.");
    },
  );

  const askSpecialist = tool(
    "ask_specialist",
    "Consult one specialist directly with a single question and get their answer inline. " +
      "Use for quick opinions/analysis — NOT for executing work (use run_playbook for that). " +
      "Can take a few minutes.",
    {
      role: z.enum(Object.keys(roles) as [string, ...string[]]),
      question: z.string().describe("The question, with all context the specialist needs"),
    },
    async (args) => {
      const res = await deps.consult(args.role, args.question);
      return text(`[${args.role}]\n${res.text}`);
    },
  );

  const listPlaybooks = tool(
    "list_playbooks",
    "List available playbooks.",
    {},
    async () => text(deps.jobs.listPlaybooks().map((p) => `${p.name}: ${p.description}`).join("\n")),
  );

  const vaultWrite = tool(
    "vault_write",
    "Write a markdown note to the Obsidian vault (audited through the action gate). " +
      "Path is relative to the AIOS folder, e.g. notes/idea-x.md or knowledge/topic.md",
    {
      path: z.string(),
      content: z.string(),
    },
    async (args) => {
      const row = await deps.gate.propose(
        { type: "vault.write", payload: { path: args.path, content: args.content }, preview: `Write vault note ${args.path}` },
        deps.origin,
      );
      if (row.status === "executed") return text(row.result!);
      if (row.status === "failed") return text(`Write failed: ${row.result}`);
      return text(`Queued for user approval (action ${row.id}). The note is NOT written until the user approves.`);
    },
  );

  const vaultRead = tool(
    "vault_read",
    "Read a markdown note from the vault (path relative to AIOS folder, e.g. jobs/2026-06-11-foo/design.md).",
    { path: z.string() },
    async (args) => {
      const content = deps.vault.readNote(args.path);
      return text(content ?? `Not found: ${args.path}`);
    },
  );

  const vaultList = tool(
    "vault_list",
    "List notes in the vault under a relative directory ('' for everything).",
    { dir: z.string().optional() },
    async (args) => text(deps.vault.listNotes(args.dir ?? "").join("\n") || "(empty)"),
  );

  const proposeAction = tool(
    "propose_action",
    "Propose an outward action through the trust gate. Trusted action types execute " +
      "immediately; everything else is queued for the user to approve. " +
      `Registered types: ${deps.actionTypes.join(", ")}`,
    {
      type: z.string().describe("Registered action type, e.g. test.echo"),
      payload: z.record(z.string(), z.unknown()).describe("Payload matching the action type's schema"),
      preview: z.string().describe("One-line human summary shown in the approval request"),
    },
    async (args) => {
      try {
        const row = await deps.gate.propose(
          { type: args.type, payload: args.payload as Record<string, unknown>, preview: args.preview },
          deps.origin,
        );
        if (row.status === "executed") return text(`Executed: ${row.result}`);
        if (row.status === "failed") return text(`Execution failed: ${row.result}`);
        return text(`Queued for user approval: action ${row.id} [${row.type}] ${row.preview}`);
      } catch (err) {
        return text(`Gate refused: ${(err as Error).message}`);
      }
    },
  );

  return createSdkMcpServer({
    name: "aios",
    version: "0.1.0",
    tools: [runPlaybook, jobStatus, listPlaybooks, askSpecialist, vaultWrite, vaultRead, vaultList, proposeAction],
  });
}
