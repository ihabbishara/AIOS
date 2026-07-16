// ui2/src/views/Skills.tsx — skills manager: list + usage, SKILL.md editor, url prefill,
// agent assignment (spec 2026-07-15 skills-manager).
import { useState } from "react";
import { api } from "../api.js";
import type { SkillView } from "../api.js";
import { useFetch } from "../hooks.js";
import { SectionLabel, Empty, Button, Tag } from "../components/ui.js";
import { TwoStepButton } from "../components/TwoStepButton.js";

const TEMPLATE = `---
name: my-skill
description: When should an agent reach for this skill
---

# My Skill

Instructions the agent follows when the skill loads.
`;

function nameFromMd(md: string): string | null {
  const m = /^---[\s\S]*?\bname:\s*([a-z][a-z0-9-]*)\s*$/m.exec(md);
  return m ? m[1] : null;
}

function Editor({ initialMd, usedBy, agents, onSaved, onDeleted, onToggle }: {
  initialMd: string;
  usedBy: string[];
  agents: string[];
  onSaved: () => void;
  onDeleted: () => void;
  /** Toggle this skill for an agent — parent owns the PATCH (needs the full usage map). */
  onToggle: (agent: string) => void;
}) {
  const [md, setMd] = useState(initialMd);
  const [url, setUrl] = useState("");
  const [err, setErr] = useState<string>();
  const name = nameFromMd(md);
  const save = () => {
    if (!name) { setErr("frontmatter needs a valid name (a-z, 0-9, -)"); return; }
    api.saveSkill(name, md).then(() => { setErr(undefined); onSaved(); }).catch((e) => setErr((e as Error).message));
  };
  return (
    <div className="flex flex-col gap-2 py-2">
      <div className="flex items-center gap-2">
        <input className="bg-transparent border border-line rounded px-2 py-1 flex-1" placeholder="https://… (prefill editor from URL)"
          value={url} onChange={(e) => setUrl(e.target.value)} />
        <Button disabled={!url.trim()} onClick={() =>
          api.fetchSkill(url).then((r) => { setMd(r.md); setErr(undefined); }).catch((e) => setErr((e as Error).message))
        }>Fetch → editor</Button>
      </div>
      <textarea className="bg-transparent border border-line rounded px-2 py-1 min-h-64 font-mono text-xs"
        aria-label="skill markdown" value={md} onChange={(e) => setMd(e.target.value)} />
      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="primary" onClick={save}>Save</Button>
        {name && (
          <TwoStepButton
            label={usedBy.length ? `Delete — used by ${usedBy.length}` : "Delete"}
            onConfirm={() => api.deleteSkill(name, usedBy.length > 0).then(onDeleted).catch((e) => setErr((e as Error).message))}
          />
        )}
      </div>
      {name && agents.length > 0 && (
        <div className="mt-2">
          <SectionLabel>Assigned agents</SectionLabel>
          <div className="flex flex-wrap gap-3 mt-1">
            {agents.map((a) => (
              <label key={a} className="flex items-center gap-1 text-sm text-fg">
                <input type="checkbox" checked={usedBy.includes(a)} onChange={() => onToggle(a)} />
                {a}
              </label>
            ))}
          </div>
        </div>
      )}
      {err && <div className="text-err text-xs">{err}</div>}
    </div>
  );
}

export function Skills() {
  const { data: skills, error, reload } = useFetch(() => api.skills(), []);
  const { data: state } = useFetch(() => api.state(), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [editorMd, setEditorMd] = useState<string | null>(null);
  const [err, setErr] = useState<string>();

  if (error) return <Empty>{error}</Empty>;
  if (!skills) return <Empty>Loading…</Empty>;
  const open = (s: SkillView) => {
    setSelected(s.name);
    setEditorMd(null);
    api.skillMd(s.name).then((r) => setEditorMd(r.md)).catch((e) => setErr((e as Error).message));
  };
  const sel = skills.find((s) => s.name === selected);
  const agents = (state?.agents ?? []).map((a) => a.name);
  // Assignment toggle: PATCH the agent's FULL skill list, recomputed from the live usage map.
  const toggle = (agent: string) => {
    if (!sel) return;
    const current = skills.filter((s) => s.usedBy.includes(agent)).map((s) => s.name);
    const next = current.includes(sel.name) ? current.filter((n) => n !== sel.name) : [...current, sel.name];
    api.setAgentSkills(agent, next).then(reload).catch((e) => setErr((e as Error).message));
  };
  return (
    <div className="flex-1 overflow-y-auto px-4 py-3 max-w-4xl w-full mx-auto">
      <div className="flex items-center gap-2">
        <SectionLabel>Skills</SectionLabel>
        <span className="flex-1" />
        <Button onClick={() => { setSelected(null); setEditorMd(TEMPLATE); }}>New skill</Button>
      </div>
      {skills.length === 0 && <Empty>No skills yet.</Empty>}
      {skills.map((s) => (
        <div key={s.name} className="flex items-center gap-2 py-1.5 border-b border-line cursor-pointer"
          onClick={() => open(s)}>
          <span className="text-bright">{s.name}</span>
          <span className="text-dim text-xs flex-1 truncate">{s.description}</span>
          {s.usedBy.map((a) => (
            <a key={a} href={`#/staff/agents/${encodeURIComponent(a)}`} onClick={(e) => e.stopPropagation()}>
              <Tag tone="agent">{a}</Tag>
            </a>
          ))}
        </div>
      ))}
      {editorMd !== null && (
        <div className="mt-4">
          <SectionLabel>{sel ? `Edit: ${sel.name}` : "New skill"}</SectionLabel>
          <Editor key={sel?.name ?? "new"} initialMd={editorMd} usedBy={sel?.usedBy ?? []} agents={agents} onToggle={toggle}
            onSaved={() => { setEditorMd(null); setSelected(null); reload(); }}
            onDeleted={() => { setEditorMd(null); setSelected(null); reload(); }} />
        </div>
      )}
      {err && <div className="text-err text-xs mt-2">{err}</div>}
    </div>
  );
}
