package main

import (
	"testing"
)

func TestParseRuntimeFlags(t *testing.T) {
	flags, rest := parseRuntimeFlags([]string{"--opencode", "agent", "status"})
	if flags.provider != "opencode" || flags.dual || len(rest) != 2 || rest[0] != "agent" {
		t.Fatalf("opencode parse: flags=%+v rest=%v", flags, rest)
	}

	flags, rest = parseRuntimeFlags([]string{"--dual", "agent", "set", "--codex"})
	if flags.provider != "codex" || flags.dual || len(rest) != 2 || rest[0] != "agent" || rest[1] != "set" {
		t.Fatalf("last runtime flag should win: flags=%+v rest=%v", flags, rest)
	}
}

func TestDefaultHostURLAddsScheme(t *testing.T) {
	t.Setenv("QA_HOST", "localhost:9090")
	if got := defaultHostURL(); got != "http://localhost:9090" {
		t.Fatalf("host url = %q", got)
	}

	t.Setenv("QA_HOST", "https://qa.example.test/")
	if got := defaultHostURL(); got != "https://qa.example.test" {
		t.Fatalf("host url = %q", got)
	}
}
