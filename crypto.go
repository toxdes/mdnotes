package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"io"
)

const nonceSize = 12

func deriveKey(s string) []byte {
	h := sha256.Sum256([]byte(s))
	return h[:]
}

func encrypt(plaintext, key []byte) ([]byte, error) {
	if key == nil {
		return plaintext, nil
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aesgcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, nonceSize)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	ciphertext := aesgcm.Seal(nil, nonce, plaintext, nil)
	out := make([]byte, nonceSize+len(ciphertext))
	copy(out, nonce)
	copy(out[nonceSize:], ciphertext)
	return out, nil
}

func decrypt(data, key []byte) ([]byte, error) {
	if key == nil {
		return data, nil
	}
	if len(data) < nonceSize {
		return nil, errors.New("ciphertext too short")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aesgcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := data[:nonceSize]
	ciphertext := data[nonceSize:]
	return aesgcm.Open(nil, nonce, ciphertext, nil)
}
