// ui2/src/App.tsx — Ember Cockpit shell: 7 sections stay mounted; route picks visibility (old-UI pattern).
import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { useEvents, useFetch, useLiveQuery } from "./hooks.js";
import { T } from "./lib/topics.js";
import { useRoute, navigate } from "./lib/router.js";
import { TopBar } from "./components/TopBar.js";
import { TokenGate } from "./components/TokenGate.js";
import { ChatDrawer } from "./components/ChatDrawer.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { BottomTabs } from "./components/BottomTabs.js";
import { Home } from "./views/Home.js";
import { Goals } from "./views/Goals.js";
import { Staff } from "./views/Staff.js";
import { Mail } from "./views/Mail.js";
import { Schedule } from "./views/Schedule.js";
import { Skills } from "./views/Skills.js";
import { System } from "./views/System.js";

const JUMPS: Record<string, string> = { h: "home", g: "goals", s: "staff", m: "mail", r: "schedule", k: "skills", y: "system" };

export function App() {
  const route = useRoute();
  const { events, connected } = useEvents();
  const { data: state, unauthorized, reload } = useFetch(() => api.state(), []);
  const { data: budget } = useLiveQuery(() => api.budget(), events, T.budget);
  const { data: attention } = useLiveQuery(() => api.attention(), events, T.attention);
  const { data: unread } = useLiveQuery(() => api.mailUnread(), events, T.agentMail);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatTarget, setChatTarget] = useState("neo");
  const [chatSeed, setChatSeed] = useState<string | undefined>();
  const [paletteSignal, setPaletteSignal] = useState(0);
  const pendingG = useRef(false);

  const openChat = (target: string, seed?: string) => {
    setChatTarget(target);
    setChatSeed(seed);
    setChatOpen(true);
  };

  // ⌘J chat toggle + `g then h/g/s/m/r/k/y` section jumps (never while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setChatOpen((v) => !v);
        return;
      }
      if (e.key === "Escape") { setChatOpen(false); return; }
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (pendingG.current && JUMPS[e.key]) {
        pendingG.current = false;
        navigate(JUMPS[e.key]);
        return;
      }
      pendingG.current = e.key === "g";
      if (pendingG.current) setTimeout(() => { pendingG.current = false; }, 800);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (unauthorized) return <TokenGate onSet={reload} />;

  const show = (s: string) => (route.section === s ? "flex-1 min-h-0 flex flex-col pb-14 md:pb-0" : "hidden");

  return (
    <div className="h-full flex flex-col">
      <TopBar
        section={route.section} budget={budget} connected={connected}
        needsYou={attention?.length ?? 0} mailForYou={unread?.userInbox ?? 0}
        onPalette={() => setPaletteSignal((n) => n + 1)} onChat={() => setChatOpen((v) => !v)}
      />
      <div className={show("home")}><Home events={events} attention={attention} onOpenChat={openChat} /></div>
      <div className={show("goals")}><Goals events={events} route={route} onOpenChat={openChat} /></div>
      <div className={show("staff")}><Staff events={events} route={route} onOpenChat={openChat} /></div>
      <div className={show("mail")}><Mail events={events} route={route} /></div>
      <div className={show("schedule")}><Schedule /></div>
      <div className={show("skills")}><Skills /></div>
      <div className={show("system")}><System events={events} route={route} /></div>
      <BottomTabs section={route.section} needsYou={attention?.length ?? 0} />
      {/* Phone has no top-bar chat button — floating entry above the tabs. */}
      {!chatOpen && (
        <button
          onClick={() => setChatOpen(true)}
          aria-label="Open chat"
          className="md:hidden fixed right-4 bottom-[76px] z-30 rounded-full border border-line bg-surface px-4 py-2.5 text-[13px] text-strong shadow-lg shadow-black/30"
        >
          Chat
        </button>
      )}
      <ChatDrawer
        open={chatOpen} onClose={() => setChatOpen(false)} state={state} events={events}
        target={chatTarget} setTarget={setChatTarget} seed={chatSeed}
      />
      <CommandPalette state={state} onOpenChat={openChat} openSignal={paletteSignal} />
    </div>
  );
}
