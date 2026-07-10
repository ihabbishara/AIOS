// ui/src/views/Governance.tsx — the earned-autonomy pipeline in one place:
// trust ledger (top) + per-role permissions (bottom). Grants queue in Inbox→Approvals.
import { useState } from "react";
import { api, type StoredEvent } from "../api.js";
import { useLiveQuery } from "../hooks.js";
import { T } from "../lib/topics.js";
import { ConfirmButton } from "../components/ConfirmButton.js";

const STATE_COLOR: Record<string, string> = {
  autonomous: "text-cyan", graduating: "text-amber", supervised: "text-dim",
};

const MODE_HELP: Record<string, string> = {
  dontAsk: "denies anything not in the allowlist",
  bypassPermissions: "sandboxed write role — runs tools without prompting",
  default: "undecided tools route through the role's guard",
};

export function Governance({ events }: { events: StoredEvent[] }) {
  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <TrustSection events={events} />
      <PermissionsSection events={events} />
    </div>
  );
}

function TrustSection({ events }: { events: StoredEvent[] }) {
  const { data, reload } = useLiveQuery(() => api.trust(), events, T.trust);
  const [msg, setMsg] = useState<string | null>(null);
  if (!data) return <div className="text-dim">loading…</div>;

  const demote = async (type: string) => {
    try { await api.demoteTrust(type); } catch (e) { setMsg((e as Error).message); }
    reload();
  };

  return (
    <section>
      <div className="label mb-3">Trust ledger — autonomy is earned, never assumed</div>
      {msg && <div className="text-[11px] text-alert mb-2">{msg}</div>}
      <table className="w-full text-[12px]">
        <thead>
          <tr className="label text-left">
            <th className="pb-2">Action type</th><th>State</th><th>✓</th><th>✗</th>
            <th>Streak</th><th>Last rejection</th><th />
          </tr>
        </thead>
        <tbody>
          {data.map((t) => (
            <tr key={t.actionType} className="border-t border-line">
              <td className="py-2 text-fg">{t.actionType}</td>
              <td className={STATE_COLOR[t.state] ?? ""}>{t.state}</td>
              <td>{t.approvals}</td><td>{t.rejections}</td><td>{t.streak}</td>
              <td className="text-dim">{t.lastRejection?.slice(0, 10) ?? "—"}</td>
              <td className="text-right">
                {t.state !== "supervised" && (
                  <ConfirmButton label="demote" alert onConfirm={() => demote(t.actionType)} />
                )}
              </td>
            </tr>
          ))}
          {data.length === 0 && (
            <tr><td colSpan={7} className="py-4 text-dim">no actions proposed yet</td></tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function PermissionsSection({ events }: { events: StoredEvent[] }) {
  const { data, reload } = useLiveQuery(() => api.permissions(), events, T.permissions);
  const [note, setNote] = useState<string | null>(null);
  if (!data) return <div className="text-dim">loading…</div>;

  const propose = async (role: string, tool: string, action: "grant" | "revoke", knownTools?: string[]) => {
    const t = tool.trim();
    if (!t) return;
    if (/\s/.test(t)) {
      setNote("Tool name can't contain spaces. Built-ins are exact-case (e.g. Bash); MCP tools look like mcp__server__tool.");
      return;
    }
    if (action === "grant" && knownTools !== undefined && !knownTools.includes(t) && !t.startsWith("mcp__")) {
      setNote(`"${t}" isn't a known tool for ${role} — the grant is recorded but does nothing until a tool with that exact name exists.`);
    }
    try {
      await api.proposePermission(role, t, action);
      setNote(`Queued ${action} of "${t}" for ${role} in Inbox → Approvals — approve there to apply.`);
    } catch (e) {
      setNote((e as Error).message);
    }
    reload();
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="label">Permissions — what each agent may use. Grants queue in Inbox → Approvals.</div>
      {note && <div className="text-[11px] text-cyan">{note}</div>}
      {data.map((r) => (
        <div key={r.role} className="hud p-4 boot">
          <div className="flex items-baseline gap-2">
            <div className="text-fg font-display uppercase tracking-widest text-[12px]">{r.role}</div>
            <div className="text-[10px] text-dim" title={MODE_HELP[r.permissionMode] ?? ""}>{r.permissionMode}</div>
          </div>
          <div className="text-[11px] text-dim mb-2">{r.description}</div>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {r.tools.map((t) => (
              <span key={t.name}
                className={`text-[10px] px-1.5 py-0.5 border ${t.source === "granted" ? "border-cyan text-cyan" : "border-line text-dim"}`}>
                {t.name}{t.source === "granted" && " +"}
                <button onClick={() => propose(r.role, t.name, "revoke")} className="ml-1 text-alert hover:text-bright">×</button>
              </span>
            ))}
            {r.revoked.map((t) => (
              <span key={t.name} className="text-[10px] px-1.5 py-0.5 border border-line text-dim line-through">
                {t.name}
                <button onClick={() => propose(r.role, t.name, "grant")} className="ml-1 text-phosphor hover:text-bright no-underline">+</button>
              </span>
            ))}
          </div>
          {r.denials.length > 0 && (
            <div className="text-[10px] text-amber mb-2">
              {r.denials.map((d) => (
                <span key={d.tool} className="mr-3">
                  {d.tool} denied {d.count}× (last {d.lastTs.slice(11, 16)}){" "}
                  <button onClick={() => propose(r.role, d.tool, "grant")} className="text-phosphor hover:text-bright">grant</button>
                </span>
              ))}
            </div>
          )}
          <form className="flex gap-1.5 items-center"
            onSubmit={(e) => {
              e.preventDefault();
              const input = e.currentTarget.elements.namedItem("tool") as HTMLInputElement;
              propose(r.role, input.value, "grant", r.knownTools);
              input.value = "";
            }}>
            <input name="tool" list={`tools-${r.role}`} autoComplete="off"
              placeholder="tool name — pick or type (e.g. Bash)"
              className="bg-panel-2 border border-line text-fg text-[11px] px-2 py-1 flex-1" />
            <datalist id={`tools-${r.role}`}>
              {r.knownTools.map((name) => <option key={name} value={name} />)}
            </datalist>
            <button type="submit"
              className="border border-phosphor text-phosphor px-3 py-1 text-[10px] uppercase tracking-widest hover:bg-phosphor hover:text-void transition-colors">
              propose grant
            </button>
          </form>
        </div>
      ))}
    </section>
  );
}
