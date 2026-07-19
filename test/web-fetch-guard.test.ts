import { describe, it, expect } from "vitest";
import { isBlockedFetchHost, webFetchPublicChecks } from "../src/agents/guards/web-fetch-public.js";

describe("web-fetch SSRF guard", () => {
  it("blocks loopback, link-local metadata, and RFC1918", () => {
    for (const h of ["localhost", "127.0.0.1", "169.254.169.254", "10.0.0.5", "192.168.1.1", "172.16.0.1", "::1", "foo.local"]) {
      expect(isBlockedFetchHost(h), h).toBe(true);
    }
  });
  it("allows public hosts", () => {
    for (const h of ["example.com", "8.8.8.8", "api.github.com"]) {
      expect(isBlockedFetchHost(h), h).toBe(false);
    }
  });
  it("WebFetch check denies private/loopback + non-http(s), allows public https", () => {
    const { WebFetch } = webFetchPublicChecks();
    expect(WebFetch({ url: "https://example.com/x" }).ok).toBe(true);
    expect(WebFetch({ url: "http://169.254.169.254/latest/meta-data/" }).ok).toBe(false);
    expect(WebFetch({ url: "https://localhost:4280/api" }).ok).toBe(false);
    expect(WebFetch({ url: "file:///etc/passwd" }).ok).toBe(false);
    expect(WebFetch({ url: "not a url" }).ok).toBe(false);
    expect(WebFetch({}).ok).toBe(true); // no url arg → not ours to gate
  });
});
