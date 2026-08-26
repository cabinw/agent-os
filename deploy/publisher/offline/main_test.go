package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func abs(t *testing.T, root, name string) string {
	t.Helper()
	return filepath.Join(root, name)
}

func TestOfflineLifecycleProducesVerifierCompatibleFrames(t *testing.T) {
	root := t.TempDir()
	rootPrivate := abs(t, root, "root-private.pem")
	rootPublic := abs(t, root, "root-public.pem")
	publisherPrivate := abs(t, root, "publisher-private.pem")
	publisherPublic := abs(t, root, "publisher-public.pem")
	if err := generate(rootPrivate, rootPublic); err != nil {
		t.Fatal(err)
	}
	if err := generate(publisherPrivate, publisherPublic); err != nil {
		t.Fatal(err)
	}
	policyPath := abs(t, root, "policy-v1")
	policySignature := abs(t, root, "policy-v1.sig")
	specs := keySpecs{{"publisher-a", "active", 100, 1000, publisherPublic}}
	if err := signPolicy(rootPrivate, policyPath, policySignature, 1, zeroHash, specs); err != nil {
		t.Fatal(err)
	}
	policy := mustRead(t, policyPath)
	rootKey := mustPublic(t, rootPublic)
	if !ed25519.Verify(rootKey, policy, mustRead(t, policySignature)) {
		t.Fatal("root signature does not verify")
	}
	if !strings.HasPrefix(string(policy), "agent-os-publisher-policy-v1\nepoch=1\n") || policy[len(policy)-1] != '\n' {
		t.Fatalf("policy is not canonical: %q", policy)
	}

	artifactPath := abs(t, root, "hub.tar.gz")
	if err := os.WriteFile(artifactPath, []byte("release-one"), 0o600); err != nil {
		t.Fatal(err)
	}
	envelopePath := abs(t, root, "hub.envelope")
	envelopeSignature := abs(t, root, "hub.envelope.sig")
	if err := signArtifact(publisherPrivate, artifactPath, envelopePath, envelopeSignature, "hub-release", "publisher-a", 1, 7, 100, 1000); err != nil {
		t.Fatal(err)
	}
	envelope := mustRead(t, envelopePath)
	publisherKey := mustPublic(t, publisherPublic)
	if !ed25519.Verify(publisherKey, envelope, mustRead(t, envelopeSignature)) {
		t.Fatal("publisher signature does not verify")
	}
	digest := sha256.Sum256([]byte("release-one"))
	expected := "agent-os-publisher-envelope-v1\nartifact_type=hub-release\nartifact_sha256=" + hex.EncodeToString(digest[:]) + "\nartifact_bytes=11\nkey_id=publisher-a\npolicy_epoch=1\nsequence=7\nnot_before=100\nexpires_at=1000\n"
	if string(envelope) != expected {
		t.Fatalf("unexpected envelope:\n%s", envelope)
	}
}

func TestPolicySortsKeysAndRejectsDuplicates(t *testing.T) {
	root := t.TempDir()
	private := abs(t, root, "private.pem")
	public := abs(t, root, "public.pem")
	if err := generate(private, public); err != nil {
		t.Fatal(err)
	}
	frame, err := buildPolicy(2, strings.Repeat("a", 64), keySpecs{
		{"publisher-z", "revoked", 100, 1000, public},
		{"publisher-a", "active", 100, 1000, public},
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Index(string(frame), "key=publisher-a|") > strings.Index(string(frame), "key=publisher-z|") {
		t.Fatal("policy keys are not sorted")
	}
	_, err = buildPolicy(2, strings.Repeat("a", 64), keySpecs{
		{"publisher-a", "active", 100, 1000, public},
		{"publisher-a", "revoked", 100, 1000, public},
	})
	if err == nil || err.Error() != "duplicate policy key id" {
		t.Fatalf("duplicate result=%v", err)
	}
}

func TestOutputsAreExclusiveAndInputsRejectLinks(t *testing.T) {
	root := t.TempDir()
	private := abs(t, root, "private.pem")
	public := abs(t, root, "public.pem")
	if err := generate(private, public); err != nil {
		t.Fatal(err)
	}
	if err := generate(private, abs(t, root, "another.pem")); err == nil {
		t.Fatal("existing private output was overwritten")
	}
	linked := abs(t, root, "linked.pem")
	if err := os.Link(public, linked); err != nil {
		t.Fatal(err)
	}
	if _, _, err := parsePublic(linked); err == nil || !strings.Contains(err.Error(), "link count") {
		t.Fatalf("hard-linked input result=%v", err)
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func mustPublic(t *testing.T, path string) ed25519.PublicKey {
	t.Helper()
	block, _ := pem.Decode(mustRead(t, path))
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	key, ok := parsed.(ed25519.PublicKey)
	if !ok {
		t.Fatal("not Ed25519")
	}
	return key
}

func TestPolicyPublicFrameMatchesDigestAndBase64(t *testing.T) {
	root := t.TempDir()
	private := abs(t, root, "private.pem")
	public := abs(t, root, "public.pem")
	if err := generate(private, public); err != nil {
		t.Fatal(err)
	}
	frame, err := buildPolicy(1, zeroHash, keySpecs{{"publisher-a", "active", 100, 1000, public}})
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode(mustRead(t, public))
	digest := sha256.Sum256(block.Bytes)
	expected := "|" + hex.EncodeToString(digest[:]) + "|" + base64.StdEncoding.EncodeToString(block.Bytes) + "\n"
	if !strings.Contains(string(frame), expected) {
		t.Fatal("policy SPKI digest or encoding is wrong")
	}
}
