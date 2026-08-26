import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const adr = readFileSync(
  "docs/decisions/ADR-045-offline-publisher-signatures.md",
  "utf8",
);
const deploy = readFileSync("deploy/README.md", "utf8");
const bootstrap = readFileSync("deploy/hub/bootstrap-admin.sh", "utf8");

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
      "stage_release` repeats SHA-256 verification",
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

  it("records both signed release and cold admin admission boundaries", () => {
    expect(deploy).toContain("Application-release install and upgrade now execute");
    expect(deploy).toContain("SHA-256-only admission is rejected");
    expect(deploy).toContain("Cold admin-kit admission is implemented");
    expect(deploy).toContain("agent-os-publisher-enforcement-v1");
    expect(deploy).toContain("exact 27-file allowlist");
    expect(deploy).toContain(
      "signed release admission and cold admin admission implemented",
    );
    expect(bootstrap).toContain(
      "readonly PUBLISHER_ENFORCEMENT=/etc/agent-os/publisher/enforce",
    );
    expect(bootstrap).toContain("direct bootstrap is disabled by publisher enforcement");
    expect(bootstrap.indexOf("PUBLISHER_ENFORCEMENT")).toBeLessThan(
      bootstrap.indexOf('source "$SCRIPT_DIR/bin/lib.sh"'),
    );
  });
});
