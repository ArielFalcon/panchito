package ui

import (
	"context"
	"strings"
	"time"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/contract"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/glamour"
)

type chatEntry struct {
	role string // "q" | "a" | "err"
	text string // display (answers are Glamour-rendered ANSI)
	raw  string // original text (sent back as history)
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

// renderMarkdown turns the assistant's Markdown answer into styled terminal output via
// Glamour — headings, lists, code blocks, emphasis — word-wrapped to the available width
// so it reads as a well-structured message rather than a flat blob clipped at 80 cols.
func renderMarkdown(md string, width int) string {
	if width < 20 {
		width = 20
	}
	r, err := glamour.NewTermRenderer(glamour.WithStandardStyle("dark"), glamour.WithWordWrap(width))
	if err != nil {
		out, e2 := glamour.Render(md, "dark")
		if e2 != nil {
			return md
		}
		return strings.TrimRight(out, "\n")
	}
	out, err := r.Render(md)
	if err != nil {
		return md
	}
	return strings.TrimRight(out, "\n")
}
