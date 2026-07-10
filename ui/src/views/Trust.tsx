import { api, type StoredEvent } from "../api.js";
import { useLiveQuery } from "../hooks.js";
import { T } from "../lib/topics.js";

const STATE_COLOR: Record<string, string> = {
  autonomous: "text-cyan",
  graduating: "text-amber",
  supervised: "text-dim",
};

export function Trust({ events }: { events: StoredEvent[] }) {
  const { data, reload } = useLiveQuery(() => api.trust(), events, T.trust);
  if (!data) return <div className="text-dim">loading…</div>;

  const demote = async (type: string) => {
    if (!confirm(`Demote ${type} back to supervised?`)) return;
    try {
      await api.demoteTrust(type);
    } catch (e) {
      alert((e as Error).message);
    }
    reload();
  };

  return (
    <div className="max-w-3xl">
      <div className="label mb-3">Trust ledger — autonomy is earned, never assumed</div>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="label text-left">
            <th className="pb-2">Action type</th>
            <th>State</th>
            <th>✓</th>
            <th>✗</th>
            <th>Streak</th>
            <th>Last rejection</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.map((t) => (
            <tr key={t.actionType} className="border-t border-line">
              <td className="py-2 text-fg">{t.actionType}</td>
              <td className={STATE_COLOR[t.state] ?? ""}>{t.state}</td>
              <td>{t.approvals}</td>
              <td>{t.rejections}</td>
              <td>{t.streak}</td>
              <td className="text-dim">{t.lastRejection?.slice(0, 10) ?? "—"}</td>
              <td className="text-right">
                {t.state !== "supervised" && (
                  <button
                    onClick={() => demote(t.actionType)}
                    className="border border-line text-dim px-2 py-1 text-[10px] uppercase hover:text-alert hover:border-alert transition-colors"
                  >
                    demote
                  </button>
                )}
              </td>
            </tr>
          ))}
          {data.length === 0 && (
            <tr>
              <td colSpan={7} className="py-4 text-dim">
                no actions proposed yet
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
