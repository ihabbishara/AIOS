import { useState } from "react";
import { api } from "../api.js";
import { useFetch } from "../hooks.js";

export function Config() {
  const { data: entries, reload } = useFetch(() => api.config(), []);
  const { data: playbooks, reload: reloadPbs } = useFetch(() => api.playbooks(), []);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [pbFile, setPbFile] = useState<string | null>(null);
  const [pbYaml, setPbYaml] = useState("");
  const [note, setNote] = useState("");

  const openPb = (file: string, yaml: string) => { setPbFile(file); setPbYaml(yaml); };

  const saveEnv = async (key: string) => {
    await api.saveConfig(key, edits[key] ?? "");
    setNote(`${key} saved — restart to apply`);
    setEdits((e) => { const { [key]: _, ...rest } = e; return rest; });
    reload();
  };

  const savePb = async () => {
    if (!pbFile) return;
    try {
      await api.savePlaybook(pbFile, pbYaml);
      setNote(`${pbFile} saved + hot-reloaded ✓`);
      reloadPbs();
    } catch (err) {
      setNote(`✗ ${(err as Error).message}`);
    }
  };

  const restart = async () => {
    await api.restart();
    setNote("daemon restarting — back in ~10s");
  };

  return (
    <div className="grid grid-cols-2 gap-4 h-full min-h-0">
      {/* Env config */}
      <div className="flex flex-col gap-4 min-h-0">
        <div className="hud p-4 overflow-auto">
          <div className="flex items-center mb-3">
            <span className="label">Environment</span>
            <button
              onClick={restart}
              className="ml-auto text-[10px] border border-amber text-amber px-2 py-1 font-display uppercase tracking-wider hover:bg-amber hover:text-void transition-colors"
            >
              ⟳ Restart daemon
            </button>
          </div>
          {note && <div className="text-[11px] text-phosphor mb-3">{note}</div>}
          {(entries ?? []).map(({ key, secret, set, value }) => (
            <div key={key} className="flex items-center gap-2 py-1.5 border-b border-line/50">
              <span className="text-[11px] text-fg w-56 shrink-0 truncate" title={key}>{key}</span>
              <input
                type={secret ? "password" : "text"}
                defaultValue={secret ? "" : value}
                placeholder={secret ? (set ? "•••••• (set)" : "(empty)") : "(empty)"}
                onChange={(e) => setEdits((ed) => ({ ...ed, [key]: e.target.value }))}
                className="flex-1 bg-void border border-line px-2 py-1 text-[11px] text-fg outline-none focus:border-phosphor"
              />
              {edits[key] !== undefined && (
                <button onClick={() => saveEnv(key)} className="text-[10px] text-phosphor border border-phosphor px-2 py-1">
                  SAVE
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Playbook editor */}
      <div className="hud hud-cyan p-4 flex flex-col min-h-0">
        <div className="label mb-3">Playbooks</div>
        <div className="flex gap-1 flex-wrap mb-3">
          {(playbooks ?? []).map((p) => (
            <button
              key={p.file}
              onClick={() => openPb(p.file, p.yaml)}
              className={`px-2 py-1 text-[11px] border transition-colors ${
                pbFile === p.file ? "border-cyan text-cyan" : "border-line text-dim hover:text-fg"
              }`}
            >
              {p.file}
            </button>
          ))}
        </div>
        {pbFile ? (
          <>
            <textarea
              value={pbYaml}
              onChange={(e) => setPbYaml(e.target.value)}
              spellCheck={false}
              className="flex-1 min-h-0 bg-void border border-line p-3 text-[12px] leading-relaxed text-fg outline-none focus:border-cyan resize-none"
            />
            <button
              onClick={savePb}
              className="mt-3 self-start px-4 py-1.5 border border-cyan text-cyan font-display uppercase tracking-[0.2em] text-[11px] hover:bg-cyan hover:text-void transition-colors"
            >
              Validate + Save
            </button>
          </>
        ) : (
          <div className="text-dim text-[11px]">select a playbook to edit — saves validate against the schema and hot-reload</div>
        )}
      </div>
    </div>
  );
}
