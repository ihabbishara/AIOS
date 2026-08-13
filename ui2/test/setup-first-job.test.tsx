// ui2/test/setup-first-job.test.tsx — the wizard's first-job step and the handover it ends in.
// The screen is a small state machine over one polled endpoint, so these drive it through the
// transitions that matter: seeding, dispatch, the two 409s that share a status code, a dead
// daemon, stopping the poll — and then the last response the wizard ever gets.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { useState } from "react";
import { Setup } from "../src/views/Setup.js";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); });

/** Every way off the done screen is a full page reload, and jsdom has no navigation — so the
 *  reload is recorded rather than performed. What is recorded is the hash at the moment it was
 *  called, because the hash is the whole point: it is what decides where the reload lands. */
function watchReloads(): string[] {
  const seen: string[] = [];
  const loc = { hash: "", reload: () => seen.push(loc.hash) };
  vi.stubGlobal("location", loc);
  return seen;
}

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
    expect(screen.getByText("research")).toBeTruthy(); // Thread drew the spawned goal's node key
    expect(btn("Continue").disabled).toBe(false);
  });

  // The gap a real walk exposed: the coordinator answered in prose, filed a research report in
  // the vault, and the screen mentioned neither the file nor why Goals was empty. The user read
  // that as a job that had vanished.
  it("names the files the job wrote and explains an empty goal list", async () => {
    stub({
      "GET /api/onboarding/first-job": {
        body: {
          status: "done", request: "Research Basel IV", reply: "Here is the briefing.",
          goals: [], wrote: ["research/basel-iv-europe-august-2026.md"],
        },
      },
      "GET /api/state": { body: STATE },
    });
    render(<Setup step="first-job" onStepChange={() => {}} />);
    await screen.findByText("Here is the briefing.");
    expect(screen.getByText("research/basel-iv-europe-august-2026.md")).toBeTruthy();
    expect(screen.getByText(/find these in the Library/)).toBeTruthy();
    expect(screen.getByText(/handled this as a conversation/)).toBeTruthy();
  });

  it("says nothing about conversations when the job actually planned a goal", async () => {
    stub({
      "GET /api/onboarding/first-job": {
        body: { status: "done", request: "Ship it", reply: "On it.", goals: [GOAL], wrote: [] },
      },
      "GET /api/state": { body: STATE },
    });
    render(<Setup step="first-job" onStepChange={() => {}} />);
    await screen.findByText("On it.");
    expect(screen.getByText("Launch plan")).toBeTruthy();
    expect(screen.queryByText(/handled this as a conversation/)).toBeNull();
    expect(screen.queryByText(/Saved to your workspace/)).toBeNull();
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

/** The wizard as the app actually drives it: the parent owns `step` and Setup hands it the next
 *  one. The done screen exists only on the far side of a real transition — rendering it directly
 *  would skip the handover response that is the whole point of it. */
function Wizard({ from }: { from: string }) {
  const [step, setStep] = useState(from);
  return <Setup step={step} onStepChange={setStep} />;
}

const FINISHED = {
  "GET /api/onboarding/first-job": {
    body: { status: "done", request: "Draft a launch plan", reply: "All set.", goals: [] },
  },
  "GET /api/state": { body: STATE },
};

const HANDOVER = {
  step: "done", uiToken: "tok-ui-abc", departments: ["operations", "studio"],
  agents: ["nova", "scout"], workspace: "/Users/tester/AIOS/workspace/AIOS",
};

describe("the handover to mission control", () => {
  it("stores the UI token and names the org that is now on duty", async () => {
    stub({ ...FINISHED, "POST /api/onboarding/advance": { body: HANDOVER } });
    render(<Wizard from="first-job" />);
    await screen.findByText("All set.");
    fireEvent.click(btn("Continue"));

    expect(await screen.findByText("You're set up")).toBeTruthy();
    expect(screen.getByText(/nova, scout are on duty/)).toBeTruthy();
    // The one thing that has to be true before "Open AIOS" reloads the page: mission control
    // answers nothing without this token, and the server that handed it over is already gone.
    expect(localStorage.getItem("aios_token")).toBe("tok-ui-abc");
    expect(screen.getByText("Open AIOS")).toBeTruthy();
  });

  // Spec §5: this screen confirms what was actually created. None of it can be fetched — the
  // setup server let go of the port to answer this very request — so anything missing from the
  // handover body is missing from the screen forever.
  it("confirms the departments, the roster and the folder the work lands in", async () => {
    stub({ ...FINISHED, "POST /api/onboarding/advance": { body: HANDOVER } });
    render(<Wizard from="first-job" />);
    await screen.findByText("All set.");
    fireEvent.click(btn("Continue"));

    await screen.findByText("You're set up");
    expect(screen.getByText("operations, studio")).toBeTruthy();
    expect(screen.getByText("nova, scout")).toBeTruthy();
    // The resolved folder, verbatim: a path the user cannot check against Finder confirms nothing.
    expect(screen.getByText("/Users/tester/AIOS/workspace/AIOS")).toBeTruthy();
  });

  // A reload, not a route change: this is still the wizard, and it does not read the route — so
  // setting the hash alone would leave the user looking at the same screen.
  it("links into the Library, landing there rather than on Home", async () => {
    stub({ ...FINISHED, "POST /api/onboarding/advance": { body: HANDOVER } });
    const reloads = watchReloads();
    render(<Wizard from="first-job" />);
    await screen.findByText("All set.");
    fireEvent.click(btn("Continue"));

    await screen.findByText("You're set up");
    fireEvent.click(screen.getByText(/Read what your team writes/));
    expect(reloads).toEqual(["#/library"]);

    // The other suggested action, and then the plain way in, which sets no section of its own.
    fireEvent.click(screen.getByText(/Meet your agents/));
    expect(reloads[1]).toBe("#/staff");
    fireEvent.click(btn("Open AIOS"));
    expect(reloads[2]).toBe("#/staff"); // whatever the hash already was — never forced back
  });

  // The path the ledger flagged: "Skip for now" past a failed boot reaches `done` with nothing
  // running. Telling that user "You're set up" was the one plainly false thing the wizard said —
  // and every link here would reload straight back onto this same screen, because no mission
  // control ever took the port.
  it("does not claim the user is set up when no daemon ever booted", async () => {
    stub({
      "GET /api/onboarding/first-job": { body: { status: "idle", goals: [] } },
      "GET /api/onboarding/proposal": { body: PROPOSAL },
      "GET /api/state": { body: { ...STATE, booted: false, bootError: "no token in .env" } },
      "POST /api/onboarding/advance": { body: { ...HANDOVER, uiToken: "" } },
    });
    render(<Wizard from="first-job" />);
    await screen.findByText("no token in .env");
    fireEvent.click(btn("Skip for now"));

    expect(await screen.findByText("Your org is ready")).toBeTruthy();
    expect(screen.queryByText("You're set up")).toBeNull();
    expect(screen.getByText(/nobody is on duty yet/)).toBeTruthy();
    // What was created is still true and still worth confirming; what is running is not.
    expect(screen.getByText("operations, studio")).toBeTruthy();
    // No way in is offered, because there is nothing on the other side of one.
    expect(screen.queryByText("Open AIOS")).toBeNull();
    expect(screen.queryByText(/Read what your team writes/)).toBeNull();
  });

  it("still reads as finished when the handover carried no roster", async () => {
    stub({ ...FINISHED, "POST /api/onboarding/advance": { body: { step: "done", uiToken: "tok-ui-bare" } } });
    render(<Wizard from="first-job" />);
    await screen.findByText("All set.");
    fireEvent.click(btn("Continue"));

    expect(await screen.findByText("You're set up")).toBeTruthy();
    expect(screen.getByText(/Your org is on duty/)).toBeTruthy();
    expect(localStorage.getItem("aios_token")).toBe("tok-ui-bare");
  });

  it("reads as one agent when there is one", async () => {
    stub({
      ...FINISHED,
      "POST /api/onboarding/advance": { body: { step: "done", uiToken: "t", agents: ["nova"] } },
    });
    render(<Wizard from="first-job" />);
    await screen.findByText("All set.");
    fireEvent.click(btn("Continue"));
    expect(await screen.findByText(/nova is on duty/)).toBeTruthy();
  });
});
