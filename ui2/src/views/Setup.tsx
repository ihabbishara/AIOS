// ui2/src/views/Setup.tsx — onboarding wizard shell (spec §1-2): welcome + auth are live,
// the org steps land in the next phase. The server owns the state machine — this view renders
// the step it is handed and posts intents; every transition comes back from the daemon.
import { useState } from "react";
import { api } from "../api.js";
import { Button } from "../components/ui.js";

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
      {step !== "welcome" && step !== "auth" && (
        <div className="panel w-full max-w-md p-6 flex flex-col gap-2 text-center">
          <div className="text-strong text-[15px]">Almost there</div>
          <p className="leading-relaxed">
            Org setup ({LABELS[step] ?? step}) arrives in the next phase. Add agents manually and
            restart the daemon, or wait for the org wizard.
          </p>
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
