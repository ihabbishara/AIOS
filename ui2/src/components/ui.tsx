// ui2/src/components/ui.tsx — Ember primitives (spec §3). Borders over shadows; amber = needs-you only.
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Button({ variant = "ghost", className = "", ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  const styles = {
    primary: "bg-accent text-bg border-accent hover:opacity-90 font-medium",
    ghost: "border-line text-fg hover:border-dim hover:text-strong",
    danger: "border-line text-err hover:border-err",
  }[variant];
  return (
    <button
      className={`border rounded-md px-3 py-1.5 text-[12px] transition-colors disabled:opacity-40 ${styles} ${className}`}
      {...rest}
    />
  );
}

export function Tag({ children, tone = "dim" }: { children: ReactNode; tone?: "dim" | "ok" | "err" | "accent" | "agent" }) {
  const color = {
    dim: "text-dim border-line", ok: "text-ok border-ok/40", err: "text-err border-err/40",
    accent: "text-accent border-accent/40", agent: "text-agent border-agent/40",
  }[tone];
  return <span className={`inline-block border rounded px-1.5 py-px text-[10px] leading-4 whitespace-nowrap ${color}`}>{children}</span>;
}

export function Dot({ tone, breathing }: { tone: "ok" | "err" | "accent" | "agent" | "dim"; breathing?: boolean }) {
  const bg = { ok: "bg-ok", err: "bg-err", accent: "bg-accent", agent: "bg-agent", dim: "bg-dim" }[tone];
  return <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${bg} ${breathing ? "breathe" : ""}`} />;
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
