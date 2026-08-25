package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	productionRootKey   = "/etc/agent-os/publisher/root-v1.pem"
	productionPolicy    = "/etc/agent-os/publisher/policy-v1"
	productionPolicySig = "/etc/agent-os/publisher/policy-v1.sig"
	productionState     = "/var/lib/agent-os/publisher"
	zeroHash            = "0000000000000000000000000000000000000000000000000000000000000000"
)

type config struct {
	rootKey, policy, policySig, stateRoot, trustBoundary string
	expectedUID                                          uint32
	now                                                  int64
	readClock                                            func() int64
	afterFirstHash                                       func() error
	afterLock                                            func() error
}

type policyKey struct {
	id, status       string
	notBefore, after int64
	publicKey        ed25519.PublicKey
}

type policy struct {
	epoch    uint64
	previous string
	keys     map[string]policyKey
}

type envelope struct {
	typeName, digest, keyID string
	bytes                   int64
	policyEpoch, sequence   uint64
	notBefore, expires      int64
}

type artifactRecord struct {
	typeName, envelopeHash, artifactHash string
	sequence, policyEpoch                uint64
	bytes, acceptedAt                    int64
}

type policyRecord struct {
	epoch uint64
	hash  string
	time  int64
}

func reject(code string) error { return errors.New(code) }

func strictLines(data []byte, maximum int) ([]string, error) {
	if len(data) == 0 || len(data) > maximum || data[len(data)-1] != '\n' || bytes.Contains(data, []byte{'\r'}) {
		return nil, reject("frame_invalid")
	}
	text := string(data[:len(data)-1])
	if strings.ContainsRune(text, '\x00') || strings.Contains(text, "\n\n") {
		return nil, reject("frame_invalid")
	}
	return strings.Split(text, "\n"), nil
}

func positiveDecimal(value string) (uint64, error) {
	if value == "" || value == "0" || (len(value) > 1 && value[0] == '0') {
		return 0, reject("frame_invalid")
	}
	parsed, err := strconv.ParseUint(value, 10, 63)
	if err != nil || parsed == 0 {
		return 0, reject("frame_invalid")
	}
	return parsed, nil
}

func timestamp(value string) (int64, error) {
	parsed, err := positiveDecimal(value)
	if err != nil {
		return 0, err
	}
	return int64(parsed), nil
}

func exactField(line, name string) (string, error) {
	prefix := name + "="
	if !strings.HasPrefix(line, prefix) {
		return "", reject("frame_invalid")
	}
	return strings.TrimPrefix(line, prefix), nil
}

func parsePolicy(data []byte) (policy, error) {
	lines, err := strictLines(data, 64*1024)
	if err != nil || len(lines) < 4 || lines[0] != "agent-os-publisher-policy-v1" {
		return policy{}, reject("policy_invalid")
	}
	epochText, err := exactField(lines[1], "epoch")
	if err != nil {
		return policy{}, reject("policy_invalid")
	}
	epoch, err := positiveDecimal(epochText)
	if err != nil {
		return policy{}, reject("policy_invalid")
	}
	previous, err := exactField(lines[2], "previous_policy_sha256")
	if err != nil || !isHash(previous) {
		return policy{}, reject("policy_invalid")
	}
	result := policy{epoch: epoch, previous: previous, keys: map[string]policyKey{}}
	lastID := ""
	for _, line := range lines[3:] {
		value, err := exactField(line, "key")
		if err != nil {
			return policy{}, reject("policy_invalid")
		}
		parts := strings.Split(value, "|")
		if len(parts) != 6 || !validID(parts[0]) || parts[0] <= lastID || (parts[1] != "active" && parts[1] != "revoked") {
			return policy{}, reject("policy_invalid")
		}
		notBefore, err := timestamp(parts[2])
		if err != nil {
			return policy{}, reject("policy_invalid")
		}
		notAfter, err := timestamp(parts[3])
		if err != nil || notAfter <= notBefore || !isHash(parts[4]) {
			return policy{}, reject("policy_invalid")
		}
		der, err := base64.StdEncoding.Strict().DecodeString(parts[5])
		if err != nil {
			return policy{}, reject("policy_invalid")
		}
		if sum := sha256.Sum256(der); hex.EncodeToString(sum[:]) != parts[4] {
			return policy{}, reject("policy_invalid")
		}
		parsed, err := x509.ParsePKIXPublicKey(der)
		if err != nil {
			return policy{}, reject("policy_invalid")
		}
		publicKey, ok := parsed.(ed25519.PublicKey)
		if !ok {
			return policy{}, reject("policy_invalid")
		}
		result.keys[parts[0]] = policyKey{parts[0], parts[1], notBefore, notAfter, publicKey}
		lastID = parts[0]
	}
	return result, nil
}

func parseEnvelope(data []byte) (envelope, error) {
	lines, err := strictLines(data, 1024)
	if err != nil || len(lines) != 9 || lines[0] != "agent-os-publisher-envelope-v1" {
		return envelope{}, reject("envelope_invalid")
	}
	values := make([]string, 8)
	names := []string{"artifact_type", "artifact_sha256", "artifact_bytes", "key_id", "policy_epoch", "sequence", "not_before", "expires_at"}
	for index, name := range names {
		values[index], err = exactField(lines[index+1], name)
		if err != nil {
			return envelope{}, reject("envelope_invalid")
		}
	}
	if values[0] != "admin-kit" && values[0] != "hub-release" {
		return envelope{}, reject("envelope_invalid")
	}
	if !isHash(values[1]) || !validID(values[3]) {
		return envelope{}, reject("envelope_invalid")
	}
	byteCount, err := positiveDecimal(values[2])
	if err != nil {
		return envelope{}, reject("envelope_invalid")
	}
	epoch, err := positiveDecimal(values[4])
	if err != nil {
		return envelope{}, reject("envelope_invalid")
	}
	sequence, err := positiveDecimal(values[5])
	if err != nil {
		return envelope{}, reject("envelope_invalid")
	}
	notBefore, err := timestamp(values[6])
	if err != nil {
		return envelope{}, reject("envelope_invalid")
	}
	expires, err := timestamp(values[7])
	if err != nil || expires <= notBefore {
		return envelope{}, reject("envelope_invalid")
	}
	return envelope{values[0], values[1], values[3], int64(byteCount), epoch, sequence, notBefore, expires}, nil
}

func validID(value string) bool {
	if len(value) < 1 || len(value) > 48 {
		return false
	}
	for _, char := range value {
		if !((char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char == '-') {
			return false
		}
	}
	return true
}
func isHash(value string) bool {
	_, err := hex.DecodeString(value)
	return len(value) == 64 && strings.ToLower(value) == value && err == nil
}

func readBoundedTrusted(path string, maximum int64, cfg config) ([]byte, error) {
	file, err := openTrustedFile(path, cfg)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.Size() < 1 || info.Size() > maximum {
		return nil, reject("trusted_input_invalid")
	}
	data, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil || int64(len(data)) != info.Size() {
		return nil, reject("trusted_input_invalid")
	}
	return data, nil
}

func trustedDirectory(path string, cfg config) error {
	directory, err := openTrustedDirectory(path, cfg)
	if err != nil {
		return err
	}
	return directory.Close()
}

func ensureStateDirectory(path string, cfg config) error {
	if err := os.Mkdir(path, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return reject("state_unavailable")
	}
	if err := trustedDirectory(path, cfg); err != nil {
		return reject("state_untrusted")
	}
	return nil
}

func parseRoot(data []byte) (ed25519.PublicKey, error) {
	block, rest := pem.Decode(data)
	if block == nil || len(rest) != 0 || block.Type != "PUBLIC KEY" {
		return nil, reject("root_key_invalid")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, reject("root_key_invalid")
	}
	key, ok := parsed.(ed25519.PublicKey)
	if !ok {
		return nil, reject("root_key_invalid")
	}
	return key, nil
}

func hashReader(reader io.Reader) (string, int64, error) {
	hash := sha256.New()
	count, err := io.Copy(hash, reader)
	if err != nil {
		return "", count, err
	}
	return hex.EncodeToString(hash.Sum(nil)), count, nil
}

func syncDir(path string, cfg config) error {
	directory, err := openTrustedDirectory(path, cfg)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func readPolicyRecord(path string, cfg config) (policyRecord, bool, error) {
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		return policyRecord{}, false, nil
	} else if err != nil {
		return policyRecord{}, false, reject("policy_record_invalid")
	}
	data, err := readBoundedTrusted(path, 512, cfg)
	if err != nil {
		return policyRecord{}, false, reject("policy_record_invalid")
	}
	lines, err := strictLines(data, 512)
	if err != nil || len(lines) != 4 || lines[0] != "agent-os-policy-record-v1" {
		return policyRecord{}, false, reject("policy_record_invalid")
	}
	e, _ := exactField(lines[1], "epoch")
	h, _ := exactField(lines[2], "policy_sha256")
	t, _ := exactField(lines[3], "trusted_time")
	epoch, err := positiveDecimal(e)
	if err != nil || !isHash(h) {
		return policyRecord{}, false, reject("policy_record_invalid")
	}
	observed, err := timestamp(t)
	if err != nil {
		return policyRecord{}, false, reject("policy_record_invalid")
	}
	return policyRecord{epoch, h, observed}, true, nil
}

func readArtifactRecord(path string, cfg config) (artifactRecord, bool, error) {
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		return artifactRecord{}, false, nil
	} else if err != nil {
		return artifactRecord{}, false, reject("artifact_record_invalid")
	}
	data, err := readBoundedTrusted(path, 1024, cfg)
	if err != nil {
		return artifactRecord{}, false, reject("artifact_record_invalid")
	}
	lines, err := strictLines(data, 1024)
	if err != nil || len(lines) != 8 || lines[0] != "agent-os-artifact-record-v1" {
		return artifactRecord{}, false, reject("artifact_record_invalid")
	}
	fields := map[string]string{}
	names := []string{"artifact_type", "sequence", "envelope_sha256", "artifact_sha256", "artifact_bytes", "policy_epoch", "accepted_at"}
	for index, name := range names {
		fields[name], err = exactField(lines[index+1], name)
		if err != nil {
			return artifactRecord{}, false, reject("artifact_record_invalid")
		}
	}
	seq, err := positiveDecimal(fields["sequence"])
	if err != nil || !isHash(fields["envelope_sha256"]) || !isHash(fields["artifact_sha256"]) {
		return artifactRecord{}, false, reject("artifact_record_invalid")
	}
	bytesValue, err := timestamp(fields["artifact_bytes"])
	if err != nil {
		return artifactRecord{}, false, reject("artifact_record_invalid")
	}
	epoch, err := positiveDecimal(fields["policy_epoch"])
	if err != nil {
		return artifactRecord{}, false, reject("artifact_record_invalid")
	}
	accepted, err := timestamp(fields["accepted_at"])
	if err != nil {
		return artifactRecord{}, false, reject("artifact_record_invalid")
	}
	return artifactRecord{fields["artifact_type"], fields["envelope_sha256"], fields["artifact_sha256"], seq, epoch, bytesValue, accepted}, true, nil
}

func recordCandidate(path string, data []byte, cfg config) (string, bool, error) {
	directory := filepath.Dir(path)
	digest := sha256.Sum256(data)
	prefix := filepath.Base(path) + ".candidate-"
	temporary := path + ".candidate-" + hex.EncodeToString(digest[:])
	directoryHandle, err := openTrustedDirectory(directory, cfg)
	if err != nil {
		return "", false, err
	}
	entries, err := directoryHandle.ReadDir(-1)
	_ = directoryHandle.Close()
	if err != nil {
		return "", false, err
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), prefix) && filepath.Join(directory, entry.Name()) != temporary {
			return "", false, reject("record_candidate_conflict")
		}
	}
	if _, err := os.Lstat(temporary); err == nil {
		existing, readErr := readBoundedTrusted(temporary, int64(len(data)+1), cfg)
		if readErr != nil {
			return "", false, readErr
		}
		if !bytes.Equal(existing, data) {
			return "", false, reject("record_candidate_conflict")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", false, err
	}
	_, err = os.Lstat(temporary)
	return temporary, err == nil, nil
}

func atomicRecord(path string, data []byte, cfg config) error {
	directory := filepath.Dir(path)
	temporary, exists, err := recordCandidate(path, data, cfg)
	if err != nil {
		return err
	}
	if exists {
		if renameErr := os.Rename(temporary, path); renameErr != nil {
			return renameErr
		}
		return syncDir(directory, cfg)
	}
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		file.Close()
		if !ok {
			os.Remove(temporary)
		}
	}()
	if _, err = file.Write(data); err != nil {
		return err
	}
	if err = file.Sync(); err != nil {
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	if err = os.Rename(temporary, path); err != nil {
		return err
	}
	if err = syncDir(directory, cfg); err != nil {
		return err
	}
	ok = true
	return nil
}

func verifyPublished(path, expectedHash string, expectedBytes int64, cfg config) error {
	file, err := openTrustedFile(path, cfg)
	if err != nil {
		return reject("published_artifact_invalid")
	}
	defer file.Close()
	hash, count, err := hashReader(file)
	if err != nil || hash != expectedHash || count != expectedBytes {
		return reject("published_artifact_invalid")
	}
	return nil
}

func existingCandidate(path, expectedHash string, expectedBytes int64, cfg config) (bool, error) {
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		return false, nil
	} else if err != nil {
		return false, reject("candidate_invalid")
	}
	if err := verifyPublished(path, expectedHash, expectedBytes, cfg); err != nil {
		return false, reject("candidate_conflict")
	}
	return true, nil
}

func verifyArtifact(cfg config, artifactPath, envelopePath, signaturePath, expectedType string) (artifactRecord, error) {
	if err := trustedDirectory(cfg.stateRoot, cfg); err != nil {
		return artifactRecord{}, reject("state_untrusted")
	}
	acceptedRoot := filepath.Join(cfg.stateRoot, "accepted")
	staging := filepath.Join(cfg.stateRoot, "staging")
	if err := trustedDirectory(acceptedRoot, cfg); err != nil {
		return artifactRecord{}, reject("state_untrusted")
	}
	if err := trustedDirectory(staging, cfg); err != nil {
		return artifactRecord{}, reject("state_untrusted")
	}
	lock, err := acquireTransactionLock(filepath.Join(cfg.stateRoot, "transaction.lock"), cfg)
	if err != nil {
		return artifactRecord{}, err
	}
	defer releaseTransactionLock(lock)
	if cfg.afterLock != nil {
		if err = cfg.afterLock(); err != nil {
			return artifactRecord{}, err
		}
	}
	rootData, err := readBoundedTrusted(cfg.rootKey, 4096, cfg)
	if err != nil {
		return artifactRecord{}, err
	}
	root, err := parseRoot(rootData)
	if err != nil {
		return artifactRecord{}, err
	}
	policyData, err := readBoundedTrusted(cfg.policy, 64*1024, cfg)
	if err != nil {
		return artifactRecord{}, err
	}
	policySig, err := readBoundedTrusted(cfg.policySig, 64, cfg)
	if err != nil || len(policySig) != ed25519.SignatureSize || !ed25519.Verify(root, policyData, policySig) {
		return artifactRecord{}, reject("policy_signature_invalid")
	}
	parsedPolicy, err := parsePolicy(policyData)
	if err != nil {
		return artifactRecord{}, err
	}
	policySum := sha256.Sum256(policyData)
	policyHash := hex.EncodeToString(policySum[:])
	policyRecordPath := filepath.Join(acceptedRoot, "policy")
	priorPolicy, hasPolicy, err := readPolicyRecord(policyRecordPath, cfg)
	if err != nil {
		return artifactRecord{}, err
	}
	if hasPolicy && (cfg.now < priorPolicy.time || parsedPolicy.epoch < priorPolicy.epoch || (parsedPolicy.epoch == priorPolicy.epoch && policyHash != priorPolicy.hash) || (parsedPolicy.epoch > priorPolicy.epoch && parsedPolicy.previous != priorPolicy.hash)) {
		return artifactRecord{}, reject("policy_rollback")
	}
	if !hasPolicy && parsedPolicy.previous != zeroHash {
		return artifactRecord{}, reject("policy_predecessor_invalid")
	}
	envelopeData, err := readBoundedTrusted(envelopePath, 1024, cfg)
	if err != nil {
		return artifactRecord{}, err
	}
	signature, err := readBoundedTrusted(signaturePath, 64, cfg)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return artifactRecord{}, reject("artifact_signature_invalid")
	}
	parsedEnvelope, err := parseEnvelope(envelopeData)
	if err != nil {
		return artifactRecord{}, err
	}
	if parsedEnvelope.typeName != expectedType || parsedEnvelope.policyEpoch != parsedPolicy.epoch || cfg.now < parsedEnvelope.notBefore || cfg.now > parsedEnvelope.expires {
		return artifactRecord{}, reject("artifact_envelope_rejected")
	}
	envelopeSum := sha256.Sum256(envelopeData)
	record := artifactRecord{expectedType, hex.EncodeToString(envelopeSum[:]), parsedEnvelope.digest, parsedEnvelope.sequence, parsedEnvelope.policyEpoch, parsedEnvelope.bytes, cfg.now}
	recordPath := filepath.Join(acceptedRoot, expectedType)
	prior, hasPrior, err := readArtifactRecord(recordPath, cfg)
	if err != nil {
		return artifactRecord{}, err
	}
	if hasPrior {
		if record.sequence < prior.sequence {
			return artifactRecord{}, reject("artifact_replay")
		}
		if record.sequence == prior.sequence {
			if record.typeName != prior.typeName || record.envelopeHash != prior.envelopeHash || record.artifactHash != prior.artifactHash || record.bytes != prior.bytes || record.policyEpoch != prior.policyEpoch {
				return artifactRecord{}, reject("artifact_replay")
			}
			record.acceptedAt = prior.acceptedAt
		}
	}
	key, ok := parsedPolicy.keys[parsedEnvelope.keyID]
	if !ok || key.status != "active" || cfg.now < key.notBefore || cfg.now > key.after || !ed25519.Verify(key.publicKey, envelopeData, signature) {
		return artifactRecord{}, reject("artifact_signature_invalid")
	}
	artifact, err := openTrustedFile(artifactPath, cfg)
	if err != nil {
		return artifactRecord{}, reject("artifact_unavailable")
	}
	defer artifact.Close()
	before, err := artifact.Stat()
	if err != nil {
		return artifactRecord{}, reject("artifact_changed")
	}
	raw, ok := before.Sys().(*syscall.Stat_t)
	if !ok || raw.Nlink != 1 {
		return artifactRecord{}, reject("artifact_untrusted")
	}
	firstHash, firstBytes, err := hashReader(artifact)
	if err != nil || firstHash != parsedEnvelope.digest || firstBytes != parsedEnvelope.bytes {
		return artifactRecord{}, reject("artifact_digest_mismatch")
	}
	if cfg.afterFirstHash != nil {
		if err := cfg.afterFirstHash(); err != nil {
			return artifactRecord{}, err
		}
	}
	finalObserved := cfg.now
	if cfg.readClock != nil {
		finalTime := cfg.readClock()
		if finalTime < cfg.now {
			return artifactRecord{}, reject("clock_untrusted")
		}
		if finalTime < parsedEnvelope.notBefore || finalTime > parsedEnvelope.expires || finalTime < key.notBefore || finalTime > key.after {
			return artifactRecord{}, reject("artifact_envelope_rejected")
		}
		finalObserved = finalTime
		if !hasPrior || record.sequence != prior.sequence {
			record.acceptedAt = finalTime
		}
	}
	trustedTime := finalObserved
	if hasPolicy && trustedTime < priorPolicy.time {
		return artifactRecord{}, reject("clock_untrusted")
	}
	policyFrame := fmt.Sprintf("agent-os-policy-record-v1\nepoch=%d\npolicy_sha256=%s\ntrusted_time=%d\n", parsedPolicy.epoch, policyHash, trustedTime)
	artifactFrame := fmt.Sprintf("agent-os-artifact-record-v1\nartifact_type=%s\nsequence=%d\nenvelope_sha256=%s\nartifact_sha256=%s\nartifact_bytes=%d\npolicy_epoch=%d\naccepted_at=%d\n", record.typeName, record.sequence, record.envelopeHash, record.artifactHash, record.bytes, record.policyEpoch, record.acceptedAt)
	if _, _, err = recordCandidate(policyRecordPath, []byte(policyFrame), cfg); err != nil {
		return artifactRecord{}, reject("publication_failed")
	}
	if _, _, err = recordCandidate(recordPath, []byte(artifactFrame), cfg); err != nil {
		return artifactRecord{}, reject("publication_failed")
	}
	if _, err = artifact.Seek(0, 0); err != nil {
		return artifactRecord{}, reject("artifact_changed")
	}
	candidate := filepath.Join(staging, fmt.Sprintf(".%s-%d-%s.candidate", expectedType, parsedEnvelope.sequence, parsedEnvelope.digest))
	hasCandidate, err := existingCandidate(candidate, parsedEnvelope.digest, parsedEnvelope.bytes, cfg)
	if err != nil {
		return artifactRecord{}, err
	}
	var output *os.File
	if !hasCandidate {
		output, err = os.OpenFile(candidate, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return artifactRecord{}, reject("publication_failed")
		}
	}
	defer func() {
		if output != nil {
			output.Close()
		}
		// Failed candidates remain as transaction evidence. An exact successful
		// retry removes its candidate only after the final copy is verified.
	}()
	secondReader := io.Reader(artifact)
	if output != nil {
		secondReader = io.TeeReader(artifact, output)
	}
	secondHash, secondBytes, err := hashReader(secondReader)
	if err != nil || secondHash != firstHash || secondBytes != firstBytes {
		return artifactRecord{}, reject("artifact_changed")
	}
	if output != nil {
		if err = output.Sync(); err != nil {
			return artifactRecord{}, reject("publication_failed")
		}
		if err = output.Close(); err != nil {
			return artifactRecord{}, reject("publication_failed")
		}
	}
	after, err := artifact.Stat()
	if err != nil || !os.SameFile(before, after) || after.Size() != before.Size() {
		return artifactRecord{}, reject("artifact_changed")
	}
	pathInfo, err := os.Lstat(artifactPath)
	if err != nil || !os.SameFile(before, pathInfo) {
		return artifactRecord{}, reject("artifact_changed")
	}
	record.artifactHash = firstHash
	record.bytes = firstBytes
	final := filepath.Join(staging, fmt.Sprintf("%s-%d-%s", expectedType, record.sequence, record.artifactHash))
	if _, err = os.Lstat(final); errors.Is(err, os.ErrNotExist) {
		if err = os.Link(candidate, final); err != nil {
			return artifactRecord{}, reject("publication_failed")
		}
		if err = os.Remove(candidate); err != nil {
			return artifactRecord{}, reject("publication_failed")
		}
		if err = syncDir(staging, cfg); err != nil {
			return artifactRecord{}, reject("publication_failed")
		}
	} else if err != nil {
		return artifactRecord{}, reject("publication_failed")
	} else if err = verifyPublished(final, record.artifactHash, record.bytes, cfg); err != nil {
		return artifactRecord{}, err
	}
	if err = verifyPublished(final, record.artifactHash, record.bytes, cfg); err != nil {
		return artifactRecord{}, err
	}
	if _, candidateErr := os.Lstat(candidate); candidateErr == nil {
		if err = os.Remove(candidate); err != nil {
			return artifactRecord{}, reject("publication_failed")
		}
		if err = syncDir(staging, cfg); err != nil {
			return artifactRecord{}, reject("publication_failed")
		}
	} else if !errors.Is(candidateErr, os.ErrNotExist) {
		return artifactRecord{}, reject("publication_failed")
	}
	if !hasPolicy || priorPolicy.time != trustedTime || priorPolicy.epoch != parsedPolicy.epoch || priorPolicy.hash != policyHash {
		if err = atomicRecord(policyRecordPath, []byte(policyFrame), cfg); err != nil {
			return artifactRecord{}, reject("publication_failed")
		}
	}
	if !hasPrior || record != prior {
		if err = atomicRecord(recordPath, []byte(artifactFrame), cfg); err != nil {
			return artifactRecord{}, reject("publication_failed")
		}
	}
	return record, nil
}

func sanitizeEnvironment() error {
	allowed := map[string]string{
		"LANG":   "C",
		"LC_ALL": "C",
		"PATH":   "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin",
		"TZ":     "UTC",
	}
	for _, item := range os.Environ() {
		name, value, found := strings.Cut(item, "=")
		expected, ok := allowed[name]
		if !found || !ok || value != expected {
			return reject("environment_untrusted")
		}
	}
	os.Clearenv()
	for name, value := range allowed {
		if err := os.Setenv(name, value); err != nil {
			return reject("environment_untrusted")
		}
	}
	return nil
}

func main() {
	if err := sanitizeEnvironment(); err != nil {
		fmt.Fprintf(os.Stderr, "publisher_verifier result=%s\n", err.Error())
		os.Exit(1)
	}
	if len(os.Args) != 8 || os.Args[1] != "verify" || os.Args[2] != "--artifact-type" || os.Args[4] != "--artifact" || os.Args[6] != "--envelope" {
		fmt.Fprintln(os.Stderr, "publisher_verifier result=usage")
		os.Exit(2)
	}
	cfg := config{rootKey: productionRootKey, policy: productionPolicy, policySig: productionPolicySig, stateRoot: productionState, trustBoundary: "/", expectedUID: 0, now: time.Now().Unix(), readClock: func() int64 { return time.Now().Unix() }}
	_, err := verifyArtifact(cfg, os.Args[5], os.Args[7], os.Args[7]+".sig", os.Args[3])
	if err != nil {
		fmt.Fprintf(os.Stderr, "publisher_verifier result=%s\n", err.Error())
		os.Exit(1)
	}
	fmt.Println("publisher_verifier result=ok")
}
