package ui

import "github.com/charmbracelet/lipgloss"

// Brand palette — truecolor, from the TUI redesign mock (docs/tui-vnext.md). Ember is
// the single signal/accent (cursor, selection, the one boxed element). The verdict ramp
// — pass/fail/flaky/infra — is the ONLY source of status color; greys carry structure
// (rules) and hierarchy (dim labels, faint hints). lipgloss degrades these hexes on
// non-truecolor terminals, so authoring in truecolor is safe.
var (
	colBg     = lipgloss.Color("#1b1a16")
	colFg     = lipgloss.Color("#e9e3d3")
	colDim    = lipgloss.Color("#9a9685")
	colFaint  = lipgloss.Color("#66635a")
	colEmber  = lipgloss.Color("#e0764f")
	colEmberS = lipgloss.Color("#d96a45")
	colPass   = lipgloss.Color("#5cc98e")
	colFail   = lipgloss.Color("#ef6275")
	colFlaky  = lipgloss.Color("#e6b13a")
	colInfra  = lipgloss.Color("#74a0b5")
	colRule   = lipgloss.Color("#34322a")
	colRuleS  = lipgloss.Color("#45433a")
	colCardBg = lipgloss.Color("#211f17")
	colWash   = lipgloss.Color("#2a2017")
)

// Semantic aliases keep every existing call site working while the palette upgrades:
// each screen picks up the new colors immediately, and the richer structure (rules,
// cards, selection wash) is layered on per screen via style.go.
var (
	colAccent  = colEmber
	colSuccess = colPass
	colError   = colFail
	colWarning = colFlaky
	colInfo    = colInfra
	colMuted   = colDim
)

var (
	titleStyle   = lipgloss.NewStyle().Bold(true).Foreground(colEmber)
	labelStyle   = lipgloss.NewStyle().Foreground(colDim)
	hintStyle    = lipgloss.NewStyle().Foreground(colFaint)
	eyebrowStyle = lipgloss.NewStyle().Bold(true).Foreground(colDim)
	errorStyle   = lipgloss.NewStyle().Foreground(colFail)
	okStyle      = lipgloss.NewStyle().Foreground(colPass)
	shadowStyle  = lipgloss.NewStyle().Foreground(colFlaky)
	infoStyle    = lipgloss.NewStyle().Foreground(colInfra)
	screenStyle  = lipgloss.NewStyle().Padding(1, 2)
)
