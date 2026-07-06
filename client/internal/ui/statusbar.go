package ui

import (
	"fmt"
	"strings"
	"time"

	"github.com/ArielFalcon/panchito/internal/contract"
	"github.com/charmbracelet/lipgloss"
)

// statusBar is the persistent top chrome of the console: brand · server · queue ·
// model health · clock, on one dense line. It is rendered above every connected screen
// and reads from the ambient systemState the shell keeps polling, so the operator sees
// live system state regardless of which screen holds focus — the move that turns a
// screen-swapper into a console.
func statusBar(width int, serverVersion string, sys systemState, now time.Time) string {
	left := renderSegs("", sg("◆ ", colEmber), sgb("panchito", colFg))
	if serverVersion != "" {
		left += renderSegs("", sg("  ", colFaint), sg(serverVersion, colDim))
	}

	right := []string{queueSummary(sys)}
	if hd := healthDots(sys); hd != "" {
		right = append(right, hd)
	}
	if sys.loaded && sys.lastErr != "" {
		right = append(right, shadowStyle.Render("⚠ stale")) // last poll failed; showing the last good snapshot
	}
	right = append(right, labelStyle.Render(now.Format("15:04")))

	return spread(width, left, strings.Join(right, hintStyle.Render("  ·  ")))
}

// queueSummary renders the queue state for the status bar: connecting (no poll yet),
// idle, the running app, and any pending backlog.
func queueSummary(sys systemState) string {
	if !sys.loaded {
		if sys.lastErr != "" {
			return shadowStyle.Render("unreachable")
		}
		return hintStyle.Render("connecting…")
	}
	q := sys.queue
	if q.Running == nil && q.Pending == 0 {
		return okStyle.Render("idle")
	}
	var out string
	if q.Running != nil {
		out = renderSegs("", sg("● ", colInfra), sg(q.Running.App, colFg))
	}
	if q.Pending > 0 {
		if out != "" {
			out += hintStyle.Render(" · ")
		}
		out += shadowStyle.Render(fmt.Sprintf("%d queued", q.Pending))
	}
	return out
}

// healthDots renders one status-colored dot per configured provider — the at-a-glance
// "are my models alive" signal. The detail (per-role models, errors) lives on the
// agents screen.
func healthDots(sys systemState) string {
	if sys.agent.Health == nil {
		return ""
	}
	var dots []string
	if h := sys.agent.Health.Opencode; h != nil {
		dots = append(dots, healthDot(h.Status))
	}
	if h := sys.agent.Health.Codex; h != nil {
		dots = append(dots, healthDot(h.Status))
	}
	return strings.Join(dots, " ")
}

func healthDot(status contract.AgentProviderHealthStatus) string {
	col, glyph := colFaint, "●"
	switch status {
	case contract.AgentProviderHealthStatusHealthy:
		col = colPass
	case contract.AgentProviderHealthStatusDegraded, contract.AgentProviderHealthStatusStarting:
		col = colFlaky
	case contract.AgentProviderHealthStatusFailed, contract.AgentProviderHealthStatusNeedsConfig:
		col = colFail
	case contract.AgentProviderHealthStatusStopped:
		col, glyph = colFaint, "○" // intentionally not running — hollow + dim, distinct from a configured provider
	}
	return lipgloss.NewStyle().Foreground(col).Render(glyph)
}
