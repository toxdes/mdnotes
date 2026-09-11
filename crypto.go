package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/crypto/argon2"
)

const (
	envelopeMagic   = "MDN2"
	envelopeVersion = byte(1)
	metaFilename    = ".vylk-crypto.json"

	argonTime    = uint32(2)
	argonMemory  = uint32(19 * 1024) // KiB
	argonThreads = uint8(1)
	argonKeyLen  = uint32(32)
)

type encryptionConfig struct {
	key         []byte
	legacyKey   []byte
	legacyWrite bool
}

type encryptionMetadata struct {
	Version uint8  `json:"version"`
	KDF     string `json:"kdf"`
	Salt    string `json:"salt"`
	Time    uint32 `json:"time"`
	Memory  uint32 `json:"memoryKiB"`
	Threads uint8  `json:"threads"`
}

// deriveKey remains exclusively for reading the application's legacy format.
func deriveKey(s string) []byte {
	h := sha256.Sum256([]byte(s))
	return h[:]
}

func newEncryptionConfig(notesDir, password, rawKey string) (*encryptionConfig, error) {
	if password != "" && rawKey != "" {
		return nil, errors.New("set only one of VYLK_ENCRYPTION_PASSWORD or VYLK_ENCRYPTION_KEY")
	}
	if password == "" && rawKey == "" {
		return nil, nil
	}
	if password != "" {
		meta, err := loadOrCreateEncryptionMetadata(notesDir)
		if err != nil {
			return nil, err
		}
		salt, err := base64.RawStdEncoding.DecodeString(meta.Salt)
		if err != nil {
			return nil, fmt.Errorf("decode encryption salt: %w", err)
		}
		if len(salt) != 16 {
			return nil, errors.New("invalid encryption salt")
		}
		return &encryptionConfig{
			key:       argon2.IDKey([]byte(password), salt, meta.Time, meta.Memory, meta.Threads, argonKeyLen),
			legacyKey: deriveKey(password),
		}, nil
	}

	key, err := parseRawKey(rawKey)
	if err != nil {
		// Preserve the previous VYLK_ENCRYPTION_KEY behavior for existing
		// deployments. New deployments should use a base64 or hex 32-byte key.
		return &encryptionConfig{key: deriveKey(rawKey), legacyWrite: true}, nil
	}
	return &encryptionConfig{key: key}, nil
}

func parseRawKey(value string) ([]byte, error) {
	if encoded, ok := strings.CutPrefix(value, "hex:"); ok {
		if key, err := hex.DecodeString(encoded); err == nil && len(key) == 32 {
			return key, nil
		}
	}
	if encoded, ok := strings.CutPrefix(value, "base64:"); ok {
		if key, err := base64.RawStdEncoding.DecodeString(encoded); err == nil && len(key) == 32 {
			return key, nil
		}
		if key, err := base64.StdEncoding.DecodeString(encoded); err == nil && len(key) == 32 {
			return key, nil
		}
	}
	return nil, errors.New("key must use hex: or base64: and encode exactly 32 bytes")
}

func loadOrCreateEncryptionMetadata(notesDir string) (*encryptionMetadata, error) {
	path := filepath.Join(notesDir, metaFilename)
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		salt := make([]byte, 16)
		if _, err := io.ReadFull(rand.Reader, salt); err != nil {
			return nil, err
		}
		meta := &encryptionMetadata{
			Version: envelopeVersion,
			KDF:     "argon2id",
			Salt:    base64.RawStdEncoding.EncodeToString(salt),
			Time:    argonTime,
			Memory:  argonMemory,
			Threads: argonThreads,
		}
		encoded, err := json.Marshal(meta)
		if err != nil {
			return nil, err
		}
		if err := writePrivateFile(path, encoded); err != nil {
			return nil, err
		}
		return meta, nil
	}
	if err != nil {
		return nil, err
	}
	var meta encryptionMetadata
	if err := json.Unmarshal(data, &meta); err != nil {
		return nil, fmt.Errorf("decode encryption metadata: %w", err)
	}
	if meta.Version != envelopeVersion || meta.KDF != "argon2id" || meta.Time == 0 || meta.Time > 10 ||
		meta.Memory < 16*1024 || meta.Memory > 256*1024 || meta.Threads == 0 || meta.Threads > 4 {
		return nil, errors.New("unsupported encryption metadata")
	}
	return &meta, nil
}

func writePrivateFile(path string, content []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".vylk-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(content); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

func noteAAD(id string) []byte {
	return []byte("vylk:v2:" + id)
}

func isVersionedEnvelope(data []byte) bool {
	return len(data) >= len(envelopeMagic)+1 && string(data[:len(envelopeMagic)]) == envelopeMagic
}

func (c *encryptionConfig) encryptNote(plaintext []byte, id string) ([]byte, error) {
	if c == nil {
		return plaintext, nil
	}
	if c.legacyWrite {
		return encryptLegacy(plaintext, c.key)
	}
	block, err := aes.NewCipher(c.key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	ciphertext := aead.Seal(nil, nonce, plaintext, noteAAD(id))
	out := make([]byte, 0, len(envelopeMagic)+1+len(nonce)+len(ciphertext))
	out = append(out, envelopeMagic...)
	out = append(out, envelopeVersion)
	out = append(out, nonce...)
	out = append(out, ciphertext...)
	return out, nil
}

func (c *encryptionConfig) decryptNote(data []byte, id string) ([]byte, error) {
	if c == nil {
		return data, nil
	}
	if isVersionedEnvelope(data) {
		return decryptV2(data, c.key, id)
	}
	key := c.legacyKey
	if key == nil {
		key = c.key
	}
	return decryptLegacy(data, key)
}

func decryptV2(data, key []byte, id string) ([]byte, error) {
	if len(data) < len(envelopeMagic)+1 || data[len(envelopeMagic)] != envelopeVersion {
		return nil, errors.New("unsupported encrypted note format")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	headerLen := len(envelopeMagic) + 1
	if len(data) < headerLen+aead.NonceSize()+aead.Overhead() {
		return nil, errors.New("ciphertext too short")
	}
	nonce := data[headerLen : headerLen+aead.NonceSize()]
	ciphertext := data[headerLen+aead.NonceSize():]
	return aead.Open(nil, nonce, ciphertext, noteAAD(id))
}

func encryptLegacy(plaintext, key []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	ciphertext := aead.Seal(nil, nonce, plaintext, nil)
	return append(nonce, ciphertext...), nil
}

func decryptLegacy(data, key []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(data) < aead.NonceSize()+aead.Overhead() {
		return nil, errors.New("ciphertext too short")
	}
	nonce := data[:aead.NonceSize()]
	return aead.Open(nil, nonce, data[aead.NonceSize():], nil)
}
