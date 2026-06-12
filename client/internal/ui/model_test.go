package ui

import (
	"testing"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/contract"
	tea "github.com/charmbracelet/bubbletea"
)

func TestConnectedMsgSwitchesToHome(t *testing.T) {
	m := New()
	if m.screen != screenConnect {
		t.Fatalf("initial screen = %v, want connect", m.screen)
	}
	updated, _ := m.Update(connectedMsg{client: api.New("http://x", ""), apps: []contract.AppView{{Name: "portfolio"}}})
	m = updated.(Model)
	if m.screen != screenHome {
		t.Fatalf("after connectedMsg, screen = %v, want home", m.screen)
	}
	if len(m.home.apps) != 1 || m.home.apps[0].Name != "portfolio" {
		t.Fatalf("home apps not populated: %+v", m.home.apps)
	}
}

func TestHomeCursorNavigationClamps(t *testing.T) {
	m := Model{screen: screenHome, home: newHomeModel(nil, []contract.AppView{{Name: "a"}, {Name: "b"}})}

	step := func(key tea.KeyType) {
		updated, _ := m.Update(tea.KeyMsg{Type: key})
		m = updated.(Model)
	}
	step(tea.KeyDown)
	if m.home.cursor != 1 {
		t.Fatalf("cursor after down = %d, want 1", m.home.cursor)
	}
	step(tea.KeyDown) // clamps at the last app
	if m.home.cursor != 1 {
		t.Fatalf("cursor clamped = %d, want 1", m.home.cursor)
	}
	step(tea.KeyUp)
	if m.home.cursor != 0 {
		t.Fatalf("cursor after up = %d, want 0", m.home.cursor)
	}
}

func TestCtrlCQuits(t *testing.T) {
	m := New()
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyCtrlC})
	if cmd == nil {
		t.Fatal("ctrl+c must return a command")
	}
	if _, ok := cmd().(tea.QuitMsg); !ok {
		t.Fatal("ctrl+c command must be tea.Quit")
	}
}

func TestQOnlyQuitsOnHome(t *testing.T) {
	// On the connect screen, "q" is a character (typed into the host input), not quit.
	m := New()
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'q'}})
	if cmd != nil {
		if _, ok := cmd().(tea.QuitMsg); ok {
			t.Fatal("q on connect screen must not quit")
		}
	}
}
