package store

import (
	"os"
	"path/filepath"
	"testing"
)

// The token is discovered from QA_API_TOKEN first (mirrors the server's own resolution order),
// so an operator who exported it never has to paste it.
func TestDiscoverTokenFromEnv(t *testing.T) {
	t.Setenv("QA_API_TOKEN", "envtok")

	tok, src := DiscoverToken()

	if tok != "envtok" {
		t.Fatalf("env token = %q, want envtok", tok)
	}
	if src != "$QA_API_TOKEN" {
		t.Fatalf("env source = %q, want $QA_API_TOKEN", src)
	}
}

// When the env var is unset, the token is read from the orchestrator's token file
// (config/.api_token under the configured root), trimmed — the same file the server writes.
func TestDiscoverTokenFromFile(t *testing.T) {
	t.Setenv("QA_API_TOKEN", "")
	dir := t.TempDir()
	cfg := filepath.Join(dir, "config")
	if err := os.MkdirAll(cfg, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cfg, ".api_token"), []byte("filetok\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AI_PIPELINE_ROOT", dir)

	tok, src := DiscoverToken()

	if tok != "filetok" {
		t.Fatalf("file token = %q, want filetok (trimmed)", tok)
	}
	if src == "" {
		t.Fatal("the source must name the file")
	}
}

// mkRepo creates an ai-pipeline-shaped repo (config/apps + config/e2e) at dir, with the given
// token in config/.api_token.
func mkRepo(t *testing.T, dir, token string) {
	t.Helper()
	for _, d := range []string{"apps", "e2e"} {
		if err := os.MkdirAll(filepath.Join(dir, "config", d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "config", ".api_token"), []byte(token+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

// The console finds the token even when launched from a SUBDIRECTORY of the repo — it walks up
// to the repo root (recognised by its shape: config/apps + config/e2e).
func TestDiscoverTokenWalksUpToRepo(t *testing.T) {
	t.Setenv("QA_API_TOKEN", "")
	t.Setenv("AI_PIPELINE_ROOT", "")
	repo := t.TempDir()
	mkRepo(t, repo, "repotok")
	sub := filepath.Join(repo, "client", "internal")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Chdir(sub)

	tok, src := DiscoverToken()
	if tok != "repotok" {
		t.Fatalf("walk-up from a subdir should find the repo token; got %q", tok)
	}
	if src != "config/.api_token" {
		t.Fatalf("source = %q, want config/.api_token", src)
	}
}

// A config/.api_token without the repo shape (no config/e2e) is NOT trusted — a forged
// config/apps marker alone must not make the walk-up read a planted token.
func TestDiscoverTokenIgnoresForgedMarker(t *testing.T) {
	t.Setenv("QA_API_TOKEN", "")
	t.Setenv("AI_PIPELINE_ROOT", "")
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "config", "apps"), 0o755); err != nil { // only one marker
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config", ".api_token"), []byte("planted"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Chdir(dir)

	if tok, _ := DiscoverToken(); tok != "" {
		t.Fatalf("a half-marker directory must not be trusted; got %q", tok)
	}
}

// When two repo-shaped roots are nested, the CLOSEST one to the working directory wins.
func TestDiscoverTokenClosestRepoWins(t *testing.T) {
	t.Setenv("QA_API_TOKEN", "")
	t.Setenv("AI_PIPELINE_ROOT", "")
	outer := t.TempDir()
	mkRepo(t, outer, "outer")
	inner := filepath.Join(outer, "inner")
	mkRepo(t, inner, "inner")
	work := filepath.Join(inner, "client")
	if err := os.MkdirAll(work, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Chdir(work)

	if tok, _ := DiscoverToken(); tok != "inner" {
		t.Fatalf("the closest repo root should win; got %q want inner", tok)
	}
}

// The last host the operator successfully reached is remembered across launches (in a plain
// file — the host is not a secret), so a returning operator neither retypes it nor has their
// per-host saved session orphaned under a host the startup never looks at.
func TestSaveAndLoadLastHost(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", "") // Linux: force the $HOME/.config path
	t.Setenv("HOME", t.TempDir())   // macOS + Linux: redirect os.UserConfigDir() into a temp dir

	if got := LoadLastHost(); got != "" {
		t.Fatalf("no host saved yet should be empty; got %q", got)
	}

	SaveLastHost("localhost:8088")

	if got := LoadLastHost(); got != "localhost:8088" {
		t.Fatalf("LoadLastHost = %q, want localhost:8088", got)
	}
}

// An empty host is never persisted (so a failed first connect can't wipe a good remembered host).
func TestSaveLastHostIgnoresEmpty(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("HOME", t.TempDir())

	SaveLastHost("localhost:9000")
	SaveLastHost("")

	if got := LoadLastHost(); got != "localhost:9000" {
		t.Fatalf("an empty host must not overwrite the remembered one; got %q", got)
	}
}

// No env var and no repo in scope → no token (the screen falls back to a manual field with a
// concrete instruction).
func TestDiscoverTokenNone(t *testing.T) {
	t.Setenv("QA_API_TOKEN", "")
	t.Setenv("AI_PIPELINE_ROOT", t.TempDir()) // a root with no config/.api_token
	t.Chdir(t.TempDir())                       // a cwd whose ancestors are not the repo

	if tok, _ := DiscoverToken(); tok != "" {
		t.Fatalf("with no env and no repo in scope, token should be empty; got %q", tok)
	}
}
