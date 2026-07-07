// Package store handles the control-plane API token: it persists a working token in the OS
// secret store (macOS Keychain / Linux Secret Service / Windows Credential Manager) via
// go-keyring, keyed by host, and it DISCOVERS the orchestrator's token automatically (the
// QA_API_TOKEN env var or the config/.api_token file the server writes) so the operator
// rarely has to type it. All persistence is best-effort: a missing or locked keyring is
// never fatal — the client falls back to typing the token.
package store

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/zalando/go-keyring"
)

const service = "panchito"

// SaveToken stores a non-empty token for host. Errors are swallowed (the token is a
// convenience, not a requirement).
func SaveToken(host, token string) {
	if token == "" {
		return
	}
	_ = keyring.Set(service, host, token)
}

// LoadToken returns the saved token for host, or "" if none is stored or the keyring is
// unavailable.
func LoadToken(host string) string {
	token, err := keyring.Get(service, host)
	if err != nil {
		return ""
	}
	return token
}

// DeleteToken forgets the saved token for host — the connect screen's "forget" action, so a
// stale token (e.g. for a host that now serves a different app) can be cleared.
func DeleteToken(host string) {
	_ = keyring.Delete(service, host)
}

// SaveLastHost / LoadLastHost remember the host the operator last successfully reached, so the
// console reopens pointed at it instead of the built-in default. Without this, a session saved
// for a non-default host (e.g. localhost:8088) is never restored — startup only ever loads the
// default host's token, orphaning the session and forcing a fresh login every launch.
//
// The host is NOT a secret, so it lives in a plain file under the user config dir (not the
// keyring) — this also sidesteps the cross-platform keyring-key pitfalls a non-host key hit
// before. Best-effort throughout: a read/write failure just falls back to the default host.

func lastHostPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "panchito", "last-host"), nil
}

func SaveLastHost(host string) {
	if host == "" {
		return // never let an empty host overwrite a good remembered one
	}
	path, err := lastHostPath()
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return
	}
	_ = os.WriteFile(path, []byte(host), 0o600)
}

func LoadLastHost() string {
	path, err := lastHostPath()
	if err != nil {
		return ""
	}
	return readTrimmed(path)
}

// DiscoverToken finds the orchestrator's API token WITHOUT the operator typing it, mirroring
// how the server resolves it (index.ts): the QA_API_TOKEN env var first; else the
// config/.api_token file the server auto-generates on first boot, located by walking UP from
// the working directory to the panchito repo (so the console works when launched from a
// subdirectory). Returns the token plus a short source label ("$QA_API_TOKEN" or
// "config/.api_token"), or ("","") when nothing is found.
//
// Trust model: PANCHITO_ROOT is operator-set and trusted as-is. Directories found by
// walking up are trusted ONLY when they have the repo's shape (both a config/apps AND a
// config/e2e directory beside the token), so a stray config/.api_token planted in some
// unrelated parent directory is never read and sent as a credential.
func DiscoverToken() (token, source string) {
	if t := strings.TrimSpace(os.Getenv("QA_API_TOKEN")); t != "" {
		return t, "$QA_API_TOKEN"
	}
	if r := strings.TrimSpace(os.Getenv("PANCHITO_ROOT")); r != "" {
		if t := readTrimmed(filepath.Join(r, "config", ".api_token")); t != "" {
			return t, "config/.api_token"
		}
	}
	if cwd, err := os.Getwd(); err == nil {
		for _, dir := range ancestors(cwd) { // closest first
			if isRepoRoot(dir) {
				if t := readTrimmed(filepath.Join(dir, "config", ".api_token")); t != "" {
					return t, "config/.api_token"
				}
			}
		}
	}
	return "", ""
}

func readTrimmed(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// ancestors lists dir and each parent up to the filesystem root, closest first.
func ancestors(dir string) []string {
	var out []string
	for {
		out = append(out, dir)
		parent := filepath.Dir(dir)
		if parent == dir {
			return out
		}
		dir = parent
	}
}

// isRepoRoot reports whether dir has the panchito repo's shape (both config/apps and
// config/e2e) — a strong-enough signal that a lone planted config/.api_token elsewhere is not
// mistaken for the real one.
func isRepoRoot(dir string) bool {
	return isDir(filepath.Join(dir, "config", "apps")) && isDir(filepath.Join(dir, "config", "e2e"))
}

func isDir(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.IsDir()
}
