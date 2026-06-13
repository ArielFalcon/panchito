package ui

import (
	"context"
	"strings"
	"time"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/contract"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/glamour"
	"github.com/charmbracelet/lipgloss"
)

const maxChatShown = 8

type chatEntry struct {
	role string // "q" | "a" | "err"
	text string // display (answers are Glamour-rendered ANSI)
	raw  string // original text (sent back as history)
}

// chatModel is the read-only run Q&A (the qa-assistant), with Markdown answers
// rendered by Glamour — the one capability the terminal can show better than plain.
type chatModel struct {
	client  *api.Client
	runID   string
	input   textinput.Model
	entries []chatEntry
	loading bool
	width   int
}

func newChatModel(client *api.Client, runID string) chatModel {
	ti := textinput.New()
	ti.Placeholder = "ask about this run…"
	ti.Prompt = "" // the screen draws its own ember caret
	ti.CharLimit = 400
	ti.Width = 50
	ti.Focus()
	return chatModel{client: client, runID: runID, input: ti}
}

func (m chatModel) Init() tea.Cmd { return textinput.Blink }

func (m chatModel) Update(msg tea.Msg) (chatModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
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
			hist := chatHistory(m.entries) // prior exchanges, before this question
			m.entries = append(m.entries, chatEntry{role: "q", text: q, raw: q})
			m.input.SetValue("")
			m.loading = true
			return m, askCmd(m.client, m.runID, q, hist)
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

func (m chatModel) View() string {
	w := contentWidth(m.width)
	var b strings.Builder
	b.WriteString(accentRule(w, "ask", hintStyle.Render(m.runID)) + "\n\n")
	start := 0
	if len(m.entries) > maxChatShown {
		start = len(m.entries) - maxChatShown
	}
	for _, e := range m.entries[start:] {
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
		b.WriteString(infoStyle.Render("thinking…") + "\n")
	}
	b.WriteString("\n" + renderSegs("", sg("› ", colEmber)) + m.input.View() + "\n")
	b.WriteString("\n" + hintStyle.Render("enter ask · esc back · ctrl+c quit"))
	return screenStyle.Render(b.String())
}

type answerMsg struct{ text string }

func askCmd(c *api.Client, runID, q string, history []contract.ChatEntry) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		req := contract.AskRequest{Question: q}
		if len(history) > 0 {
			req.History = &history
		}
		res, err := c.Ask(ctx, runID, req)
		if err != nil {
			return errMsg{err}
		}
		return answerMsg{text: res.Answer}
	}
}

func chatHistory(entries []chatEntry) []contract.ChatEntry {
	var out []contract.ChatEntry
	for _, e := range entries {
		if e.role == "q" || e.role == "a" {
			out = append(out, contract.ChatEntry{Role: e.role, Text: e.raw})
		}
	}
	return out
}

func renderMarkdown(md string) string {
	out, err := glamour.Render(md, "dark")
	if err != nil {
		return md
	}
	return strings.TrimRight(out, "\n")
}
