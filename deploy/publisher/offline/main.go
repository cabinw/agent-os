package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
)

const zeroHash = "0000000000000000000000000000000000000000000000000000000000000000"

type keySpec struct {
	id, status       string
	notBefore, after int64
	publicPath       string
}

type keySpecs []keySpec

func (values *keySpecs) String() string { return "id,status,not-before,not-after,public-key" }

func (values *keySpecs) Set(value string) error {
	parts := strings.Split(value, ",")
	if len(parts) != 5 || !validID(parts[0]) || (parts[1] != "active" && parts[1] != "revoked") {
		return errors.New("invalid key specification")
	}
	notBefore, err := positiveInt(parts[2])
	if err != nil {
		return errors.New("invalid key not-before")
	}
	notAfter, err := positiveInt(parts[3])
	if err != nil || notAfter <= notBefore {
		return errors.New("invalid key not-after")
	}
	if !filepath.IsAbs(parts[4]) {
		return errors.New("public key path must be absolute")
	}
	*values = append(*values, keySpec{parts[0], parts[1], notBefore, notAfter, parts[4]})
	return nil
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

func positiveInt(value string) (int64, error) {
	if value == "" || value == "0" || (len(value) > 1 && value[0] == '0') {
		return 0, errors.New("not a positive canonical decimal")
	}
	return strconv.ParseInt(value, 10, 63)
}

func trustedInput(path string, maximum int64) ([]byte, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("input path must be absolute")
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o022 != 0 || info.Size() < 1 || info.Size() > maximum {
		return nil, errors.New("input file is not trusted")
	}
	if raw, ok := info.Sys().(*syscall.Stat_t); !ok || raw.Nlink != 1 || raw.Uid != uint32(os.Getuid()) {
		return nil, errors.New("input file ownership or link count is not trusted")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil || int64(len(data)) != info.Size() {
		return nil, errors.New("input file changed while reading")
	}
	return data, nil
}

func hashTrustedInput(path string) (string, int64, error) {
	if !filepath.IsAbs(path) {
		return "", 0, errors.New("input path must be absolute")
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o022 != 0 || info.Size() < 1 {
		return "", 0, errors.New("input file is not trusted")
	}
	if raw, ok := info.Sys().(*syscall.Stat_t); !ok || raw.Nlink != 1 || raw.Uid != uint32(os.Getuid()) {
		return "", 0, errors.New("input file ownership or link count is not trusted")
	}
	file, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()
	hash := sha256.New()
	count, err := io.Copy(hash, file)
	if err != nil || count != info.Size() {
		return "", 0, errors.New("input file changed while reading")
	}
	after, err := file.Stat()
	if err != nil || !os.SameFile(info, after) || after.Size() != info.Size() {
		return "", 0, errors.New("input file changed while reading")
	}
	return hex.EncodeToString(hash.Sum(nil)), count, nil
}

func parsePrivate(path string) (ed25519.PrivateKey, error) {
	data, err := trustedInput(path, 4096)
	if err != nil {
		return nil, err
	}
	block, rest := pem.Decode(data)
	if block == nil || len(rest) != 0 || block.Type != "PRIVATE KEY" {
		return nil, errors.New("private key must be one PKCS#8 PEM block")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, errors.New("private key is invalid")
	}
	key, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		return nil, errors.New("private key is not Ed25519")
	}
	return key, nil
}

func parsePublic(path string) (ed25519.PublicKey, []byte, error) {
	data, err := trustedInput(path, 4096)
	if err != nil {
		return nil, nil, err
	}
	block, rest := pem.Decode(data)
	if block == nil || len(rest) != 0 || block.Type != "PUBLIC KEY" {
		return nil, nil, errors.New("public key must be one PKIX PEM block")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, nil, errors.New("public key is invalid")
	}
	key, ok := parsed.(ed25519.PublicKey)
	if !ok {
		return nil, nil, errors.New("public key is not Ed25519")
	}
	return key, block.Bytes, nil
}

func exclusiveOutput(path string, data []byte, mode os.FileMode) error {
	if !filepath.IsAbs(path) {
		return errors.New("output path must be absolute")
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		_ = file.Close()
		if !ok {
			_ = os.Remove(path)
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
	directory, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	err = directory.Sync()
	_ = directory.Close()
	if err != nil {
		return err
	}
	ok = true
	return nil
}

func publicPEM(key ed25519.PublicKey) ([]byte, error) {
	der, err := x509.MarshalPKIXPublicKey(key)
	if err != nil {
		return nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), nil
}

func generate(privatePath, publicPath string) error {
	if privatePath == publicPath {
		return errors.New("private and public outputs must differ")
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	der, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		return err
	}
	privatePEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	encodedPublic, err := publicPEM(public)
	if err != nil {
		return err
	}
	if err = exclusiveOutput(privatePath, privatePEM, 0o600); err != nil {
		return err
	}
	if err = exclusiveOutput(publicPath, encodedPublic, 0o600); err != nil {
		_ = os.Remove(privatePath)
		return err
	}
	return nil
}

func buildPolicy(epoch int64, previous string, specs keySpecs) ([]byte, error) {
	if epoch <= 0 || len(specs) == 0 || len(previous) != 64 {
		return nil, errors.New("policy arguments are incomplete")
	}
	if _, err := hex.DecodeString(previous); err != nil || strings.ToLower(previous) != previous {
		return nil, errors.New("previous policy SHA-256 is invalid")
	}
	sort.Slice(specs, func(i, j int) bool { return specs[i].id < specs[j].id })
	var frame strings.Builder
	fmt.Fprintf(&frame, "agent-os-publisher-policy-v1\nepoch=%d\nprevious_policy_sha256=%s\n", epoch, previous)
	last := ""
	for _, spec := range specs {
		if spec.id == last {
			return nil, errors.New("duplicate policy key id")
		}
		_, der, err := parsePublic(spec.publicPath)
		if err != nil {
			return nil, err
		}
		digest := sha256.Sum256(der)
		fmt.Fprintf(&frame, "key=%s|%s|%d|%d|%s|%s\n", spec.id, spec.status, spec.notBefore, spec.after, hex.EncodeToString(digest[:]), base64.StdEncoding.EncodeToString(der))
		last = spec.id
	}
	if frame.Len() > 64*1024 {
		return nil, errors.New("policy exceeds 64 KiB")
	}
	return []byte(frame.String()), nil
}

func signPolicy(rootPath, output, signature string, epoch int64, previous string, specs keySpecs) error {
	key, err := parsePrivate(rootPath)
	if err != nil {
		return err
	}
	frame, err := buildPolicy(epoch, previous, specs)
	if err != nil {
		return err
	}
	if err = exclusiveOutput(output, frame, 0o600); err != nil {
		return err
	}
	if err = exclusiveOutput(signature, ed25519.Sign(key, frame), 0o600); err != nil {
		_ = os.Remove(output)
		return err
	}
	return nil
}

func signArtifact(privatePath, artifactPath, output, signature, artifactType, keyID string, epoch, sequence, notBefore, expires int64) error {
	if artifactType != "admin-kit" && artifactType != "hub-release" {
		return errors.New("artifact type must be admin-kit or hub-release")
	}
	if !validID(keyID) || epoch <= 0 || sequence <= 0 || notBefore <= 0 || expires <= notBefore {
		return errors.New("artifact envelope arguments are invalid")
	}
	key, err := parsePrivate(privatePath)
	if err != nil {
		return err
	}
	digest, artifactBytes, err := hashTrustedInput(artifactPath)
	if err != nil {
		return err
	}
	frame := []byte(fmt.Sprintf("agent-os-publisher-envelope-v1\nartifact_type=%s\nartifact_sha256=%s\nartifact_bytes=%d\nkey_id=%s\npolicy_epoch=%d\nsequence=%d\nnot_before=%d\nexpires_at=%d\n", artifactType, digest, artifactBytes, keyID, epoch, sequence, notBefore, expires))
	if err = exclusiveOutput(output, frame, 0o600); err != nil {
		return err
	}
	if err = exclusiveOutput(signature, ed25519.Sign(key, frame), 0o600); err != nil {
		_ = os.Remove(output)
		return err
	}
	return nil
}

func command(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: publisher-offline <generate|policy|artifact>")
	}
	switch args[0] {
	case "generate":
		flags := flag.NewFlagSet("generate", flag.ContinueOnError)
		private := flags.String("private", "", "absolute private-key output")
		public := flags.String("public", "", "absolute public-key output")
		if err := flags.Parse(args[1:]); err != nil || flags.NArg() != 0 || *private == "" || *public == "" {
			return errors.New("usage: publisher-offline generate --private PATH --public PATH")
		}
		return generate(*private, *public)
	case "policy":
		flags := flag.NewFlagSet("policy", flag.ContinueOnError)
		root := flags.String("root-private", "", "absolute root private key")
		output := flags.String("output", "", "absolute policy output")
		signature := flags.String("signature", "", "absolute signature output")
		epoch := flags.Int64("epoch", 0, "positive policy epoch")
		previous := flags.String("previous-policy-sha256", zeroHash, "predecessor policy SHA-256")
		var specs keySpecs
		flags.Var(&specs, "key", "id,status,not-before,not-after,absolute-public-key")
		if err := flags.Parse(args[1:]); err != nil || flags.NArg() != 0 || *root == "" || *output == "" || *signature == "" {
			return errors.New("usage: publisher-offline policy --root-private PATH --epoch N --key SPEC --output PATH --signature PATH")
		}
		return signPolicy(*root, *output, *signature, *epoch, *previous, specs)
	case "artifact":
		flags := flag.NewFlagSet("artifact", flag.ContinueOnError)
		private := flags.String("publisher-private", "", "absolute publisher private key")
		artifact := flags.String("artifact", "", "absolute artifact path")
		artifactType := flags.String("artifact-type", "", "admin-kit or hub-release")
		keyID := flags.String("key-id", "", "publisher key id")
		epoch := flags.Int64("policy-epoch", 0, "positive policy epoch")
		sequence := flags.Int64("sequence", 0, "positive per-type sequence")
		notBefore := flags.Int64("not-before", 0, "UTC seconds")
		expires := flags.Int64("expires-at", 0, "UTC seconds")
		output := flags.String("output", "", "absolute envelope output")
		signature := flags.String("signature", "", "absolute signature output")
		if err := flags.Parse(args[1:]); err != nil || flags.NArg() != 0 || *private == "" || *artifact == "" || *output == "" || *signature == "" {
			return errors.New("usage: publisher-offline artifact --publisher-private PATH --artifact PATH --artifact-type TYPE --key-id ID --policy-epoch N --sequence N --not-before UTC --expires-at UTC --output PATH --signature PATH")
		}
		return signArtifact(*private, *artifact, *output, *signature, *artifactType, *keyID, *epoch, *sequence, *notBefore, *expires)
	default:
		return errors.New("usage: publisher-offline <generate|policy|artifact>")
	}
}

func main() {
	if err := command(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "publisher_offline result=error reason=%s\n", strings.ReplaceAll(err.Error(), " ", "_"))
		os.Exit(1)
	}
	fmt.Println("publisher_offline result=ok")
}
