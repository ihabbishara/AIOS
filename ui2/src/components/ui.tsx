// ui2/src/components/ui.tsx — Command Deck primitives. Amber = needs-you only; depth via .card/.panel.
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Button({ variant = "ghost", className = "", ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  const styles = {
    primary: "bg-accent text-bg border-accent hover:opacity-90 font-semibold",
    ghost: "border-line text-fg hover:border-dim hover:text-strong bg-transparent",
    danger: "bg-err text-bg border-err hover:opacity-90 font-semibold",
  }[variant];
  return (
    <button
      className={`border rounded-md px-3 py-1.5 text-[12px] transition-all disabled:opacity-40 ${styles} ${className}`}
      {...rest}
    />
  );
}

export function Tag({ children, tone = "dim" }: { children: ReactNode; tone?: "dim" | "ok" | "err" | "accent" | "agent" | "info" }) {
  const color = {
    dim: "text-dim border-line bg-transparent",
    ok: "text-ok border-ok/30 bg-ok/5",
    err: "text-err border-err/30 bg-err/5",
    accent: "text-accent border-accent/30 bg-accent-bg",
    agent: "text-agent border-agent/30 bg-agent/5",
    info: "text-info border-info/30 bg-info/5",
  }[tone];
  return <span className={`inline-block border rounded-full px-2 py-px text-[10px] leading-4 font-mono whitespace-nowrap ${color}`}>{children}</span>;
}

export function Dot({ tone, breathing }: { tone: "ok" | "err" | "accent" | "agent" | "dim" | "info"; breathing?: boolean }) {
  const bg = { ok: "bg-ok", err: "bg-err", accent: "bg-accent", agent: "bg-agent", dim: "bg-dim", info: "bg-info" }[tone];
  return <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${bg} ${breathing ? "breathe" : ""}`} />;
}

/** Initials avatar — violet ring while working, amber only when the agent owns a needs-you item.
 *  Three letters: two never disambiguate this roster (athena/atlas, minos/midas, juno/jasmine). */
export function Avatar({ name, tone = "dim" }: { name: string; tone?: "dim" | "agent" | "accent" | "ok" | "err" }) {
  const color = {
    dim: "text-dim bg-raised border-line", agent: "text-agent bg-agent/10 border-agent/30",
    accent: "text-accent bg-accent-bg border-accent/30", ok: "text-ok bg-ok/10 border-ok/30",
    err: "text-err bg-err/10 border-err/30",
  }[tone];
  return (
    <span className={`inline-flex items-center justify-center w-[26px] h-[26px] rounded-full border font-mono text-[8.5px] font-bold lowercase tracking-tight shrink-0 ${color}`}>
      {name.slice(0, 3)}
    </span>
  );
}

/** Shared page header: title · mono meta · right-aligned actions. Keeps every section's
 *  first line identical so the app reads as one product. */
export function PageHeader({ title, meta, children }: { title: string; meta?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 mb-5 flex-wrap min-h-8">
      <h1 className="text-[19px] font-bold text-bright tracking-tight">{title}</h1>
      {meta && <span className="text-[11.5px] text-dim font-mono">{meta}</span>}
      {children && <span className="ml-auto flex items-center gap-2">{children}</span>}
    </div>
  );
}

/** Plan progress at a glance: one segment per node, colored by that node's status. */
export function Segments({ statuses }: { statuses: string[] }) {
  const bg: Record<string, string> = { ok: "bg-ok", err: "bg-err", accent: "bg-accent", agent: "bg-agent breathe", dim: "bg-line" };
  return (
    <span className="flex gap-[3px] items-center">
      {statuses.map((st, i) => (
        <span key={i} title={st} className={`h-[5px] flex-1 min-w-1.5 max-w-6 rounded-[2px] ${bg[toneOfStatus(st)]}`} />
      ))}
    </span>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="label mb-2">{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="text-dim py-6">{children}</div>;
}

/** One shared status→tone map so goal/node/mail/action states color identically everywhere. */
export function toneOfStatus(status: string): "ok" | "err" | "accent" | "agent" | "dim" {
  if (status === "running" || status === "done" || status === "ok" || status === "executed") return "ok";
  if (status === "failed" || status === "error" || status === "refused" || status === "rejected") return "err";
  if (["awaiting-human", "awaiting-mail", "paused-user", "paused-budget", "paused-api", "paused-session", "proposed", "unread"].includes(status)) return "accent";
  if (status === "planning" || status === "replanning" || status === "working" || status === "executing") return "agent";
  return "dim";
}
