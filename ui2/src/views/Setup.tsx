// ui2/src/views/Setup.tsx — onboarding wizard shell (spec §1-2): welcome + auth are live,
// the org steps land in the next phase. The server owns the state machine — this view renders
// the step it is handed and posts intents; every transition comes back from the daemon.
import { useEffect, useRef, useState } from "react";
import { api, type FirstJobStatus, type OrgProposalView } from "../api.js";
import { Button } from "../components/ui.js";
import { MiniDag } from "./MiniDag.js";

const STEPS = ["welcome", "auth", "workspace", "interview", "review", "provision", "first-job", "done"];
const LABELS: Record<string, string> = {
  welcome: "Welcome", auth: "Claude account", workspace: "Workspace", interview: "Interview",
  review: "Review org", provision: "Provision", "first-job": "First job", done: "Done",
};

export function Setup({ step, onStepChange }: { step: string; onStepChange: (s: string) => void }) {
  return (
    <div className="h-full overflow-y-auto flex flex-col items-center justify-center gap-6 p-6">
      <Rail step={step} />
      {step === "welcome" && <Welcome onNext={onStepChange} />}
      {step === "auth" && <Auth onNext={onStepChange} />}
      {step === "workspace" && <Workspace onNext={onStepChange} />}
      {step === "interview" && <Interview onNext={onStepChange} />}
      {step === "review" && <Review onNext={onStepChange} />}
      {step === "first-job" && <FirstJob onNext={onStepChange} />}
      {(step === "provision" || step === "done") && (
        <div className="panel w-full max-w-md p-6 flex flex-col gap-3 text-center">
          <div className="text-strong text-[15px]">{LABELS[step] ?? step}</div>
          <p className="leading-relaxed">This step arrives in the next phase.</p>
        </div>
      )}
    </div>
  );
}

/** Where you are in the eight steps — dim ahead, plain behind, bright here. */
function Rail({ step }: { step: string }) {
  const at = STEPS.indexOf(step);
  return (
    <ol className="flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 text-[10px] uppercase tracking-[0.14em]">
      {STEPS.map((s, i) => (
        <li key={s} className="flex items-center gap-2.5">
          <span className={i === at ? "text-strong" : i < at ? "text-fg" : "text-dim"}>{LABELS[s]}</span>
          {i < STEPS.length - 1 && <span className="text-line">/</span>}
        </li>
      ))}
    </ol>
  );
}

function Welcome({ onNext }: { onNext: (s: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const start = () => {
    setBusy(true); setError("");
    api.onboardingAdvance("welcome")
      .then((r) => onNext(r.step))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="panel w-full max-w-md p-6 flex flex-col gap-4 text-center">
      <div className="text-bright text-[19px] font-bold tracking-tight">AIOS</div>
      <p className="leading-relaxed">
        Your always-on team of AI specialists. A few steps: connect your Claude subscription,
        pick a workspace, and build your org.
      </p>
      {error && <div className="text-[12px] text-err">{error}</div>}
      <Button variant="primary" disabled={busy} onClick={start}>{busy ? "…" : "Get started"}</Button>
    </div>
  );
}

function Auth({ onNext }: { onNext: (s: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [noCli, setNoCli] = useState(false);
  const code = "font-mono text-[12px] text-strong bg-bg border border-line rounded-md px-3 py-2 select-all";
  const submit = async () => {
    setBusy(true); setError("");
    try {
      const r = await api.onboardingAuth(value);
      onNext(r.step);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const back = () => {
    setError("");
    api.onboardingBack("welcome")
      .then((r) => onNext(r.step))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  return (
    <div className="panel w-full max-w-md p-6 flex flex-col gap-3">
      <div className="text-strong text-[15px]">Connect your Claude subscription</div>
      <p className="leading-relaxed">
        AIOS runs on your Claude plan — no API key, no per-token billing. In a terminal, run:
      </p>
      <code className={code}>claude setup-token</code>
      <button onClick={() => setNoCli((v) => !v)}
        className="text-[11px] text-dim hover:text-fg underline underline-offset-2 self-start">
        I don't have the claude command
      </button>
      {noCli && <code className={code}>npm i -g @anthropic-ai/claude-code</code>}
      <p className="leading-relaxed">Log in with your normal Claude account, then paste the token:</p>
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && !busy && value.trim() && void submit()}
        placeholder="paste token"
        className="w-full bg-bg border border-line rounded-md px-3 py-2 text-fg outline-none focus:border-dim"
      />
      {error && <div className="text-[12px] text-err">{error}</div>}
      <div className="flex items-center gap-2">
        <Button onClick={back} disabled={busy}>Back</Button>
        <Button variant="primary" className="ml-auto" disabled={busy || !value.trim()} onClick={() => void submit()}>
          {busy ? "Verifying…" : "Verify & continue"}
        </Button>
      </div>
    </div>
  );
}

function Workspace({ onNext }: { onNext: (s: string) => void }) {
  const [mode, setMode] = useState<"builtin" | "custom">("builtin");
  const [path, setPath] = useState("");
  const [subdir, setSubdir] = useState("AIOS");
  // Set only when the server warned. It has already advanced and written the choice by then,
  // so this is an acknowledgement, not a gate — `step` is kept so "use it anyway" is a local
  // move rather than a second POST the wizard would reject as stale.
  const [warning, setWarning] = useState<{ text: string; step: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = () => {
    setBusy(true); setError("");
    api.onboardingWorkspace(mode === "builtin" ? { mode } : { mode, path, subdir })
      .then((r) => {
        if (r.warning) return setWarning({ text: r.warning, step: r.step });
        onNext(r.step);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  // Stepping back re-enters this screen, which is how a warned choice is undone: the env
  // upsert means whatever is chosen next simply overwrites it.
  const pickAnother = () => {
    setBusy(true); setError("");
    api.onboardingBack("workspace")
      .then((r) => { setWarning(null); onNext(r.step); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  // While the warning is up the choice has already been made and written, so every input on the
  // screen is dead until "Pick another folder" reopens it — disabled rather than merely ignored.
  const frozen = warning !== null;

  const radio = (v: "builtin" | "custom", label: string, hint: string) => (
    <label className={`flex items-start gap-2 ${frozen ? "opacity-50" : "cursor-pointer"}`}>
      <input type="radio" name="ws" checked={mode === v} disabled={frozen}
        onChange={() => setMode(v)} className="mt-1" />
      <span>
        <span className="text-strong">{label}</span>
        <span className="block text-[12px] text-dim leading-relaxed">{hint}</span>
      </span>
    </label>
  );

  return (
    <div className="panel w-full max-w-md p-6 flex flex-col gap-4">
      <div className="text-strong text-[15px]">Where should your files live?</div>
      <p className="leading-relaxed">
        Briefs, reports and notes are written as plain markdown. You can read them in AIOS —
        Obsidian is a bonus viewer, not a requirement.
      </p>
      {radio("builtin", "Built-in workspace", "~/AIOS/workspace — created for you.")}
      {radio("custom", "Use my own folder", "An existing Obsidian vault, or any folder you like.")}
      {mode === "custom" && (
        <div className="flex flex-col gap-2">
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/Documents/MyVault"
            disabled={frozen}
            className="w-full bg-bg border border-line rounded-md px-3 py-2 text-fg outline-none focus:border-dim disabled:opacity-50" />
          <input value={subdir} onChange={(e) => setSubdir(e.target.value)} placeholder="AIOS"
            disabled={frozen}
            className="w-full bg-bg border border-line rounded-md px-3 py-2 text-fg outline-none focus:border-dim disabled:opacity-50" />
          <span className="text-[11px] text-dim">AIOS writes only inside that subfolder.</span>
        </div>
      )}
      {error && <div className="text-[12px] text-err">{error}</div>}
      {/* text-dim, not a warning colour: this is advisory — the folder works, it is just a
          worse place to put a vault — and text-err would read as a refusal. */}
      {warning ? (
        <>
          <div className="text-[12px] text-dim leading-relaxed">{warning.text}</div>
          <div className="flex items-center gap-2">
            <Button disabled={busy} onClick={pickAnother}>Pick another folder</Button>
            <Button variant="primary" className="ml-auto" disabled={busy}
              onClick={() => onNext(warning.step)}>Use it anyway</Button>
          </div>
        </>
      ) : (
        <Button variant="primary" disabled={busy || (mode === "custom" && !path.trim())}
          onClick={submit}>{busy ? "Checking…" : "Continue"}</Button>
      )}
    </div>
  );
}

function Gallery({ onNext }: { onNext: (s: string) => void }) {
  const [rows, setRows] = useState<Array<{ name: string; title: string; summary: string }>>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    api.onboardingTemplates()
      .then((r) => setRows(r.templates))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const pick = (name: string) => {
    setBusy(name); setError("");
    api.onboardingPickTemplate(name)
      .then((r) => onNext(r.step))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(""));
  };

  return (
    <div className="panel w-full max-w-2xl p-6 flex flex-col gap-4">
      <div className="text-strong text-[15px]">Pick a starting org</div>
      <p className="leading-relaxed">
        Each one is a working team you can change later — hire, retire, and edit any agent
        once you are in.
      </p>
      {error && <div className="text-[12px] text-err">{error}</div>}
      <div className="grid gap-2 sm:grid-cols-2">
        {rows.map((t) => (
          <button key={t.name} disabled={!!busy} onClick={() => pick(t.name)}
            className="text-left border border-line rounded-md p-3 hover:border-dim disabled:opacity-50">
            <div className="text-strong">{t.title}</div>
            <div className="text-[12px] text-dim leading-relaxed">{t.summary}</div>
            {busy === t.name && <div className="text-[11px] text-dim mt-1">Loading…</div>}
          </button>
        ))}
        {rows.length === 0 && !error && <div className="text-dim text-[12px]">Loading templates…</div>}
      </div>
    </div>
  );
}

function Interview({ onNext }: { onNext: (s: string) => void }) {
  const [turns, setTurns] = useState<Array<{ role: "user" | "architect"; text: string }>>([]);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showGallery, setShowGallery] = useState(false);
  // The priming turn below is a real, billed model call that also commits a turn to the server
  // transcript. StrictMode double-invokes mount effects in dev, and both passes would read an
  // empty transcript before either committed — so the guard is a ref, not the turns state.
  const primed = useRef(false);

  useEffect(() => {
    api.interviewTurns()
      .then((r) => {
        setTurns(r.turns);
        // Nothing said yet: prime the first question so the user is not staring at a blank box.
        if (r.turns.length === 0 && !primed.current) {
          primed.current = true;
          void send("Hello — I'd like to set up my org.", true);
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  async function send(message: string, silent = false) {
    setBusy(true); setError("");
    if (!silent) setTurns((t) => [...t, { role: "user", text: message }]);
    try {
      const r = await api.interviewSay(message);
      if (r.step) return onNext(r.step); // the Architect finished — proposal is stored
      const q = r.question ?? "";
      setTurns((t) => (silent ? [{ role: "architect", text: q }] : [...t, { role: "architect", text: q }]));
    } catch (err) {
      setError((err as Error).message);
      // The server did not commit the failed turn, so drop the optimistic echo too.
      if (!silent) setTurns((t) => t.slice(0, -1));
    } finally {
      setBusy(false);
      setValue("");
    }
  }

  return (
    <div className="panel w-full max-w-2xl p-6 flex flex-col gap-4">
      <div className="text-strong text-[15px]">Tell me about your work</div>
      <p className="leading-relaxed">
        A few questions, then I'll draft an org for you. Nothing is created until you approve it.
      </p>

      <div className="flex flex-col gap-3 max-h-[46vh] overflow-y-auto">
        {turns.map((t, i) => (
          <div key={i} className={t.role === "user" ? "self-end max-w-[80%]" : "max-w-[85%]"}>
            <div className={`rounded-md px-3 py-2 leading-relaxed ${
              t.role === "user" ? "bg-bg border border-line" : "text-fg"}`}>
              {t.text}
            </div>
          </div>
        ))}
        {busy && <div className="text-dim text-[12px]">thinking…</div>}
      </div>

      {error && <div className="text-[12px] text-err">{error}</div>}

      <div className="flex items-center gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && value.trim() && void send(value.trim())}
          placeholder="Type your answer"
          className="flex-1 bg-bg border border-line rounded-md px-3 py-2 text-fg outline-none focus:border-dim"
        />
        <Button variant="primary" disabled={busy || !value.trim()} onClick={() => void send(value.trim())}>
          Send
        </Button>
      </div>

      <div className="flex items-center gap-3 text-[11px]">
        <button onClick={() => { void api.interviewRestart().then(() => setTurns([])); }}
          className="text-dim hover:text-fg underline underline-offset-2">Start over</button>
        <button onClick={() => setShowGallery((v) => !v)}
          className="text-dim hover:text-fg underline underline-offset-2 ml-auto">
          {showGallery ? "Back to the interview" : "Skip — pick a template instead"}
        </button>
      </div>

      {showGallery && <Gallery onNext={onNext} />}
    </div>
  );
}

function EditableField({
  label, value, onSave,
}: { label: string; value: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]); // a redraft replaces this from the server
  return (
    <label className="flex flex-col gap-1">
      <span className="text-dim text-[11px] uppercase tracking-[0.12em]">{label}</span>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft.trim() && draft !== value && onSave(draft.trim())}
        rows={Math.min(6, Math.max(2, Math.ceil(draft.length / 70)))}
        className="w-full bg-bg border border-line rounded-md px-2 py-1.5 text-fg text-[12px] leading-relaxed outline-none focus:border-dim resize-y"
      />
    </label>
  );
}

function Chips({
  label, all, selected, onChange,
}: { label: string; all: string[]; selected: string[]; onChange: (next: string[]) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-dim text-[11px] uppercase tracking-[0.12em]">{label}</span>
      <div className="flex flex-wrap gap-1">
        {all.map((name) => {
          const on = selected.includes(name);
          return (
            <button key={name}
              onClick={() => onChange(on ? selected.filter((s) => s !== name) : [...selected, name])}
              className={`text-[11px] rounded-full px-2 py-0.5 border ${
                on ? "border-dim text-strong" : "border-line text-dim hover:text-fg"}`}>
              {name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Review({ onNext }: { onNext: (s: string) => void }) {
  const [proposal, setProposal] = useState<OrgProposalView | null>(null);
  const [errors, setErrors] = useState<Array<{ name?: string; error: string }>>([]);
  // Two distinct failures: loadError means there is nothing to show, error means the org we
  // ARE showing was rejected. Collapsing them would blank the screen on a rejected provision.
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [catalog, setCatalog] = useState<{ capabilities: string[]; skills: string[] }>({ capabilities: [], skills: [] });
  const [notes, setNotes] = useState<Record<string, string>>({});

  useEffect(() => {
    api.onboardingProposal()
      .then((r) => setProposal(r.proposal))
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => { void api.capabilityCatalog().then(setCatalog).catch(() => {}); }, []);

  const patch = (body: Record<string, unknown>) => {
    api.patchProposal(body)
      .then((r) => setProposal(r.proposal))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  const redraft = async (name: string) => {
    setBusy(true); setError("");
    try {
      const r = await api.redraftAgent(name, notes[name] ?? "");
      setProposal(r.proposal);
      setNotes((n) => ({ ...n, [name]: "" }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const approve = () => {
    setBusy(true); setError(""); setErrors([]);
    api.onboardingProvision()
      .then((r) => {
        if (r.ok) return onNext(r.step);
        // Card errors highlight their agent; the summary covers proposal-level rejections,
        // which belong to no card and would otherwise leave the screen silently unchanged.
        setErrors(r.errors);
        if (r.errors.every((e) => !e.name)) setError(r.message);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  if (loadError) return <div className="panel w-full max-w-md p-6 text-[12px] text-err">{loadError}</div>;
  if (!proposal) return <div className="panel w-full max-w-md p-6 text-dim">Loading your org…</div>;

  const errorFor = (name: string) => errors.find((e) => e.name === name)?.error;

  return (
    <div className="panel w-full max-w-2xl p-6 flex flex-col gap-4">
      <div className="text-strong text-[15px]">Your org</div>
      <p className="leading-relaxed">
        Nothing has been written yet. Read it, then approve — you can change any of it afterwards.
      </p>
      {errors.length > 0 && (
        <div className="text-[12px] text-err">
          This org could not be created. Fix the flagged agents or pick a different template.
        </div>
      )}
      {error && <div className="text-[12px] text-err">{error}</div>}
      {proposal.departments.map((d) => (
        <div key={d.department} className="border border-line rounded-md p-3 flex flex-col gap-2">
          <div className="text-strong">{d.department}</div>
          <div className="text-[12px] text-dim leading-relaxed">{d.mission}</div>
          {proposal.agents.filter((a) => a.department === d.department).map((a) => (
            <details key={a.name} className={`border rounded-md p-2 ${errorFor(a.name) ? "border-err" : "border-line"}`}>
              <summary className="cursor-pointer">
                <span className="text-strong">{a.name}</span>
                <span className="text-dim"> — {a.title} ({a.kind})</span>
              </summary>
              <div className="text-[12px] leading-relaxed flex flex-col gap-2 mt-2">
                <EditableField label="Title" value={a.title}
                  onSave={(v) => patch({ agent: a.name, field: "title", value: v })} />
                <EditableField label="Charter" value={a.charter}
                  onSave={(v) => patch({ agent: a.name, field: "charter", value: v })} />
                <EditableField label="Persona" value={a.persona}
                  onSave={(v) => patch({ agent: a.name, field: "persona", value: v })} />
                <EditableField label="Prompt" value={a.prompt}
                  onSave={(v) => patch({ agent: a.name, field: "prompt", value: v })} />
                <Chips label="Capabilities" all={catalog.capabilities} selected={a.capabilities}
                  onChange={(next) => patch({ agent: a.name, capabilities: next })} />
                <Chips label="Skills" all={catalog.skills} selected={a.skills}
                  onChange={(next) => patch({ agent: a.name, skills: next })} />
                <div className="flex items-center gap-2">
                  <input placeholder="e.g. make this one warmer"
                    value={notes[a.name] ?? ""}
                    onChange={(e) => setNotes((n) => ({ ...n, [a.name]: e.target.value }))}
                    className="flex-1 bg-bg border border-line rounded-md px-2 py-1 text-[12px] outline-none focus:border-dim" />
                  <Button disabled={busy} onClick={() => void redraft(a.name)}>Redraft</Button>
                </div>
              </div>
              {errorFor(a.name) && <div className="text-[12px] text-err mt-1">{errorFor(a.name)}</div>}
            </details>
          ))}
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Button disabled={busy} onClick={() => {
          api.onboardingBack("interview").then((r) => onNext(r.step)).catch(() => {});
        }}>Pick another</Button>
        {proposal.source.kind === "interview" && (
          <Button disabled={busy} onClick={() => {
            setBusy(true); setError("");
            api.regenerate()
              .then((r) => setProposal(r.proposal))
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
              .finally(() => setBusy(false));
          }}>Regenerate</Button>
        )}
        <Button variant="primary" className="ml-auto" disabled={busy} onClick={approve}>
          {busy ? "Creating…" : "Create this org"}
        </Button>
      </div>
    </div>
  );
}

/**
 * The first thing the org ever does. The request is prefilled from the proposal the user already
 * approved, dispatched through the coordinator exactly as a chat message would be, and then
 * watched — one MiniDag per goal it spawns, so this step and the cockpit draw the same pipeline.
 */
function FirstJob({ onNext }: { onNext: (s: string) => void }) {
  const [request, setRequest] = useState("");
  const [job, setJob] = useState<FirstJobStatus | null>(null);
  // Optimistic: /api/state carries `booted` only in setup mode, and a field that has not
  // arrived yet must not flash the failure screen at someone whose daemon is fine.
  const [booted, setBooted] = useState(true);
  const [bootError, setBootError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      // Status first, and only then the proposal: after a reload the job that actually ran
      // beats the suggestion it started from. Seeding from the proposal regardless would show
      // the user a request they had edited away from before sending.
      const s = await api.firstJobStatus().catch(() => null);
      if (s) setJob(s);
      if (s?.request) { setRequest(s.request); return; }
      const p = await api.onboardingProposal().catch(() => null);
      // Functional, not a bare set: this lands after two awaits and the box is editable the
      // whole time, so anything already typed wins.
      if (p) setRequest((cur) => cur || p.proposal.firstJob);
    })();
    api.state()
      .then((s) => { setBooted(s.booted !== false); setBootError(s.bootError ?? ""); })
      .catch(() => {});
  }, []);

  const running = job?.status === "running";

  // Poll only while a dispatch is actually in flight — an idle wizard must not tick forever.
  // The dependency is that boolean and not the job or its status: a poll that answers
  // `running` again must leave the interval alone rather than tear it down and build another.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => { void api.firstJobStatus().then(setJob).catch(() => {}); }, 2000);
    return () => clearInterval(t);
  }, [running]);

  const dispatchFailed = (e: unknown): Promise<void> => {
    const msg = e instanceof Error ? e.message : String(e);
    // Both 409s this endpoint can answer with share a status code, so the message is the only
    // thing that tells them apart. "Already running" is almost always a double-click: the job
    // the user asked for is in flight, so adopt it and watch it rather than reporting a
    // failure they did not cause. "No org yet" is a genuine wrong-state error and stays one.
    if (msg.includes("already running")) {
      return api.firstJobStatus().then(setJob).catch(() => setError(msg));
    }
    setError(msg);
    // A dead daemon answers 400 with the boot error as its message — but so do other 400s, and
    // guessing from the text would be brittle. Ask /api/state which it was: a daemon that is
    // down needs the retry screen, not a red line under a button that will keep failing.
    return api.state().then((s) => {
      if (s.booted === false) { setBooted(false); setBootError(s.bootError ?? msg); setError(""); }
    }).catch(() => {});
  };

  const run = () => {
    const text = request.trim();
    setBusy(true); setError("");
    api.runFirstJob(text)
      // Optimistic, and deliberately not a re-read: the moment the POST is accepted a job is in
      // flight, and the effect above is the only thing that will ever notice it finish. Making
      // that depend on a follow-up GET would leave a dispatched job unwatched whenever that one
      // request hiccups. Built fresh rather than merged so a retry does not show the previous
      // run's reply and error while the new one works; the next poll refills the rest.
      .then(() => setJob((j) => ({ status: "running", request: text, goals: j?.goals ?? [] })))
      .catch(dispatchFailed)
      .finally(() => setBusy(false));
  };

  const retryBoot = () => {
    setBusy(true); setError("");
    api.onboardingBoot()
      .then((r) => { setBooted(r.booted); setBootError(r.error ?? ""); })
      // A refused boot answers 500, and request() turns every non-2xx into a throw — so the new
      // boot error arrives here, not on the resolved path. It replaces the old one: two red
      // lines saying the same thing read as two separate faults.
      .catch((e: unknown) => setBootError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  // Never disabled, on either screen: a first job that flops — or a daemon that will not start
  // — must never trap the user in the wizard. The failure is not swallowed either, because a
  // Continue that silently does nothing is the very trap this button exists to prevent.
  const advance = () => {
    setError("");
    api.onboardingAdvance("first-job")
      .then((r) => onNext(r.step))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  if (!booted) {
    return (
      <div className="panel w-full max-w-md p-6 flex flex-col gap-3">
        <div className="text-strong text-[15px]">Your org was created</div>
        <p className="leading-relaxed">
          The agents are on disk, but the daemon could not start. Nothing is lost — try again,
          or move on and start it later.
        </p>
        {bootError && <div className="text-[12px] text-err">{bootError}</div>}
        {error && <div className="text-[12px] text-err">{error}</div>}
        <div className="flex items-center gap-2">
          <Button variant="primary" disabled={busy} onClick={retryBoot}>
            {busy ? "Starting…" : "Try again"}
          </Button>
          <Button className="ml-auto" onClick={advance}>Skip for now</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="panel w-full max-w-2xl p-6 flex flex-col gap-4">
      <div className="text-strong text-[15px]">Give your org its first job</div>
      <p className="leading-relaxed">
        This is what your team suggested. Change it to anything you like — it goes to your
        coordinator exactly as if you had typed it in chat.
      </p>
      <textarea value={request} onChange={(e) => setRequest(e.target.value)} rows={3} disabled={running}
        aria-label="first job"
        className="w-full bg-bg border border-line rounded-md px-3 py-2 text-fg text-[13px] leading-relaxed outline-none focus:border-dim resize-y disabled:opacity-60" />
      {error && <div className="text-[12px] text-err">{error}</div>}

      {job && job.status !== "idle" && (
        <div className="border border-line rounded-md p-3 flex flex-col gap-3">
          <div className="text-[11px] uppercase tracking-[0.12em] text-dim">
            {job.status === "running" ? "Working…" : job.status === "failed" ? "Did not finish" : "Result"}
          </div>
          {job.reply && <div className="text-[13px] leading-relaxed whitespace-pre-wrap">{job.reply}</div>}
          {/* An interrupted job — the daemon restarted mid-turn — arrives here as `failed` with
              a message that says so. It takes the same path as any other failure because it is
              retryable in exactly the same way. */}
          {job.error && <div className="text-[12px] text-err">{job.error}</div>}
          {job.goals.map((g) => (
            <div key={g.id} className="flex flex-col gap-1">
              <div className="text-[12px]"><span className="text-strong">{g.title}</span>
                <span className="text-dim"> — {g.status}</span></div>
              {g.nodes.length > 0 && <MiniDag nodes={g.nodes} />}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button variant="primary" disabled={busy || running || !request.trim()} onClick={run}>
          {running ? "Running…" : job?.status === "failed" ? "Try again"
            : job?.status === "done" ? "Run another" : "Run it"}
        </Button>
        <Button className="ml-auto" onClick={advance}>
          {job?.status === "done" ? "Continue" : "Skip for now"}
        </Button>
      </div>
    </div>
  );
}
