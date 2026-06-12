// scripts/google-auth.ts — one-time per-account Google OAuth consent.
// Usage: npx tsx scripts/google-auth.ts <accountName>
// Prompts for the OAuth Desktop client id/secret on first run (stored in
// data/google-tokens.json, shared across accounts), opens the consent URL,
// catches the redirect on a localhost loopback port, stores the refresh token.
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { execFile } from "node:child_process";
import { google } from "googleapis";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.readonly",
];

const account = process.argv[2];
if (!account) {
  console.error("Usage: npx tsx scripts/google-auth.ts <accountName>   e.g. personal");
  process.exit(1);
}

const tokensPath = join(process.env.AIOS_DATA_DIR ?? join(process.cwd(), "data"), "google-tokens.json");

interface TokensFile {
  clientId: string;
  clientSecret: string;
  accounts: Record<string, { email: string; refreshToken: string }>;
}

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let file: TokensFile = existsSync(tokensPath)
    ? (JSON.parse(readFileSync(tokensPath, "utf8")) as TokensFile)
    : { clientId: "", clientSecret: "", accounts: {} };

  if (!file.clientId || !file.clientSecret) {
    console.log("First run — paste your OAuth Desktop client credentials");
    console.log("(GCP console → APIs & Services → Credentials → Create OAuth client → Desktop app)");
    file.clientId = (await rl.question("Client ID: ")).trim();
    file.clientSecret = (await rl.question("Client secret: ")).trim();
  }
  rl.close();

  // Loopback redirect: random free port.
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const auth = new google.auth.OAuth2(file.clientId, file.clientSecret, redirectUri);
  const url = auth.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES });

  console.log(`\nOpening consent page for account "${account}"…\nIf the browser doesn't open: ${url}\n`);
  execFile("open", [url], () => {});

  const code = await new Promise<string>((resolve, reject) => {
    server.on("request", (req, res) => {
      const u = new URL(req.url ?? "/", redirectUri);
      if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
      const c = u.searchParams.get("code");
      const err = u.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(c ? "<h2>AI-OS connected. You can close this tab.</h2>" : `<h2>Failed: ${err}</h2>`);
      if (c) resolve(c);
      else reject(new Error(`consent failed: ${err}`));
    });
  });
  server.close();

  const { tokens } = await auth.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error("no refresh_token returned — remove the app at myaccount.google.com/permissions and rerun");
  }
  auth.setCredentials(tokens);

  const me = await google.gmail({ version: "v1", auth }).users.getProfile({ userId: "me" });
  const email = me.data.emailAddress ?? "unknown";

  file.accounts[account] = { email, refreshToken: tokens.refresh_token };
  mkdirSync(dirname(tokensPath), { recursive: true });
  writeFileSync(tokensPath, JSON.stringify(file, null, 2), { mode: 0o600 });
  chmodSync(tokensPath, 0o600); // mode only applies on creation — enforce on rewrites too
  console.log(`\n✓ Account "${account}" (${email}) connected. Tokens in ${tokensPath}`);
  console.log("Restart the daemon to start watching this account.");
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
