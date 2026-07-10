// ui/src/lib/router.ts — minimal hash router. #/zone/seg1/seg2?query — no dependency.
import { useMemo, useSyncExternalStore } from "react";

export interface Route { zone: string; parts: string[]; query: URLSearchParams }

export const ZONES = ["inbox", "work", "staff", "system"] as const;

export function parseHash(hash: string): Route {
  const [path, q] = hash.replace(/^#\/?/, "").split("?");
  const segs = path.split("/").filter(Boolean).map(decodeURIComponent);
  const zone = (ZONES as readonly string[]).includes(segs[0]) ? segs[0] : "inbox";
  return { zone, parts: segs.slice(1), query: new URLSearchParams(q ?? "") };
}

export function href(path: string): string {
  return path.startsWith("#") ? path : `#/${path.replace(/^\//, "")}`;
}

export function navigate(path: string): void {
  window.location.hash = href(path);
}

const subscribe = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

export function useRoute(): Route {
  const raw = useSyncExternalStore(subscribe, () => window.location.hash);
  return useMemo(() => parseHash(raw), [raw]);
}
