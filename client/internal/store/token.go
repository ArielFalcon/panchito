// Package store persists the control-plane token in the OS secret store (macOS
// Keychain / Linux Secret Service / Windows Credential Manager) via go-keyring,
// keyed by host. Best-effort: a missing or locked keyring is never fatal — the
// client just falls back to typing the token.
package store

import "github.com/zalando/go-keyring"

const service = "panchito"

// SaveToken stores a non-empty token for host. Errors are swallowed (the token is
// a convenience, not a requirement).
func SaveToken(host, token string) {
	if token == "" {
		return
	}
	_ = keyring.Set(service, host, token)
}

// LoadToken returns the saved token for host, or "" if none is stored or the
// keyring is unavailable.
func LoadToken(host string) string {
	token, err := keyring.Get(service, host)
	if err != nil {
		return ""
	}
	return token
}
