package ui

import (
	"context"
	"strings"
	"time"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/contract"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type launchStep int

const (
	stepTarget launchStep = iota
	stepMode
	stepShadow
	launchStepCount
)

type option struct {
	label string
	value string
}

var (
	targetOptions = []option{{"e2e   — browser tests against DEV", "e2e"}, {"code  — source-logic tests, no browser", "code"}}
	modeOptions   = []option{
		{"diff        — the blast radius of one commit", "diff"},
		{"complete    — important uncovered flows", "complete"},
		{"exhaustive  — re-evaluate the whole suite", "exhaustive"},
		{"manual      — guided generation", "manual"},
		{"context     — refresh the FE↔BE map", "context"},
	}
	shadowOptions = []option{{"no   — publish PRs and open Issues", "false"}, {"yes  — shadow run, no side effects", "true"}}
)

// launcherModel walks target → mode → shadow, then emits a launchMsg. Pure UI: the
// root holds the client and performs CreateRun.
type launcherModel struct {
	app    string
	step   launchStep
	cursor int
	target string
	mode   string
	err    string
}

func newLauncherModel(app string) launcherModel {
	return launcherModel{app: app}
}

// createRunCmd performs CreateRun (the root holds the client) and reports the new
// run id, or an error, back to the launcher screen.
func createRunCmd(c *api.Client, in contract.CreateRunInput) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		res, err := c.CreateRun(ctx, in)
		if err != nil {
			return errMsg{err}
		}
		return runCreatedMsg{id: res.Id}
	}
}

func (m launcherModel) options() []option {
	switch m.step {
	case stepTarget:
		return targetOptions
	case stepMode:
		return modeOptions
	default:
		return shadowOptions
	}
}

func (m launcherModel) Update(msg tea.Msg) (launcherModel, tea.Cmd) {
	switch msg := msg.(type) {
	case errMsg:
		m.err = msg.err.Error()
		return m, nil
	case tea.KeyMsg:
		opts := m.options()
		switch msg.String() {
		case "up", "k":
			if m.cursor > 0 {
				m.cursor--
			}
		case "down", "j":
			if m.cursor < len(opts)-1 {
				m.cursor++
			}
		case "esc":
			if m.step == stepTarget {
				return m, func() tea.Msg { return backMsg{} }
			}
			m.step--
			m.cursor = 0
			m.err = ""
			return m, nil
		case "enter":
			return m.choose(opts[m.cursor].value)
		}
	}
	return m, nil
}

func (m launcherModel) choose(value string) (launcherModel, tea.Cmd) {
	m.err = ""
	switch m.step {
	case stepTarget:
		m.target = value
		m.step = stepMode
		m.cursor = 0
		return m, nil
	case stepMode:
		m.mode = value
		m.step = stepShadow
		m.cursor = 0
		return m, nil
	default: // stepShadow → launch
		shadow := value == "true"
		in := contract.CreateRunInput{
			App:    m.app,
			Target: contract.CreateRunInputTarget(m.target),
			Mode:   contract.CreateRunInputMode(m.mode),
			Shadow: &shadow,
		}
		return m, func() tea.Msg { return launchMsg{input: in} }
	}
}

func (m launcherModel) View() string {
	titles := []string{"Test target", "Run mode", "Shadow mode"}
	var b strings.Builder
	b.WriteString(titleStyle.Render("launch") + "  " + labelStyle.Render(m.app) + "\n\n")
	b.WriteString(infoStyle.Render(titles[m.step]) + "\n")
	for i, o := range m.options() {
		marker := "  "
		label := o.label
		if i == m.cursor {
			marker = okStyle.Render("▸ ")
			label = lipgloss.NewStyle().Bold(true).Render(label)
		}
		b.WriteString(marker + label + "\n")
	}
	if m.err != "" {
		b.WriteString("\n" + errorStyle.Render("✗ "+m.err) + "\n")
	}
	b.WriteString("\n" + hintStyle.Render("↑↓ choose · enter next · esc back"))
	return screenStyle.Render(b.String())
}
