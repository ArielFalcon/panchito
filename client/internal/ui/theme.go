package ui

import "github.com/charmbracelet/lipgloss"

// Brand palette — mirrors src/tui/theme.tsx. (A shared contract/theme.json sync is
// a later refinement; the palette is small and stable, and the rich live screen is
// where it earns its keep.)
var (
	colSuccess = lipgloss.Color("#3b7a57")
	colError   = lipgloss.Color("#c0392b")
	colWarning = lipgloss.Color("#c2891b")
	colInfo    = lipgloss.Color("#4a6877")
	colMuted   = lipgloss.Color("#6b685b")
	colAccent  = lipgloss.Color("#c24e2c")
)

var (
	titleStyle  = lipgloss.NewStyle().Bold(true).Foreground(colAccent)
	labelStyle  = lipgloss.NewStyle().Foreground(colMuted)
	hintStyle   = lipgloss.NewStyle().Foreground(colMuted).Italic(true)
	errorStyle  = lipgloss.NewStyle().Foreground(colError)
	okStyle     = lipgloss.NewStyle().Foreground(colSuccess)
	shadowStyle = lipgloss.NewStyle().Foreground(colWarning)
	infoStyle   = lipgloss.NewStyle().Foreground(colInfo)
	screenStyle = lipgloss.NewStyle().Padding(1, 2)
)
