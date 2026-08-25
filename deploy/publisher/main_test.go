//go:build linux

package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type fixture struct {
	t                                   *testing.T
	cfg                                 config
	rootPrivate, publisherA, publisherB ed25519.PrivateKey
	artifact, envelope, signature       string
	policyBytes                         []byte
}

func privateFile(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
}

func publicFrame(t *testing.T, id, status string, private ed25519.PrivateKey) string {
	t.Helper()
	der, err := x509.MarshalPKIXPublicKey(private.Public())
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(der)
	return fmt.Sprintf("key=%s|%s|100|1000|%s|%s\n", id, status, hex.EncodeToString(sum[:]), base64.StdEncoding.EncodeToString(der))
}

func (f *fixture) installPolicy(epoch uint64, previous string, keys ...string) {
	f.t.Helper()
	f.policyBytes = []byte(fmt.Sprintf("agent-os-publisher-policy-v1\nepoch=%d\nprevious_policy_sha256=%s\n%s", epoch, previous, join(keys)))
	privateFile(f.t, f.cfg.policy, f.policyBytes)
	privateFile(f.t, f.cfg.policySig, ed25519.Sign(f.rootPrivate, f.policyBytes))
}

func join(values []string) string {
	result := ""
	for _, value := range values {
		result += value
	}
	return result
}

func (f *fixture) signArtifact(typeName, keyID string, sequence, epoch uint64, private ed25519.PrivateKey, contents []byte) {
	f.t.Helper()
	privateFile(f.t, f.artifact, contents)
	sum := sha256.Sum256(contents)
	frame := fmt.Sprintf("agent-os-publisher-envelope-v1\nartifact_type=%s\nartifact_sha256=%s\nartifact_bytes=%d\nkey_id=%s\npolicy_epoch=%d\nsequence=%d\nnot_before=100\nexpires_at=1000\n", typeName, hex.EncodeToString(sum[:]), len(contents), keyID, epoch, sequence)
	privateFile(f.t, f.envelope, []byte(frame))
	privateFile(f.t, f.signature, ed25519.Sign(private, []byte(frame)))
}

func (f *fixture) signedInput(name, typeName, keyID string, sequence, epoch uint64, private ed25519.PrivateKey, contents []byte) (string, string, string) {
	f.t.Helper()
	artifact := filepath.Join(filepath.Dir(f.artifact), name+".artifact")
	envelopePath := filepath.Join(filepath.Dir(f.artifact), name+".envelope")
	signaturePath := envelopePath + ".sig"
	privateFile(f.t, artifact, contents)
	sum := sha256.Sum256(contents)
	frame := fmt.Sprintf("agent-os-publisher-envelope-v1\nartifact_type=%s\nartifact_sha256=%s\nartifact_bytes=%d\nkey_id=%s\npolicy_epoch=%d\nsequence=%d\nnot_before=100\nexpires_at=1000\n", typeName, hex.EncodeToString(sum[:]), len(contents), keyID, epoch, sequence)
	privateFile(f.t, envelopePath, []byte(frame))
	privateFile(f.t, signaturePath, ed25519.Sign(private, []byte(frame)))
	return artifact, envelopePath, signaturePath
}

func makeFixture(t *testing.T) *fixture {
	t.Helper()
	root := t.TempDir()
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"trust", "input", "state", "state/accepted", "state/staging"} {
		if err := os.Mkdir(filepath.Join(root, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	_, rootPrivate, _ := ed25519.GenerateKey(rand.Reader)
	_, publisherA, _ := ed25519.GenerateKey(rand.Reader)
	_, publisherB, _ := ed25519.GenerateKey(rand.Reader)
	rootDER, _ := x509.MarshalPKIXPublicKey(rootPrivate.Public())
	rootPEM := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: rootDER})
	f := &fixture{t: t, rootPrivate: rootPrivate, publisherA: publisherA, publisherB: publisherB, artifact: filepath.Join(root, "input", "artifact"), envelope: filepath.Join(root, "input", "envelope"), signature: filepath.Join(root, "input", "envelope.sig")}
	f.cfg = config{rootKey: filepath.Join(root, "trust", "root.pem"), policy: filepath.Join(root, "trust", "policy"), policySig: filepath.Join(root, "trust", "policy.sig"), stateRoot: filepath.Join(root, "state"), trustBoundary: root, expectedUID: uint32(os.Getuid()), now: 200}
	privateFile(t, f.cfg.rootKey, rootPEM)
	privateFile(t, filepath.Join(f.cfg.stateRoot, "transaction.lock"), []byte("agent-os-publisher-lock-v1\n"))
	f.installPolicy(1, zeroHash, publicFrame(t, "publisher-a", "active", publisherA))
	f.signArtifact("hub-release", "publisher-a", 1, 1, publisherA, []byte("release-one"))
	return f
}

func TestValidReplayAndPerTypeHighWater(t *testing.T) {
	f := makeFixture(t)
	first, err := verifyArtifact(f.cfg, f.artifact, f.envelope, f.signature, "hub-release")
	if err != nil {
		t.Fatal(err)
	}
	second, err := verifyArtifact(f.cfg, f.artifact, f.envelope, f.signature, "hub-release")
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatal("idempotent retry changed its record")
	}
	f.signArtifact("admin-kit", "publisher-a", 1, 1, f.publisherA, []byte("admin-one"))
	if _, err = verifyArtifact(f.cfg, f.artifact, f.envelope, f.signature, "admin-kit"); err != nil {
		t.Fatal(err)
	}
	f.signArtifact("hub-release", "publisher-a", 2, 1, f.publisherA, []byte("release-two"))
	if _, err = verifyArtifact(f.cfg, f.artifact, f.envelope, f.signature, "hub-release"); err != nil {
		t.Fatal(err)
	}
	f.signArtifact("hub-release", "publisher-a", 1, 1, f.publisherA, []byte("release-one"))
	if _, err = verifyArtifact(f.cfg, f.artifact, f.envelope, f.signature, "hub-release"); err == nil || err.Error() != "artifact_replay" {
		t.Fatalf("replay result=%v", err)
	}
}

func TestRotationAndRevocation(t *testing.T) {
	f := makeFixture(t)
	if _, err := verifyArtifact(f.cfg, f.artifact, f.envelope, f.signature, "hub-release"); err != nil {
		t.Fatal(err)
	}
	prior := sha256.Sum256(f.policyBytes)
	f.installPolicy(2, hex.EncodeToString(prior[:]), publicFrame(t, "publisher-a", "revoked", f.publisherA), publicFrame(t, "publisher-b", "active", f.publisherB))
	f.signArtifact("hub-release", "publisher-b", 2, 2, f.publisherB, []byte("release-two"))
	if _, err := verifyArtifact(f.cfg, f.artifact, f.envelope, f.signature, "hub-release"); err != nil {
		t.Fatal(err)
	}
	f.signArtifact("hub-release", "publisher-a", 3, 2, f.publisherA, []byte("release-three"))
	if _, err := verifyArtifact(f.cfg, f.artifact, f.envelope, f.signature, "hub-release"); err == nil || err.Error() != "artifact_signature_invalid" {
		t.Fatalf("revocation result=%v", err)
	}
}

func TestWrongSignatureAndTOCTOU(t *testing.T) {
	f := makeFixture(t)
	privateFile(t, f.signature, make([]byte, ed25519.SignatureSize))
	if _, err := verifyArtifact(f.cfg, f.artifact, f.envelope, f.signature, "hub-release"); err == nil || err.Error() != "artifact_signature_invalid" {
		t.Fatalf("signature result=%v", err)
	}
	f.signArtifact("hub-release", "publisher-a", 1, 1, f.publisherA, []byte("release-one"))
	f.cfg.afterFirstHash = func() error {
		if err := os.Rename(f.artifact, f.artifact+".old"); err != nil {
			return err
		}
		privateFile(t, f.artifact, []byte("replacement"))
		return nil
	}
	if _, err := verifyArtifact(f.cfg, f.artifact, f.envelope, f.signature, "hub-release"); err == nil || err.Error() != "artifact_changed" {
		t.Fatalf("TOCTOU result=%v", err)
	}
	if _, err := os.Stat(filepath.Join(f.cfg.stateRoot, "accepted", "hub-release")); !os.IsNotExist(err) {
		t.Fatal("TOCTOU advanced acceptance record")
	}
}

func TestConcurrentHighSequenceSerializesBeforeLowSequence(t *testing.T) {
	f := makeFixture(t)
	if _, err := verifyArtifact(f.cfg, f.artifact, f.envelope, f.signature, "hub-release"); err != nil {
		t.Fatal(err)
	}
	highArtifact, highEnvelope, highSignature := f.signedInput("high", "hub-release", "publisher-a", 3, 1, f.publisherA, []byte("release-three"))
	lowArtifact, lowEnvelope, lowSignature := f.signedInput("low", "hub-release", "publisher-a", 2, 1, f.publisherA, []byte("release-two"))
	locked := make(chan struct{})
	release := make(chan struct{})
	highConfig := f.cfg
	highConfig.afterLock = func() error {
		close(locked)
		<-release
		return nil
	}
	var highErr, lowErr error
	var wait sync.WaitGroup
	wait.Add(2)
	go func() {
		defer wait.Done()
		_, highErr = verifyArtifact(highConfig, highArtifact, highEnvelope, highSignature, "hub-release")
	}()
	<-locked
	go func() {
		defer wait.Done()
		_, lowErr = verifyArtifact(f.cfg, lowArtifact, lowEnvelope, lowSignature, "hub-release")
	}()
	close(release)
	wait.Wait()
	if highErr != nil {
		t.Fatalf("high sequence failed: %v", highErr)
	}
	if lowErr == nil || lowErr.Error() != "artifact_replay" {
		t.Fatalf("low sequence result=%v", lowErr)
	}
	record, present, err := readArtifactRecord(filepath.Join(f.cfg.stateRoot, "accepted", "hub-release"), f.cfg)
	if err != nil || !present || record.sequence != 3 {
		t.Fatalf("high-water record=%+v present=%v err=%v", record, present, err)
	}
}

func TestCandidateConflictIsPreserved(t *testing.T) {
	f := makeFixture(t)
	sum := sha256.Sum256([]byte("release-one"))
	candidate := filepath.Join(f.cfg.stateRoot, "staging", fmt.Sprintf(".hub-release-1-%s.candidate", hex.EncodeToString(sum[:])))
	privateFile(t, candidate, []byte("conflicting-evidence"))
	_, err := verifyArtifact(f.cfg, f.artifact, f.envelope, f.signature, "hub-release")
	if err == nil || err.Error() != "candidate_conflict" {
		t.Fatalf("candidate conflict result=%v", err)
	}
	data, readErr := os.ReadFile(candidate)
	if readErr != nil || string(data) != "conflicting-evidence" {
		t.Fatal("conflicting candidate evidence changed")
	}
}

func TestFinalClockExpiryRejectsBeforeCandidate(t *testing.T) {
	f := makeFixture(t)
	f.cfg.readClock = func() int64 { return 1001 }
	_, err := verifyArtifact(f.cfg, f.artifact, f.envelope, f.signature, "hub-release")
	if err == nil || err.Error() != "artifact_envelope_rejected" {
		t.Fatalf("final clock result=%v", err)
	}
	entries, readErr := os.ReadDir(filepath.Join(f.cfg.stateRoot, "staging"))
	if readErr != nil || len(entries) != 0 {
		t.Fatalf("final clock created staging entries: %v %v", entries, readErr)
	}
}

func TestCopyCrossesExpiryAndRemovesOnlyNewCandidate(t *testing.T) {
	f := makeFixture(t)
	reads := 0
	f.cfg.readClock = func() int64 {
		reads++
		if reads == 1 {
			return 900
		}
		return 1001
	}
	_, err := verifyArtifact(f.cfg, f.artifact, f.envelope, f.signature, "hub-release")
	if err == nil || err.Error() != "artifact_envelope_rejected" {
		t.Fatalf("copy-cross-expiry result=%v reads=%d", err, reads)
	}
	entries, readErr := os.ReadDir(filepath.Join(f.cfg.stateRoot, "staging"))
	if readErr != nil || len(entries) != 0 {
		t.Fatalf("copy-cross-expiry left staging entries: %v %v", entries, readErr)
	}
}

func TestRecordCandidateFsyncCrashIsAdoptedAcrossTimeAdvance(t *testing.T) {
	f := makeFixture(t)
	clock := int64(201)
	f.cfg.readClock = func() int64 {
		clock++
		return clock
	}
	crashed := false
	f.cfg.afterRecordCandidateSync = func(path string) error {
		if path == filepath.Join(f.cfg.stateRoot, "accepted", "policy") && !crashed {
			crashed = true
			return reject("simulated_crash")
		}
		return nil
	}
	if _, err := verifyArtifact(f.cfg, f.artifact, f.envelope, f.signature, "hub-release"); err == nil || err.Error() != "publication_failed" {
		t.Fatalf("candidate-fsync crash result=%v", err)
	}
	entries, err := os.ReadDir(filepath.Join(f.cfg.stateRoot, "accepted"))
	if err != nil {
		t.Fatal(err)
	}
	foundCandidate := false
	for _, entry := range entries {
		foundCandidate = foundCandidate || strings.HasPrefix(entry.Name(), "policy.candidate-")
	}
	if !foundCandidate {
		t.Fatal("candidate-fsync crash did not preserve its durable candidate")
	}
	f.cfg.afterRecordCandidateSync = nil
	f.cfg.now = clock
	result, err := verifyArtifact(f.cfg, f.artifact, f.envelope, f.signature, "hub-release")
	if err != nil || result.sequence != 1 {
		t.Fatalf("candidate adoption result=%+v err=%v", result, err)
	}
	entries, err = os.ReadDir(filepath.Join(f.cfg.stateRoot, "accepted"))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.Contains(entry.Name(), ".candidate-") {
			t.Fatalf("candidate remained after adoption: %s", entry.Name())
		}
	}
	policyHighWater, present, err := readPolicyRecord(filepath.Join(f.cfg.stateRoot, "accepted", "policy"), f.cfg)
	if err != nil || !present || policyHighWater.time != clock {
		t.Fatalf("adopted policy high-water=%+v present=%v err=%v clock=%d", policyHighWater, present, err, clock)
	}
}

func TestArtifactRecordCandidateFsyncCrashIsAdopted(t *testing.T) {
	f := makeFixture(t)
	clock := int64(201)
	f.cfg.readClock = func() int64 {
		clock++
		return clock
	}
	recordPath := filepath.Join(f.cfg.stateRoot, "accepted", "hub-release")
	f.cfg.afterRecordCandidateSync = func(path string) error {
		if path == recordPath {
			return reject("simulated_crash")
		}
		return nil
	}
	if _, err := verifyArtifact(f.cfg, f.artifact, f.envelope, f.signature, "hub-release"); err == nil || err.Error() != "publication_failed" {
		t.Fatalf("artifact-record candidate crash result=%v", err)
	}
	f.cfg.afterRecordCandidateSync = nil
	f.cfg.now = clock
	result, err := verifyArtifact(f.cfg, f.artifact, f.envelope, f.signature, "hub-release")
	if err != nil || result.sequence != 1 {
		t.Fatalf("artifact-record adoption result=%+v err=%v", result, err)
	}
	entries, err := os.ReadDir(filepath.Join(f.cfg.stateRoot, "accepted"))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.Contains(entry.Name(), ".candidate-") {
			t.Fatalf("artifact record candidate remained: %s", entry.Name())
		}
	}
}

func TestSameSequenceKeepsAcceptedTimeAndCorruptFinalFails(t *testing.T) {
	f := makeFixture(t)
	f.cfg.readClock = func() int64 { return 201 }
	first, err := verifyArtifact(f.cfg, f.artifact, f.envelope, f.signature, "hub-release")
	if err != nil {
		t.Fatal(err)
	}
	f.cfg.now = 202
	f.cfg.readClock = func() int64 { return 203 }
	second, err := verifyArtifact(f.cfg, f.artifact, f.envelope, f.signature, "hub-release")
	if err != nil || second.acceptedAt != first.acceptedAt {
		t.Fatalf("idempotent accepted time changed: first=%d second=%d err=%v", first.acceptedAt, second.acceptedAt, err)
	}
	f.cfg.now = 203
	f.cfg.readClock = func() int64 { return 204 }
	final := filepath.Join(f.cfg.stateRoot, "staging", fmt.Sprintf("hub-release-1-%s", first.artifactHash))
	privateFile(t, final, []byte("corrupt"))
	if _, err = verifyArtifact(f.cfg, f.artifact, f.envelope, f.signature, "hub-release"); err == nil || err.Error() != "published_artifact_invalid" {
		t.Fatalf("corrupt final result=%v", err)
	}
}

func TestPolicyTimeAdvancesAcrossArtifactTypesWithoutChangingAcceptedTime(t *testing.T) {
	f := makeFixture(t)
	f.cfg.readClock = func() int64 { return 201 }
	hub, err := verifyArtifact(f.cfg, f.artifact, f.envelope, f.signature, "hub-release")
	if err != nil {
		t.Fatal(err)
	}
	f.cfg.now = 299
	f.cfg.readClock = func() int64 { return 300 }
	adminArtifact, adminEnvelope, adminSignature := f.signedInput("admin", "admin-kit", "publisher-a", 1, 1, f.publisherA, []byte("admin-one"))
	if _, err = verifyArtifact(f.cfg, adminArtifact, adminEnvelope, adminSignature, "admin-kit"); err != nil {
		t.Fatal(err)
	}
	f.cfg.now = 300
	f.cfg.readClock = func() int64 { return 301 }
	retry, err := verifyArtifact(f.cfg, f.artifact, f.envelope, f.signature, "hub-release")
	if err != nil || retry.acceptedAt != hub.acceptedAt {
		t.Fatalf("cross-type retry acceptedAt=%d want=%d err=%v", retry.acceptedAt, hub.acceptedAt, err)
	}
	policyHighWater, present, err := readPolicyRecord(filepath.Join(f.cfg.stateRoot, "accepted", "policy"), f.cfg)
	if err != nil || !present || policyHighWater.time != 301 {
		t.Fatalf("policy high-water=%+v present=%v err=%v", policyHighWater, present, err)
	}
}

func TestEnvironmentRequiresFixedMinimalSet(t *testing.T) {
	original := os.Environ()
	t.Cleanup(func() {
		os.Clearenv()
		for _, item := range original {
			name, value, _ := strings.Cut(item, "=")
			_ = os.Setenv(name, value)
		}
	})
	os.Clearenv()
	_ = os.Setenv("GODEBUG", "x509sha1=1")
	if err := sanitizeEnvironment(); err == nil || err.Error() != "environment_untrusted" {
		t.Fatalf("dangerous environment result=%v", err)
	}
	os.Clearenv()
	_ = os.Setenv("LC_ALL", "C")
	if err := sanitizeEnvironment(); err != nil {
		t.Fatal(err)
	}
}

func TestSuccessProtocolIsCanonicalAndRedacted(t *testing.T) {
	record := artifactRecord{
		typeName:     "hub-release",
		sequence:     7,
		artifactHash: strings.Repeat("a", 64),
		bytes:        13,
	}
	line := successLine(record, "/var/lib/agent-os/publisher")
	expected := "publisher_verifier result=ok artifact_type=hub-release sequence=7 artifact_sha256=" + strings.Repeat("a", 64) + " artifact_bytes=13 published_path=/var/lib/agent-os/publisher/staging/hub-release-7-" + strings.Repeat("a", 64)
	if line != expected || strings.Contains(line, "signature") || strings.ContainsRune(line, '\n') {
		t.Fatalf("unexpected success protocol: %q", line)
	}
}
