// test/atlas-guard.test.ts
import { describe, it, expect } from "vitest";
import { atlasMutatingChecks } from "../src/agents/guards/atlas-mutating.js";

const checks = atlasMutatingChecks();
const bash = (command: string) => checks["Bash"]({ command });

const DENIED = [
  "terraform apply -auto-approve",
  "terraform destroy",
  "kubectl apply -f deploy.yaml",
  "kubectl delete pod x",
  "kubectl patch svc x -p '{}'",
  "kubectl drain node-1",
  "git push origin main",
  "helm install app ./chart",
  "helm upgrade app ./chart",
  "helm uninstall app",
  "helm rollback app 1",
  "aws s3 rm s3://bucket/key",
  "aws ec2 terminate-instances --instance-ids i-1",
  // compound smuggling — the pattern scan covers the whole string
  "echo ok && git push origin main",
  "terraform plan; terraform apply",
];

const ALLOWED = [
  "terraform plan",
  "terraform validate",
  "kubectl get pods -A",
  "kubectl describe deploy x",
  "kubectl logs pod-x",
  "git status",
  "git log --oneline",
  "helm list",
  "aws s3 ls s3://bucket",
  "aws ec2 describe-instances",
  "aws sts get-caller-identity",
  "npm test",
];

describe("atlas mutating-CLI guard", () => {
  it("denies every mutating command", () => {
    for (const c of DENIED) expect(bash(c).ok, c).toBe(false);
  });
  it("allows read-only and unrelated commands", () => {
    for (const c of ALLOWED) expect(bash(c).ok, c).toBe(true);
  });
  it("guards the sandbox shell with the same rules", () => {
    expect(checks["mcp__code__sh"]({ command: "git push" }).ok).toBe(false);
    expect(checks["mcp__code__sh"]({ command: "git diff" }).ok).toBe(true);
  });
  it("non-string command is denied fail-closed", () => {
    expect(bash(undefined as never).ok).toBe(false);
    expect(checks["Bash"]({}).ok).toBe(false);
  });
});
