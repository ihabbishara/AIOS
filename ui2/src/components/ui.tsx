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

/** Initials avatar — violet ring while working, amber only when the agent owns a needs-you item. */
export function Avatar({ name, tone = "dim" }: { name: string; tone?: "dim" | "agent" | "accent" | "ok" | "err" }) {
  const color = {
    dim: "text-dim bg-raised border-line", agent: "text-agent bg-agent/10 border-agent/30",
    accent: "text-accent bg-accent-bg border-accent/30", ok: "text-ok bg-ok/10 border-ok/30",
    err: "text-err bg-err/10 border-err/30",
  }[tone];
  return (
    <span className={`inline-flex items-center justify-center w-[22px] h-[22px] rounded-full border text-[9px] font-bold uppercase shrink-0 ${color}`}>
      {name.slice(0, 2)}
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
  if (["awaiting-human", "awaiting-mail", "paused-user", "paused-budget", "proposed", "unread"].includes(status)) return "accent";
  if (status === "planning" || status === "replanning" || status === "working" || status === "executing") return "agent";
  return "dim";
}
