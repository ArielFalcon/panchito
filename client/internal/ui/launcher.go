package ui

import (
	"context"
	"strings"
	"time"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/contract"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type launchStep int

const (
	stepTarget launchStep = iota
	stepMode
	stepGuidance // only for mode=manual
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

// launcherModel walks target → mode → (guidance, if manual) → shadow, then emits a
// launchMsg. Pure UI: the root holds the client and performs CreateRun.
type launcherModel struct {
	app           string
	step          launchStep
	cursor        int
	target        string
	mode          string
	guidance      string
	guidanceInput textinput.Model
	err           string
}

func newLauncherModel(app string) launcherModel {
	ti := textinput.New()
	ti.Placeholder = "e.g. test the contact form's validation"
	ti.CharLimit = 2000
	ti.Width = 52
	return launcherModel{app: app, guidanceInput: ti}
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

// continueCmd re-runs the named failed cases as a continuation; the new run opens
// in a fresh live screen.
func continueCmd(c *api.Client, id string, cases []string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		res, err := c.Continue(ctx, id, contract.ContinueRequest{Cases: &cases})
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
	case stepShadow:
		return shadowOptions
	}
	return nil
}

func (m launcherModel) Update(msg tea.Msg) (launcherModel, tea.Cmd) {
	switch msg := msg.(type) {
	case errMsg:
		m.err = msg.err.Error()
		return m, nil
	case tea.KeyMsg:
		if m.step == stepGuidance {
			return m.updateGuidance(msg)
		}
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
			return m.back()
		case "enter":
			return m.choose(opts[m.cursor].value)
		}
	}
	return m, nil
}

func (m launcherModel) back() (launcherModel, tea.Cmd) {
	m.err = ""
	m.cursor = 0
	switch m.step {
	case stepTarget:
		return m, func() tea.Msg { return backMsg{} }
	case stepMode:
		m.step = stepTarget
	case stepShadow:
		if m.mode == "manual" {
			m.step = stepGuidance
			m.guidanceInput.Focus()
			return m, textinput.Blink
		}
		m.step = stepMode
	}
	return m, nil
}

func (m launcherModel) choose(value string) (launcherModel, tea.Cmd) {
	m.err = ""
	m.cursor = 0
	switch m.step {
	case stepTarget:
		m.target = value
		m.step = stepMode
		return m, nil
	case stepMode:
		m.mode = value
		if value == "manual" {
			m.step = stepGuidance
			m.guidanceInput.Focus()
			return m, textinput.Blink
		}
		m.step = stepShadow
		return m, nil
	default: // stepShadow → launch
		shadow := value == "true"
		in := contract.CreateRunInput{
			App:    m.app,
			Target: contract.CreateRunInputTarget(m.target),
			Mode:   contract.CreateRunInputMode(m.mode),
			Shadow: &shadow,
		}
		if m.mode == "manual" && m.guidance != "" {
			g := m.guidance
			in.Guidance = &g
		}
		return m, func() tea.Msg { return launchMsg{input: in} }
	}
}

func (m launcherModel) updateGuidance(msg tea.KeyMsg) (launcherModel, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.step = stepMode
		m.cursor = 0
		return m, nil
	case "enter":
		m.guidance = strings.TrimSpace(m.guidanceInput.Value())
		m.step = stepShadow
		m.cursor = 0
		return m, nil
	}
	var cmd tea.Cmd
	m.guidanceInput, cmd = m.guidanceInput.Update(msg)
	return m, cmd
}

func (m launcherModel) View() string {
	var b strings.Builder
	b.WriteString(titleStyle.Render("launch") + "  " + labelStyle.Render(m.app) + "  " + m.breadcrumb() + "\n\n")

	if m.step == stepGuidance {
		b.WriteString(infoStyle.Render("Guidance") + "\n")
		b.WriteString(hintStyle.Render("describe what to test — the agent will focus on this") + "\n\n")
		b.WriteString(m.guidanceInput.View() + "\n")
		b.WriteString("\n" + hintStyle.Render("enter continue · esc back"))
		return screenStyle.Render(b.String())
	}

	titles := map[launchStep]string{stepTarget: "Test target", stepMode: "Run mode", stepShadow: "Shadow mode"}
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

// breadcrumb is a compact stepper showing where in the launch flow we are.
func (m launcherModel) breadcrumb() string {
	steps := []struct {
		step  launchStep
		label string
	}{
		{stepTarget, m.target},
		{stepMode, m.mode},
	}
	var parts []string
	for _, s := range steps {
		if s.label != "" {
			parts = append(parts, okStyle.Render(s.label))
		}
	}
	if len(parts) == 0 {
		return ""
	}
	return hintStyle.Render(strings.Join(parts, " › "))
}
