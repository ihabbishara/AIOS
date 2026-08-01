// ui2/test/setup-first-job.test.tsx — the wizard's first-job step. The screen is a small state
// machine over one polled endpoint, so these drive it through the transitions that matter:
// seeding, dispatch, the two 409s that share a status code, a dead daemon, and stopping the poll.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { Setup } from "../src/views/Setup.js";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

type Reply = { status?: number; body: unknown };

/** Stub fetch with a "METHOD /path" table. Unlike test/stubs.ts this one carries status codes
 *  and methods, because both 409s and the boot retry are only reachable through them. A route
 *  may answer asynchronously, which is how a reply is held open to order it against a click. */
function stub(routes: Record<string, Reply | (() => Reply | Promise<Reply>)>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input).split("?")[0]}`;
    calls.push(key);
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ error: `no stub for ${key}` }), { status: 404 });
    const r = await (typeof route === "function" ? route() : route);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }));
  return calls;
}

const STATE = { mode: "setup", step: "first-job", booted: true };
const PROPOSAL = {
  proposal: {
    source: { kind: "template", template: "studio" },
    departments: [], agents: [], firstJob: "Draft a launch plan",
  },
};
const NODE = {
  key: "research", type: "task", agent: "iris", critic: null, brief: "look it up",
  deps: [], status: "done", costCents: 12, rounds: 1,
  artifact: null, error: null, startedAt: null, finishedAt: null,
};
const GOAL = {
  id: "g1", slug: "launch", title: "Launch plan", department: "studio", lead: "hermes",
  originChannel: "web", status: "done", planSummary: "", replansUsed: 0, error: null,
  createdAt: "", updatedAt: "", projectDir: null, goalDir: null, nodes: [NODE],
};

const box = () => screen.getByLabelText("first job") as HTMLTextAreaElement;
const btn = (label: string) => screen.getByText(label) as HTMLButtonElement;
const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
/** Same, on real timers: let every settled promise land before asserting. */
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

describe("first-job step", () => {
  it("seeds the box from the approved proposal and shows nothing until it runs", async () => {
    stub({
      "GET /api/onboarding/first-job": { body: { status: "idle", goals: [] } },
      "GET /api/onboarding/proposal": { body: PROPOSAL },
      "GET /api/state": { body: STATE },
    });
    render(<Setup step="first-job" onStepChange={() => {}} />);
    expect((await screen.findByDisplayValue("Draft a launch plan")).tagName).toBe("TEXTAREA");
    expect(screen.queryByText("Result")).toBeNull();
    expect(btn("Run it").disabled).toBe(false);
  });

  it("prefers the request that actually ran over the proposal's suggestion", async () => {
    const calls = stub({
      "GET /api/onboarding/first-job": {
        body: { status: "done", request: "Ship the newsletter", reply: "Done — brief is in the vault.", goals: [GOAL] },
      },
      "GET /api/onboarding/proposal": { body: PROPOSAL },
      "GET /api/state": { body: STATE },
    });
    render(<Setup step="first-job" onStepChange={() => {}} />);
    await screen.findByText("Done — brief is in the vault.");
    expect(box().value).toBe("Ship the newsletter");
    // The suggestion is never even fetched once a real request exists to show.
    expect(calls).not.toContain("GET /api/onboarding/proposal");
    expect(screen.getByText("Launch plan")).toBeTruthy();
    expect(screen.getByText("research")).toBeTruthy(); // MiniDag drew the spawned goal
    expect(btn("Continue").disabled).toBe(false);
  });

  it("dispatches, polls while it works, and stops polling once it settles", async () => {
    let status: Reply = { body: { status: "idle", goals: [] } };
    const calls = stub({
      "GET /api/onboarding/first-job": () => status,
      "POST /api/onboarding/first-job": { body: { status: "running" } },
      "GET /api/onboarding/proposal": { body: PROPOSAL },
      "GET /api/state": { body: STATE },
    });
    const polls = () => calls.filter((c) => c === "GET /api/onboarding/first-job").length;

    render(<Setup step="first-job" onStepChange={() => {}} />);
    await screen.findByDisplayValue("Draft a launch plan");
    expect(polls()).toBe(1);

    vi.useFakeTimers();
    status = { body: { status: "running", request: "Draft a launch plan", goals: [] } };
    fireEvent.click(btn("Run it"));
    await flush();
    expect(screen.getByText("Working…")).toBeTruthy();
    expect(box().disabled).toBe(true);
    // The dispatch is watched off the accepted POST alone — no confirming re-read to hiccup.
    expect(polls()).toBe(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(polls()).toBe(2);
    expect(screen.getByText("Working…")).toBeTruthy();

    status = { body: { status: "done", request: "Draft a launch plan", reply: "All set.", goals: [GOAL] } };
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByText("All set.")).toBeTruthy();

    // The point of the whole effect: a settled wizard must not tick forever.
    const settled = polls();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(polls()).toBe(settled);
  });

  it("adopts the job behind a double-click 409 instead of reporting it as a failure", async () => {
    let status: Reply = { body: { status: "idle", goals: [] } };
    stub({
      "GET /api/onboarding/first-job": () => status,
      // What the server does to the second of two clicks: refuses it, having already accepted
      // and dispatched the first. The job the user wanted is live either way.
      "POST /api/onboarding/first-job": () => {
        status = { body: { status: "running", request: "Draft a launch plan", goals: [] } };
        return { status: 409, body: { error: "a first job is already running" } };
      },
      "GET /api/onboarding/proposal": { body: PROPOSAL },
      "GET /api/state": { body: STATE },
    });
    render(<Setup step="first-job" onStepChange={() => {}} />);
    await screen.findByDisplayValue("Draft a launch plan");
    expect(screen.queryByText("Working…")).toBeNull();

    fireEvent.click(btn("Run it"));
    expect(await screen.findByText("Working…")).toBeTruthy();
    expect(screen.queryByText("a first job is already running")).toBeNull();
  });

  it("surfaces the wrong-step 409, which shares its status code with the harmless one", async () => {
    stub({
      "GET /api/onboarding/first-job": { body: { status: "idle", goals: [] } },
      "POST /api/onboarding/first-job": { status: 409, body: { error: "no org yet — provision one first" } },
      "GET /api/onboarding/proposal": { body: PROPOSAL },
      "GET /api/state": { body: STATE },
    });
    render(<Setup step="first-job" onStepChange={() => {}} />);
    await screen.findByDisplayValue("Draft a launch plan");
    fireEvent.click(btn("Run it"));
    expect(await screen.findByText("no org yet — provision one first")).toBeTruthy();
    expect(screen.queryByText("Working…")).toBeNull();
  });

  it("offers a boot retry when the daemon is down, and still lets the user move on", async () => {
    let booted = false;
    stub({
      "GET /api/onboarding/first-job": { body: { status: "idle", goals: [] } },
      "GET /api/onboarding/proposal": { body: PROPOSAL },
      "GET /api/state": () => ({ body: booted ? STATE : { ...STATE, booted: false, bootError: "no token in .env" } }),
      "POST /api/onboarding/boot": () => (booted ? { body: { booted: true } } : { status: 500, body: { error: "still no token" } }),
    });
    render(<Setup step="first-job" onStepChange={() => {}} />);
    expect(await screen.findByText("no token in .env")).toBeTruthy();
    expect(btn("Try again").disabled).toBe(false);
    expect(btn("Skip for now").disabled).toBe(false); // never a dead end

    // A refused retry answers 500, which arrives as a throw — the new message must land.
    fireEvent.click(btn("Try again"));
    expect(await screen.findByText("still no token")).toBeTruthy();
    expect(screen.queryByText("no token in .env")).toBeNull();

    booted = true;
    fireEvent.click(btn("Try again"));
    expect(await screen.findByDisplayValue("Draft a launch plan")).toBeTruthy();
  });

  it("does not un-watch a job dispatched before the first status read lands", async () => {
    // The narrow race the seeding effect's functional set exists for: type into the still-empty
    // box and dispatch while the mount-time GET is still in flight, and a plain `setJob(s)`
    // would overwrite the running job with the `idle` that read set out to fetch — leaving a
    // real dispatch with nothing polling it.
    let open: () => void = () => {};
    const held = new Promise<void>((r) => { open = r; });
    let first = true;
    stub({
      "GET /api/onboarding/first-job": async () => {
        if (first) { first = false; await held; }
        return { body: { status: "idle", goals: [] } };
      },
      "POST /api/onboarding/first-job": { body: { status: "running" } },
      "GET /api/onboarding/proposal": { body: PROPOSAL },
      "GET /api/state": { body: STATE },
    });
    render(<Setup step="first-job" onStepChange={() => {}} />);
    fireEvent.change(box(), { target: { value: "Do the thing" } });
    fireEvent.click(btn("Run it"));
    expect(await screen.findByText("Working…")).toBeTruthy();

    open();
    await settle();
    expect(screen.getByText("Working…")).toBeTruthy();
    expect(box().value).toBe("Do the thing"); // and the typing survives the proposal seed
  });

  it("shows why Continue failed rather than silently doing nothing", async () => {
    stub({
      "GET /api/onboarding/first-job": {
        body: { status: "done", request: "Draft a launch plan", reply: "All set.", goals: [] },
      },
      "GET /api/state": { body: STATE },
      "POST /api/onboarding/advance": { status: 400, body: { error: "cannot advance from first-job" } },
    });
    render(<Setup step="first-job" onStepChange={() => {}} />);
    await screen.findByText("All set.");
    fireEvent.click(btn("Continue"));
    expect(await screen.findByText("cannot advance from first-job")).toBeTruthy();
  });

  it("keeps Continue live after an interrupted job, and it advances the wizard", async () => {
    const seen: string[] = [];
    stub({
      "GET /api/onboarding/first-job": {
        body: { status: "failed", request: "Draft a launch plan", error: "interrupted — try again", goals: [] },
      },
      "GET /api/onboarding/proposal": { body: PROPOSAL },
      "GET /api/state": { body: STATE },
      "POST /api/onboarding/advance": { body: { step: "done" } },
    });
    render(<Setup step="first-job" onStepChange={(s) => seen.push(s)} />);
    expect(await screen.findByText("interrupted — try again")).toBeTruthy();
    expect(screen.getByText("Did not finish")).toBeTruthy();
    // Interrupted is retryable, and the way out is open either way.
    expect(btn("Try again").disabled).toBe(false);
    expect(box().disabled).toBe(false);
    const skip = btn("Skip for now");
    expect(skip.disabled).toBe(false);
    fireEvent.click(skip);
    await act(async () => { await Promise.resolve(); });
    expect(seen).toEqual(["done"]);
  });
});
