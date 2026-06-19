package auth

import (
	"fmt"
	"os/exec"
	"runtime"
	"strings"
)

// OpenBrowser best-effort opens url in the operator's default browser so they don't have to
// copy the verification URL by hand. It is fire-and-forget: a headless box (no opener) simply
// fails silently and the UI still shows the URL + user code to type manually.
//
// It refuses any non-https URL: the only value passed here is GitHub's verification_uri, and
// handing an unexpected scheme (file:, javascript:, …) to the OS opener — were the response ever
// tampered with — is exactly what we don't want. The UI still prints the URL regardless.
func OpenBrowser(url string) error {
	if !strings.HasPrefix(url, "https://") {
		return fmt.Errorf("refusing to open non-https URL: %q", url)
	}
	var cmd string
	var args []string
	switch runtime.GOOS {
	case "darwin":
		cmd, args = "open", []string{url}
	case "windows":
		cmd, args = "rundll32", []string{"url.dll,FileProtocolHandler", url}
	default: // linux, *bsd
		cmd, args = "xdg-open", []string{url}
	}
	return exec.Command(cmd, args...).Start()
}
