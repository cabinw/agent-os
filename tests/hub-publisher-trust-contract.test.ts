import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const adr = readFileSync(
  "docs/decisions/ADR-045-offline-publisher-signatures.md",
  "utf8",
);
const deploy = readFileSync("deploy/README.md", "utf8");

describe("offline publisher trust contract", () => {
  it("places the trust anchor and launcher outside candidate artifacts", () => {
    expect(adr).toContain("/etc/agent-os/publisher/root-v1.pem");
    expect(adr).toContain("/usr/libexec/agent-os/publisher/verify");
    expect(adr).toContain("Running `bootstrap-admin.sh` directly");
    expect(adr).toContain("No CLI option or environment variable can replace");
  });

  it("defines bounded signed policy and artifact frames", () => {
    expect(adr).toContain("agent-os-publisher-policy-v1");
    expect(adr).toContain("agent-os-publisher-envelope-v1");
    expect(adr).toContain("detached root signature is exactly 64 raw Ed25519 bytes");
    expect(adr).toMatch(/publisher\s+signature is exactly 64 raw Ed25519 bytes/u);
  });

  it("requires monotonic rotation, revocation and same-descriptor publication", () => {
    for (const requirement of [
      "greatest accepted epoch, policy SHA-256",
      "same epoch",
      "Revocation takes effect",
      "copy from that same descriptor",
      "Verification is repeated after taking the deployment lock",
      "separate durable acceptance record",
      "same-sequence fork is",
      "greatest trusted wall-clock second",
    ]) {
      expect(adr).toContain(requirement);
    }
  });

  it("fixes the verifier execution closure outside candidate runtimes", () => {
    for (const requirement of [
      "statically linked native executable",
      "no script interpreter, dynamic loader",
      "Candidate Node, OpenSSL, PATH",
    ]) {
      expect(adr).toContain(requirement);
    }
    expect(adr).toMatch(/Provisioning authenticates\s+its exact SHA-256/u);
  });

  it("keeps deployment status fail-closed until the launcher exists", () => {
    expect(deploy).toContain("ADR-045 acceptance contract fixed");
    expect(deploy).toContain("remain unimplemented");
    expect(deploy).not.toContain(
      "authenticated release/admin-kit publisher and signature verification | implemented",
    );
  });
});
