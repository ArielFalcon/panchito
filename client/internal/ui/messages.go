package ui

import (
	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/contract"
)

// connectedMsg is emitted when the connect screen successfully reaches the control
// plane, carrying the live client and the first app listing.
type connectedMsg struct {
	client *api.Client
	apps   []contract.AppView
}

// errMsg carries a command failure to a screen for display.
type errMsg struct{ err error }
