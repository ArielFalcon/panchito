package ui

import (
	"context"
	"strings"
	"time"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/contract"
	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// helpSelectedMsg: the user picked "Help" from the home menu.
type helpSelectedMsg struct{}

// helpModel is the conversational help assistant (backed by /api/help): a static
// quick-reference, then free-form Q&A with Markdown answers. The conversation scrolls in
// a viewport (a long Glamour answer no longer overflows the screen); the header and the
// input stay pinned. ↑↓/pgup/pgdn scroll; everything else types into the input.
type helpModel struct {
	client  *api.Client
	input   textinput.Model
	entries []chatEntry
	loading bool
	width   int
	height  int
	vp      viewport.Model
	ready   bool
}

func newHelpModel(client *api.Client) helpModel {
	ti := textinput.New()
	ti.Placeholder = "ask about panchito…"
	ti.Prompt = "" // the screen draws its own ember caret
	ti.CharLimit = 300
	ti.Width = 50
	ti.Focus()
	return helpModel{client: client, input: ti}
}

func (m helpModel) Init() tea.Cmd { return textinput.Blink }

func (m *helpModel) resize(w, h int) {
	m.width, m.height = w, h
	cw := contentWidth(w)
	// header (rule + blank) + input block (blank + input + blank + hint) + screen padding.
	vpH := h - 2 - 4 - 2
	if vpH < 3 {
		vpH = 3
	}
	if !m.ready {
		m.vp = viewport.New(cw, vpH)
		m.ready = true
	} else {
		m.vp.Width, m.vp.Height = cw, vpH
	}
	m.refresh()
}

// refresh rebuilds the scrollable conversation and pins the view to the latest answer.
func (m *helpModel) refresh() {
	if m.ready {
		m.vp.SetContent(m.conversation(contentWidth(m.width)))
		m.vp.GotoBottom()
	}
}

func (m helpModel) Update(msg tea.Msg) (helpModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.resize(msg.Width, msg.Height)
		return m, nil
	case answerMsg:
		m.loading = false
		m.entries = append(m.entries, chatEntry{role: "a", text: renderMarkdown(msg.text, contentWidth(m.width)), raw: msg.text})
		m.refresh()
		return m, nil
	case errMsg:
		m.loading = false
		m.entries = append(m.entries, chatEntry{role: "err", text: msg.err.Error()})
		m.refresh()
		return m, nil
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
			m.refresh()
			return m, helpAskCmd(m.client, q)
		case "up", "down", "pgup", "pgdown":
			if m.ready {
				var cmd tea.Cmd
				m.vp, cmd = m.vp.Update(msg)
				return m, cmd
			}
		}
	}
	var cmd tea.Cmd
	m.input, cmd = m.input.Update(msg)
	return m, cmd
}

// conversation is the scrollable body: the quick-reference until the first question, then
// every exchange (no cap — the viewport scrolls, so nothing is dropped).
func (m helpModel) conversation(w int) string {
	var b strings.Builder
	if len(m.entries) == 0 {
		b.WriteString(hintStyle.Render("panchito drives autonomous E2E QA: pick a project, choose a target and mode,") + "\n")
		b.WriteString(hintStyle.Render("and watch the agent generate, run and review Playwright tests against DEV.") + "\n\n")
		b.WriteString(labelStyle.Render("modes  ") + hintStyle.Render("diff · complete · exhaustive · manual · context") + "\n")
		b.WriteString(labelStyle.Render("shadow ") + hintStyle.Render("runs the full pipeline but publishes nothing — safe to demo") + "\n")
		b.WriteString(labelStyle.Render("in run ") + hintStyle.Render("a ask · c continue failed · ↑↓ scroll · esc back") + "\n\n")
		b.WriteString(hintStyle.Render("…or ask me anything below."))
	}
	for _, e := range m.entries {
		switch e.role {
		case "q":
			b.WriteString(renderSegs("", sg("▸ ", colEmber)) + lipgloss.NewStyle().Bold(true).Foreground(colFg).Render(e.text) + "\n")
		case "err":
			b.WriteString(errorStyle.Render("✗ "+e.text) + "\n")
		default:
			b.WriteString(e.text + "\n")
		}
	}
	if m.loading {
		b.WriteString(infoStyle.Render("thinking…"))
	}
	return strings.TrimRight(b.String(), "\n")
}

func (m helpModel) View() string {
	w := contentWidth(m.width)
	header := accentRule(w, "panchito help", "")
	input := renderSegs("", sg("› ", colEmber)) + m.input.View()
	hint := hintStyle.Render("↑↓ scroll · enter ask · esc back · ctrl+c quit")
	body := m.conversation(w)
	if m.ready {
		body = m.vp.View()
	}
	return screenStyle.Render(header + "\n\n" + body + "\n\n" + input + "\n\n" + hint)
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
