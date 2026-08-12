// ui2/test/staff-department.test.tsx — growing the org from the cockpit.
//
// POST /api/departments has existed since the onboarding spec and nothing ever called it, so the
// only departments an org could ever have were the ones the architect invented during setup —
// and setup never runs again. These drive the form that finally reaches it.
//
// NOTE: same rules as staff-card.test.tsx — assertions run after the fetch has landed, and never
// under useFakeTimers, which starves React's scheduler so findBy* never resolves.
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Staff } from "../src/views/Staff.js";
import { FakeEventSource } from "./stubs.js";
import type { OrgDepartmentView } from "../src/api.js";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const dept = (department: string): OrgDepartmentView => ({
  department, mission: `${department} mission`, lead: "nova",
  memoDomain: "general", sandbox: false, actions: [], agents: [],
});

type Posted = { path: string; body: Record<string, unknown> };

/** Records POST bodies and lets /api/org change after a successful create. */
function stub(opts: { departments: () => OrgDepartmentView[]; onPost?: (p: Posted) => Response }) {
  const posted: Posted[] = [];
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split("?")[0];
    if (init?.method === "POST") {
      const p = { path, body: JSON.parse(String(init.body)) as Record<string, unknown> };
      posted.push(p);
      return opts.onPost?.(p) ?? new Response(JSON.stringify({ department: p.body.department, agents: [] }), { status: 200 });
    }
    const routes: Record<string, unknown> = {
      "/api/org": opts.departments(),
      "/api/mail/unread": { total: 0, byAgent: {}, pendingUser: 0, userInbox: 0 },
      "/api/packs": [],
      "/api/state": { capabilities: ["memory", "web"] },
      "/api/agents/retired": [],
    };
    if (path in routes) return new Response(JSON.stringify(routes[path]), { status: 200 });
    return new Response(JSON.stringify({ error: `no stub for ${path}` }), { status: 404 });
  }));
  return posted;
}

async function mount() {
  await act(async () => {
    render(
      <Staff
        events={[]}
        route={{ section: "staff", parts: [], query: new URLSearchParams() }}
        onOpenChat={() => {}}
      />,
    );
  });
  // Gate on a department card being on screen, so the org fetch has really landed.
  await screen.findByText("ops mission");
}

const openForm = () => fireEvent.click(screen.getByText("+ new department"));
const field = (placeholder: string, value: string) =>
  fireEvent.change(screen.getByPlaceholderText(new RegExp(placeholder)), { target: { value } });

describe("creating a department from Staff", () => {
  it("sends what the validator needs and shows the department once it exists", async () => {
    let departments = [dept("ops")];
    const posted = stub({ departments: () => departments });
    await mount();

    openForm();
    expect(screen.getByText("New department")).toBeTruthy();
    // Nothing to submit until it would pass the server's own required-field check.
    expect((screen.getByText("Create") as HTMLButtonElement).disabled).toBe(true);

    field("name \\(kebab-case\\)", "finance");
    field("mission", "Own the numbers.");
    fireEvent.click(screen.getByLabelText("memory domain"), {});
    fireEvent.change(screen.getByLabelText("memory domain"), { target: { value: "money" } });
    fireEvent.click(screen.getByText("memory")); // a capability checkbox

    departments = [dept("ops"), dept("finance")];
    await act(async () => { fireEvent.click(screen.getByText("Create")); });

    expect(posted).toHaveLength(1);
    expect(posted[0]!.path).toBe("/api/departments");
    expect(posted[0]!.body).toEqual({
      department: "finance", mission: "Own the numbers.", memoDomain: "money",
      capabilities: ["memory"],
      // Always empty: a department naming a playbook the loader cannot resolve is SILENTLY
      // skipped at load, which would lose the department the user just made.
      playbooks: [],
    });
    // The form closes and the org list is re-read, so the new department is really on screen.
    expect(await screen.findByText("finance mission")).toBeTruthy();
    expect(screen.queryByText("New department")).toBeNull();
  });

  it("interviews, shows what would be added, and writes nothing until asked", async () => {
    let departments = [dept("ops")];
    const replies: Response[] = [
      new Response(JSON.stringify({ done: false, question: "What is going unserved?" }), { status: 200 }),
      new Response(JSON.stringify({
        done: true,
        proposal: {
          departments: [{ department: "finance", mission: "Own the numbers.", memoDomain: "money", capabilities: [], playbooks: [] }],
          agents: [{
            name: "midas", department: "finance", kind: "lead", title: "CFO",
            charter: "Owns the books.", persona: "p", prompt: "x", capabilities: [], skills: [],
          }],
          firstJob: "",
        },
      }), { status: 200 }),
    ];
    const posted = stub({
      departments: () => departments,
      onPost: (p) => {
        if (p.path === "/api/org/grow") return replies.shift()!;
        departments = [dept("ops"), dept("finance")];
        return new Response(JSON.stringify({ ok: true, departments: ["finance"], agents: ["midas"] }), { status: 200 });
      },
    });
    await mount();

    fireEvent.click(screen.getByText("grow with the architect"));
    fireEvent.change(screen.getByLabelText("answer the architect"), { target: { value: "Nobody tracks spend." } });
    await act(async () => { fireEvent.click(screen.getByText("Start")); });
    expect(screen.getByText("What is going unserved?")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("answer the architect"), { target: { value: "Invoices and budgets." } });
    await act(async () => { fireEvent.click(screen.getByText("Answer")); });

    // The review: named, and explicitly not yet written.
    expect(screen.getByText("new department: finance")).toBeTruthy();
    expect(screen.getByText("midas")).toBeTruthy();
    expect(screen.getByText(/Nothing is written until you say so/)).toBeTruthy();
    expect(posted.filter((p) => p.path === "/api/org/grow/apply")).toHaveLength(0);

    // The transcript is what the endpoint is driven by — it is stateless, so the browser owns it.
    const second = posted[1]!.body as { turns: Array<{ role: string; text: string }> };
    expect(second.turns.map((t) => t.text)).toEqual([
      "Nobody tracks spend.", "What is going unserved?", "Invoices and budgets.",
    ]);

    await act(async () => { fireEvent.click(screen.getByText("Add to my org")); });
    expect(posted.at(-1)!.path).toBe("/api/org/grow/apply");
    expect(await screen.findByText(/Added finance, midas/)).toBeTruthy();
    expect(await screen.findByText("finance mission")).toBeTruthy();
  });

  it("surfaces a refused growth instead of pretending it landed", async () => {
    stub({
      departments: () => [dept("ops")],
      onPost: (p) => p.path === "/api/org/grow"
        ? new Response(JSON.stringify({ error: 'agent "nova" already exists' }), { status: 400 })
        : new Response("{}", { status: 200 }),
    });
    await mount();
    fireEvent.click(screen.getByText("grow with the architect"));
    fireEvent.change(screen.getByLabelText("answer the architect"), { target: { value: "more ops" } });
    await act(async () => { fireEvent.click(screen.getByText("Start")); });
    expect(screen.getByText('agent "nova" already exists')).toBeTruthy();
  });

  it("keeps the form open and shows why the server refused", async () => {
    const posted = stub({
      departments: () => [dept("ops")],
      onPost: () => new Response(JSON.stringify({ error: 'department "ops" already exists' }), { status: 400 }),
    });
    await mount();

    openForm();
    field("name \\(kebab-case\\)", "ops");
    field("mission", "Duplicate.");
    await act(async () => { fireEvent.click(screen.getByText("Create")); });

    expect(posted).toHaveLength(1);
    expect(screen.getByText('department "ops" already exists')).toBeTruthy();
    // Still open, still filled in — a refusal the user can act on rather than retype past.
    expect(screen.getByText("New department")).toBeTruthy();
    expect((screen.getByPlaceholderText(/name \(kebab-case\)/) as HTMLInputElement).value).toBe("ops");
  });
});
