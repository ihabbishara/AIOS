import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import type { FetchTransactions, HelperOutput } from "./sync.js";

const run = promisify(execFile);

export interface BunqSenseOpts {
  contextPath: string;
  helperPath: string;
  env: string;          // "sandbox" | "production"
  backfillDays: number;
  pythonBin: string;    // e.g. "python3"
}

/** Lifecycle + production fetch for the read-only bunq sense. Mirrors GoogleAccounts. */
export class BunqSense {
  private degradedReason: string | null = null;

  private constructor(private opts: BunqSenseOpts, private ready: boolean, private bootReason: string | null) {}

  static load(opts: BunqSenseOpts): BunqSense {
    if (!existsSync(opts.contextPath)) {
      return new BunqSense(opts, false, `no bunq context at ${opts.contextPath} — run: python3 scripts/bunq-setup.py`);
    }
    return new BunqSense(opts, true, null);
  }

  enabled(): boolean {
    return this.ready;
  }

  degraded(): Array<{ name: string; reason: string }> {
    if (!this.ready) return [{ name: "bunq", reason: this.bootReason ?? "disabled" }];
    return this.degradedReason ? [{ name: "bunq", reason: this.degradedReason }] : [];
  }

  markDegraded(reason: string): void {
    this.degradedReason = reason.slice(0, 120);
  }

  clearDegraded(): void {
    this.degradedReason = null;
  }

  /** Production fetch: spawn the read-only Python helper and parse its JSON. Read-only by construction. */
  fetch: FetchTransactions = async (sinceIdByAccount) => {
    const { stdout } = await run(this.opts.pythonBin, [
      this.opts.helperPath,
      "--env", this.opts.env,
      "--context", this.opts.contextPath,
      "--backfill-days", String(this.opts.backfillDays),
      "--since", JSON.stringify(sinceIdByAccount),
    ], { maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(stdout) as HelperOutput;
  };
}
