package ui

import (
	"context"
	"strings"
	"time"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/contract"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
)

// helpSelectedMsg: the user picked "Help" from the home menu.
type helpSelectedMsg struct{}

// helpModel is the conversational help assistant (backed by /api/help): a static
// quick-reference up top, then free-form Q&A with Markdown answers.
type helpModel struct {
	client  *api.Client
	input   textinput.Model
	entries []chatEntry
	loading bool
}

func newHelpModel(client *api.Client) helpModel {
	ti := textinput.New()
	ti.Placeholder = "ask about panchito…"
	ti.CharLimit = 300
	ti.Width = 50
	ti.Focus()
	return helpModel{client: client, input: ti}
}

func (m helpModel) Init() tea.Cmd { return textinput.Blink }

func (m helpModel) Update(msg tea.Msg) (helpModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "esc":
			return m, func() tea.Msg { return backMsg{} }
		case "enter":
			q := strings.TrimSpace(m.input.Value())
			if q == "" || m.loading {
				return m, nil
			}
			m.entries = append(m.entries, chatEntry{role: "q", text: q, raw: q})
			m.input.SetValue("")
			m.loading = true
			return m, helpAskCmd(m.client, q)
		}
	case answerMsg:
		m.loading = false
		m.entries = append(m.entries, chatEntry{role: "a", text: renderMarkdown(msg.text), raw: msg.text})
		return m, nil
	case errMsg:
		m.loading = false
		m.entries = append(m.entries, chatEntry{role: "err", text: msg.err.Error()})
		return m, nil
	}
	var cmd tea.Cmd
	m.input, cmd = m.input.Update(msg)
	return m, cmd
}

func (m helpModel) View() string {
	var b strings.Builder
	b.WriteString(titleStyle.Render("? panchito help") + "\n\n")

	if len(m.entries) == 0 {
		b.WriteString(hintStyle.Render("panchito drives autonomous E2E QA: pick a project, choose a target and mode,") + "\n")
		b.WriteString(hintStyle.Render("and watch the agent generate, run and review Playwright tests against DEV.") + "\n\n")
		b.WriteString(labelStyle.Render("modes ") + hintStyle.Render("diff · complete · exhaustive · manual · context") + "\n")
		b.WriteString(labelStyle.Render("shadow") + hintStyle.Render(" runs the full pipeline but publishes nothing — safe to demo") + "\n")
		b.WriteString(labelStyle.Render("in run") + hintStyle.Render(" a ask · c continue failed · ↑↓ scroll · esc back") + "\n\n")
		b.WriteString(hintStyle.Render("…or ask me anything below.") + "\n")
	}

	start := 0
	if len(m.entries) > maxChatShown {
		start = len(m.entries) - maxChatShown
	}
	for _, e := range m.entries[start:] {
		switch e.role {
		case "q":
			b.WriteString(okStyle.Render("▶ "+e.text) + "\n")
		case "err":
			b.WriteString(errorStyle.Render("✗ "+e.text) + "\n")
		default:
			b.WriteString(e.text + "\n")
		}
	}
	if m.loading {
		b.WriteString(infoStyle.Render("thinking…") + "\n")
	}
	b.WriteString("\n" + m.input.View() + "\n")
	b.WriteString("\n" + hintStyle.Render("enter ask · esc back · ctrl+c quit"))
	return screenStyle.Render(b.String())
}

func helpAskCmd(c *api.Client, q string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		res, err := c.Help(ctx, contract.AskRequest{Question: q})
		if err != nil {
			return errMsg{err}
		}
		return answerMsg{text: res.Answer}
	}
}
