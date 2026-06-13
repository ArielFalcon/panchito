package ui

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/store"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// connectModel is the first screen: host + token, then a connection probe
// (ListApps) that doubles as the auth check.
type connectModel struct {
	host       textinput.Model
	token      textinput.Model
	focus      int // 0 = host, 1 = token
	connecting bool
	err        string
	width      int
}

func newConnectModel() connectModel {
	host := textinput.New()
	host.Placeholder = "localhost:8080"
	host.Prompt = "" // the field draws its own ember caret
	host.SetValue("localhost:8080")
	host.CharLimit = 200
	host.Width = 34
	host.Focus()

	token := textinput.New()
	token.Placeholder = "(optional)"
	token.Prompt = ""
	token.EchoMode = textinput.EchoPassword
	token.CharLimit = 400
	token.Width = 34

	return connectModel{host: host, token: token}
}

func (m connectModel) Init() tea.Cmd {
	// Prefill the token from the OS keyring for the default host (side effect in a
	// Cmd, so constructing the model touches no OS services — tests stay hermetic).
	return tea.Batch(textinput.Blink, loadTokenCmd(m.host.Value()))
}

func loadTokenCmd(host string) tea.Cmd {
	return func() tea.Msg { return tokenLoadedMsg{token: store.LoadToken(host)} }
}

func (m connectModel) Update(msg tea.Msg) (connectModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tokenLoadedMsg:
		if msg.token != "" && m.token.Value() == "" {
			m.token.SetValue(msg.token)
			// A token was remembered from a previous session → skip the form and
			// connect straight away. A stale token just bounces back here with an error.
			if !m.connecting {
				m.connecting = true
				return m, connectCmd(m.host.Value(), m.token.Value())
			}
		}
		return m, nil
	case tea.KeyMsg:
		switch msg.String() {
		case "tab", "shift+tab", "up", "down":
			m.focus = 1 - m.focus
			if m.focus == 0 {
				m.host.Focus()
				m.token.Blur()
			} else {
				m.token.Focus()
				m.host.Blur()
			}
			return m, textinput.Blink
		case "enter":
			if m.connecting {
				return m, nil
			}
			m.connecting = true
			m.err = ""
			return m, connectCmd(m.host.Value(), m.token.Value())
		}
	case errMsg:
		m.connecting = false
		m.err = msg.err.Error()
		return m, nil
	case tea.WindowSizeMsg:
		m.width = msg.Width
		return m, nil
	}

	var cmd tea.Cmd
	if m.focus == 0 {
		m.host, cmd = m.host.Update(msg)
	} else {
		m.token, cmd = m.token.Update(msg)
	}
	return m, cmd
}

func (m connectModel) View() string {
	w := contentWidth(m.width)
	var b strings.Builder
	b.WriteString(bannerBox(w) + "\n\n")
	b.WriteString(labelRule(w, "connect", hintStyle.Render("control plane")) + "\n\n")
	b.WriteString(connectField("host ", m.focus == 0) + m.host.View() + "\n")
	b.WriteString(connectField("token", m.focus == 1) + m.token.View() + "\n\n")
	switch {
	case m.connecting:
		b.WriteString(infoStyle.Render("connecting…"))
	case m.err != "":
		b.WriteString(errorStyle.Render("✗ " + m.err))
	}
	b.WriteString("\n\n" + hintStyle.Render("tab switch · enter connect · ctrl+c quit"))
	return screenStyle.Render(b.String())
}

// connectField labels a form input, marking the focused one with an ember caret.
func connectField(label string, focused bool) string {
	if focused {
		return renderSegs("", sg("▸ ", colEmber)) + lipgloss.NewStyle().Foreground(colFg).Render(label+" ")
	}
	return "  " + labelStyle.Render(label+" ")
}

// connectCmd negotiates the version/capability handshake first (so a stale binary
// is told to update before anything else), then probes the server with ListApps
// (which also exercises auth) under a short deadline — returning connectedMsg on
// success or errMsg on failure.
func connectCmd(host, token string) tea.Cmd {
	return func() tea.Msg {
		base := host
		if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
			base = "http://" + base
		}
		c := api.New(base, token)
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()

		info, err := c.Handshake(ctx)
		if err != nil {
			return errMsg{err}
		}
		if !info.Compatible {
			msg := ""
			if info.Message != nil {
				msg = *info.Message
			}
			if msg == "" {
				msg = fmt.Sprintf("update panchito: server %s requires client >= %s", info.ServerVersion, info.MinClientVersion)
			}
			return errMsg{errors.New(msg)}
		}
		if info.ApiVersion != "" && info.ApiVersion != "v1" {
			return errMsg{fmt.Errorf("update panchito: server speaks API %s, this client speaks v1", info.ApiVersion)}
		}

		apps, err := c.ListApps(ctx)
		if err != nil {
			return errMsg{err}
		}
		store.SaveToken(host, token) // remember the working token for next time
		return connectedMsg{client: c, apps: apps, info: info}
	}
}
