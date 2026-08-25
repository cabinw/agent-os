# ADR-045: Offline publisher signatures precede privileged artifact use

## Context

Root ownership, safe modes and an operator-supplied SHA-256 prove local byte
identity. They do not identify the publisher. The current cold administrator
bootstrap is itself part of the candidate administrator kit, so code from that
kit cannot authenticate its own origin. Application archives likewise reach
the fixed installer with only a digest assertion.

Publisher verification must not fetch keys, revocation state or time from a
network service. It must survive key overlap and revocation without accepting
an older policy, and verification must remain bound to the bytes later copied
or extracted.

## Decision

### Trust anchor and launcher

Provisioning installs one offline-root Ed25519 public key at
`/etc/agent-os/publisher/root-v1.pem` and one verifier launcher outside every
candidate artifact at `/usr/libexec/agent-os/publisher/verify`. Both paths and
all ancestors are root-owned and non-group/world-writable. The key is a
single-link `0400` regular file; the launcher is a single-link `0555` regular
file. No CLI option or environment variable can replace either production
path.

The launcher is the only entry that may admit a cold or replacement
administrator kit. Running `bootstrap-admin.sh` directly cannot establish
publisher authenticity and is rejected once publisher enforcement is enabled.
Application install and upgrade call the same fixed launcher before archive
copy, extraction, deployment lock or maintenance.

The offline root signs publisher policies, not ordinary artifacts. Root-key
replacement requires a separately reviewed administrator generation containing
the old-root/new-root dual-signature transition. It is never learned from an
artifact or network response.

### Policy

The root-signed policy is a bounded canonical ASCII frame:

```text
agent-os-publisher-policy-v1
epoch=<positive decimal>
previous_policy_sha256=<64 lowercase hex or 64 zeroes>
key=<key-id>|<active|revoked>|<not-before>|<not-after>|<spki-sha256>|<base64-spki>
...
```

Lines are LF terminated, keys are sorted by bytewise key id, identifiers are
lowercase `[a-z0-9-]{1,48}`, timestamps are UTC seconds and duplicate fields or
keys are invalid. The detached root signature is exactly 64 raw Ed25519 bytes.
Policy, signature and the durable accepted-policy record are root-only,
single-link regular files.

The durable record pins the greatest accepted epoch and policy SHA-256. A lower
epoch, a different policy at the same epoch, a broken predecessor link or a
revoked/expired/not-yet-active publisher key fails closed. A newer policy is
published candidate→file fsync→rename→directory fsync only after its root
signature and predecessor are verified. At least two publisher keys may overlap
during rotation. Revocation takes effect at the first accepted policy carrying
it; retaining an older artifact signature cannot bypass that state.

### Artifact envelope

Every administrator-kit archive and application-release archive has a
detached canonical envelope:

```text
agent-os-publisher-envelope-v1
artifact_type=<admin-kit|hub-release>
artifact_sha256=<64 lowercase hex>
artifact_bytes=<positive decimal>
key_id=<publisher key id>
policy_epoch=<positive decimal>
sequence=<positive decimal>
not_before=<UTC seconds>
expires_at=<UTC seconds>
```

The final LF is mandatory and no additional line is allowed. The publisher
signature is exactly 64 raw Ed25519 bytes over those envelope bytes. Envelope
and signature size are bounded to 1 KiB and 64 bytes. Logs and evidence contain
only artifact type, policy epoch, key id, sequence, byte count, SHA-256 and
result code; PEM, envelope bytes and signatures are never logged.

### Verification and publication order

The fixed launcher performs these steps before any privileged candidate is
published:

1. reject inherited Node/OpenSSL/TLS injection and validate fixed executable,
   trust-anchor, policy, envelope, signature and artifact paths;
2. parse the complete policy/envelope grammar before artifact reads;
3. verify the policy under the offline root and enforce the durable epoch/hash
   high-water mark, key status and validity interval;
4. open the artifact once with no-follow semantics, require a single-link
   regular file, capture device/inode/size and hash exactly `artifact_bytes`;
5. verify the envelope digest/type/epoch and publisher signature;
6. rewind and copy from that same descriptor into an administrator-only
   `O_EXCL` staging file while hashing again, fsync the file, and require both
   hashes plus final descriptor identity/size to match;
7. publish the staged copy by rename and parent-directory fsync; only that copy
   may be extracted or used as an administrator-kit source.

Path replacement, truncation, append, inode/device change, short read, policy
change or clock/epoch ambiguity before publication rejects and removes only the
owned candidate. Verification is repeated after taking the deployment lock.

### Acceptance gate

The implementation is not accepted until focused tests prove:

- valid signatures for both artifact types and both keys in an overlap window;
- wrong key, signature, digest, size, type, epoch, sequence and validity time;
- revoked key, policy rollback, same-epoch fork, missing predecessor and root
  signature failure;
- symlink, hardlink, unsafe ancestor, special file and oversized metadata;
- replace/truncate/append/inode-swap after the first hash and during copy;
- candidate/file/directory fsync failure and SIGKILL at each publication phase;
- zero extraction, lock, maintenance, service or administrator-tree mutation on
  every preflight failure; and
- no key, envelope or signature bytes in stdout, stderr, journal or evidence.

Target Ubuntu evidence must start from a root-owned offline bundle and run with
network disabled. Test-only keys never enter a production admin tree.

## Alternatives

**Let the candidate bootstrap verify itself.** Rejected: candidate code can
return success without checking a signature.

**Fetch current keys or revocations online.** Rejected: availability and a
mutable remote response would control privileged admission.

**Sign only a caller-supplied checksum.** Rejected: it does not bind artifact
type, size, policy epoch, sequence or the bytes copied after verification.

**Use long-lived single publisher keys.** Rejected: there is no bounded overlap
or durable revocation path.

## Consequences

Publisher trust becomes a host-provisioning dependency distinct from artifact
delivery. Existing bootstrap/install commands remain staging-only until the
fixed launcher, policy high-water store and same-descriptor publisher are
implemented and tested. This ADR does not retroactively authenticate already
installed artifacts.
