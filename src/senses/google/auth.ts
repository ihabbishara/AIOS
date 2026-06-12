// src/senses/google/auth.ts
import { existsSync, readFileSync } from "node:fs";
import { google, type gmail_v1, type calendar_v3 } from "googleapis";

export interface TokensFile {
  clientId: string;
  clientSecret: string;
  accounts: Record<string, { email: string; refreshToken: string }>;
}

export interface GoogleAccount {
  name: string;
  email: string;
  gmail: gmail_v1.Gmail;
  calendar: calendar_v3.Calendar;
}

/**
 * Loads data/google-tokens.json (written by scripts/google-auth.ts) and builds
 * one auto-refreshing OAuth2 client per account. Missing/invalid file → senses
 * disabled (voice pattern: one boot log line, nothing else breaks).
 */
export class GoogleAccounts {
  private list: GoogleAccount[] = [];
  private reason = "";
  private degradedMap = new Map<string, string>();

  static load(tokensPath: string): GoogleAccounts {
    const ga = new GoogleAccounts();
    if (!existsSync(tokensPath)) {
      ga.reason = `no google-tokens.json at ${tokensPath} — run: npx tsx scripts/google-auth.ts <account>`;
      return ga;
    }
    let file: TokensFile;
    try {
      file = JSON.parse(readFileSync(tokensPath, "utf8")) as TokensFile;
    } catch (err) {
      ga.reason = `google-tokens.json parse error: ${(err as Error).message}`;
      return ga;
    }
    const names = Object.keys(file.accounts ?? {});
    if (!file.clientId || !file.clientSecret || names.length === 0) {
      ga.reason = "google-tokens.json has no accounts — run: npx tsx scripts/google-auth.ts <account>";
      return ga;
    }
    for (const name of names) {
      const acc = file.accounts[name];
      const auth = new google.auth.OAuth2(file.clientId, file.clientSecret);
      auth.setCredentials({ refresh_token: acc.refreshToken });
      ga.list.push({
        name,
        email: acc.email,
        gmail: google.gmail({ version: "v1", auth }),
        calendar: google.calendar({ version: "v3", auth }),
      });
    }
    return ga;
  }

  enabled(): boolean {
    return this.list.length > 0;
  }

  disabledReason(): string {
    return this.reason;
  }

  accounts(): GoogleAccount[] {
    return this.list;
  }

  get(name: string): GoogleAccount | undefined {
    return this.list.find((a) => a.name === name);
  }

  markDegraded(name: string, reason: string): void {
    this.degradedMap.set(name, reason);
  }

  clearDegraded(name: string): void {
    this.degradedMap.delete(name);
  }

  isDegraded(name: string): boolean {
    return this.degradedMap.has(name);
  }

  degraded(): Array<{ name: string; reason: string }> {
    return [...this.degradedMap.entries()].map(([name, reason]) => ({ name, reason }));
  }
}
