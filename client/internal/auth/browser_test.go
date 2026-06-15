package auth

import "testing"

// OpenBrowser refuses anything that is not an https URL — the only value it should ever receive
// is GitHub's verification_uri, and handing an unexpected scheme to the OS opener is a risk.
func TestOpenBrowserRejectsNonHTTPS(t *testing.T) {
	for _, bad := range []string{
		"http://github.com/login/device",
		"file:///etc/passwd",
		"javascript:alert(1)",
		"",
	} {
		if err := OpenBrowser(bad); err == nil {
			t.Fatalf("OpenBrowser(%q) should be refused", bad)
		}
	}
}
