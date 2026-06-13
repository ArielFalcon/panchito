package ui

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/contract"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
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
	width         int
	diffCommits   int // diff mode: how many commits the diff spans (1–20, ← → to adjust)
}

const maxDiffCommits = 20

func newLauncherModel(app string) launcherModel {
	ti := textinput.New()
	ti.Placeholder = "e.g. test the contact form's validation"
	ti.Prompt = "" // the screen draws its own ember caret
	ti.CharLimit = 2000
	ti.Width = 52
	return launcherModel{app: app, guidanceInput: ti, diffCommits: 1}
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
	case tea.WindowSizeMsg:
		m.width = msg.Width
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
		case "left", "h":
			// On the diff option, ← narrows the commit window (the diff blast radius).
			if m.step == stepMode && opts[m.cursor].value == "diff" && m.diffCommits > 1 {
				m.diffCommits--
			}
		case "right", "l":
			if m.step == stepMode && opts[m.cursor].value == "diff" && m.diffCommits < maxDiffCommits {
				m.diffCommits++
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
		if m.mode == "diff" && m.diffCommits > 1 {
			c := m.diffCommits
			in.Commits = &c
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
	w := contentWidth(m.width)
	var b strings.Builder
	b.WriteString(accentRule(w, "launch", labelStyle.Render(m.app)+"  "+m.breadcrumb()) + "\n\n")

	if m.step == stepGuidance {
		b.WriteString(labelRule(w, "guidance", "") + "\n")
		b.WriteString(hintStyle.Render("describe what to test — the agent will focus on this") + "\n\n")
		b.WriteString(renderSegs("", sg("› ", colEmber)) + m.guidanceInput.View() + "\n")
		b.WriteString("\n" + hintStyle.Render("enter continue · esc back"))
		return screenStyle.Render(b.String())
	}

	titles := map[launchStep]string{stepTarget: "test target", stepMode: "run mode", stepShadow: "shadow mode"}
	b.WriteString(labelRule(w, titles[m.step], "") + "\n")
	opts := m.options()
	for i, o := range opts {
		hint := ""
		if m.step == stepMode && o.value == "diff" {
			// The adjustable commit window — ‹ … › signals ← → editability.
			hint = fmt.Sprintf("‹ %s ›", pluralize(m.diffCommits, "commit", "commits"))
		}
		if i == m.cursor {
			b.WriteString(selectedRow(w, "", o.label, hint) + "\n")
		} else {
			b.WriteString(normalRow(w, "", o.label, hint) + "\n")
		}
	}
	if m.err != "" {
		b.WriteString("\n" + errorStyle.Render("✗ "+m.err) + "\n")
	}
	foot := "↑↓ choose · enter next · esc back"
	if m.step == stepMode && opts[m.cursor].value == "diff" {
		foot = "↑↓ choose · ← → commits · enter next · esc back"
	}
	b.WriteString("\n" + hintStyle.Render(foot))
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
