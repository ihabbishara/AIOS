import { useMemo } from "react";
import { api, type StoredEvent } from "../api.js";
import { usePoll } from "../hooks.js";

const MODE_HELP: Record<string, string> = {
  dontAsk: "denies anything not in the allowlist",
  bypassPermissions: "sandboxed write role — runs tools without prompting",
  default: "undecided tools route through the role's guard",
};

export function Permissions({ events }: { events: StoredEvent[] }) {
  const lastEvent = useMemo(
    () => events.filter((e) => e.event.type === "permission.changed" || e.event.type === "tool.denied").at(-1)?.id,
    [events],
  );
  const { data, reload } = usePoll(() => api.permissions(), [lastEvent]);
  if (!data) return <div className="text-dim">loading…</div>;

  const propose = async (role: string, tool: string, action: "grant" | "revoke", knownTools?: string[]) => {
    const t = tool.trim();
    if (!t) return;
    if (/\s/.test(t)) {
      alert("Tool name can't contain spaces. Built-ins are exact-case (e.g. Bash, Edit, Skill); MCP tools look like mcp__server__tool.");
      return;
    }
    const unknownGrant = action === "grant" && knownTools !== undefined && !knownTools.includes(t) && !t.startsWith("mcp__");
    const msg = unknownGrant
      ? `"${t}" isn't a known tool for ${role} — the grant will be recorded but do nothing until a tool with that exact name exists. Propose anyway?`
      : `Propose ${action} of "${t}" for ${role}? It queues in Approvals — you approve to apply.`;
    if (!confirm(msg)) return;
    try {
      await api.proposePermission(role, t, action);
      alert("Queued in Approvals — approve there to apply.");
    } catch (e) {
      alert((e as Error).message);
    }
    reload();
  };

  return (
    <div className="flex flex-col gap-4 max-w-3xl">
      <div className="label">Permissions — what each agent may use. Grants go through Approvals.</div>
      {data.map((r) => (
        <div key={r.role} className="hud p-4 boot">
          <div className="flex items-baseline gap-2">
            <div className="text-fg font-display uppercase tracking-widest text-[12px]">{r.role}</div>
            <div className="text-[10px] text-dim" title={MODE_HELP[r.permissionMode] ?? ""}>
              {r.permissionMode}
            </div>
          </div>
          <div className="text-[11px] text-dim mb-2">{r.description}</div>

          <div className="flex flex-wrap gap-1.5 mb-2">
            {r.tools.map((t) => (
              <span
                key={t.name}
                className={`text-[10px] px-1.5 py-0.5 border ${
                  t.source === "granted" ? "border-cyan text-cyan" : "border-line text-dim"
                }`}
              >
                {t.name}
                {t.source === "granted" && " +"}
                <button onClick={() => propose(r.role, t.name, "revoke")} className="ml-1 text-alert hover:text-bright">
                  ×
                </button>
              </span>
            ))}
            {r.revoked.map((t) => (
              <span key={t.name} className="text-[10px] px-1.5 py-0.5 border border-line text-dim line-through">
                {t.name}
                <button onClick={() => propose(r.role, t.name, "grant")} className="ml-1 text-phosphor hover:text-bright no-underline">
                  +
                </button>
              </span>
            ))}
          </div>

          {r.denials.length > 0 && (
            <div className="text-[10px] text-amber mb-2">
              {r.denials.map((d) => (
                <span key={d.tool} className="mr-3">
                  {d.tool} denied {d.count}× (last {d.lastTs.slice(11, 16)}){" "}
                  <button onClick={() => propose(r.role, d.tool, "grant")} className="text-phosphor hover:text-bright">
                    grant
                  </button>
                </span>
              ))}
            </div>
          )}

          <form
            className="flex gap-1.5 items-center"
            onSubmit={(e) => {
              e.preventDefault();
              const input = e.currentTarget.elements.namedItem("tool") as HTMLInputElement;
              propose(r.role, input.value, "grant", r.knownTools);
              input.value = "";
            }}
          >
            <input
              name="tool"
              list={`tools-${r.role}`}
              autoComplete="off"
              placeholder="tool name — pick or type (e.g. Bash)"
              className="bg-panel-2 border border-line text-fg text-[11px] px-2 py-1 flex-1"
            />
            <datalist id={`tools-${r.role}`}>
              {r.knownTools.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <button
              type="submit"
              className="border border-phosphor text-phosphor px-3 py-1 text-[10px] uppercase tracking-widest hover:bg-phosphor hover:text-void transition-colors"
            >
              propose grant
            </button>
          </form>
        </div>
      ))}
    </div>
  );
}
