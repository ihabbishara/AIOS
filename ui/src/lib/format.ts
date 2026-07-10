// ui/src/lib/format.ts — shared display formatters (previously re-implemented per view).
export const ts = (iso: string | null | undefined): string =>
  iso ? iso.slice(5, 16).replace("T", " ") : "…";
export const tsTime = (iso: string): string => iso.slice(11, 19);
export const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
export const usdFloat = (v: number, dp = 2): string => `$${v.toFixed(dp)}`;
