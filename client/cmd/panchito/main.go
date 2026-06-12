// Command panchito is the installable terminal client for the Panchito control
// plane (the Go/Bubble Tea channel). It connects to a running orchestrator and,
// eventually, launches and watches QA runs live.
package main

import (
	"fmt"
	"os"

	"github.com/ArielFalcon/panchito/internal/ui"
	tea "github.com/charmbracelet/bubbletea"
)

func main() {
	p := tea.NewProgram(ui.New(), tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "panchito:", err)
		os.Exit(1)
	}
}
