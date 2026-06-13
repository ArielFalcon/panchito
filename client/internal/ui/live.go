package ui

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/events"
	"github.com/charmbracelet/bubbles/progress"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

const maxActivity = 6

// Canonical pipeline phases for the PhaseProgress stepper (mirrors RunStepSchema;
// the transient "retry" is folded into the current phase by simply not matching).
var pipelinePhases = []string{"gate", "classify", "setup", "generate", "validate", "health", "execute", "coverage", "decide"}

type activityItem struct {
	callID string
	kind   string
	target string
	status string // running | completed
}

type subagentItem struct {
	key    string // workerId, or the target when no workerId
	worker string // workerId, if any
	target string
	status string // running | completed
}

type testItem struct {
	name       string
	file       string
	status     string // discovered | running | pass | fail | flaky
	durationMs float64
	detail     string
	attempts   int
}

// liveModel watches one run and folds its RunEvent stream into structured state,
// each piece rendered by a dedicated component. While running it shows the live
// view; once a verdict arrives it renders a Summary recap. A viewport scrolls the
// body and absorbs terminal resizes.
type liveModel struct {
	runID          string
	app            string
	sha            string
	target         string
	mode           string
	phase          string
	phaseStart     time.Time
	runStartTs     int64     // server ts (ms) of run.started — anchors the elapsed clock
	lastTs         int64     // server ts (ms) of the most recent event
	lastTsWall     time.Time // wall time we received lastTs — lets elapsed tick between events
	retrying       bool
	activity       []activityItem
	lastFile       string   // most recent file written — sticky, so the focus card row never blinks
	lastCmd        string   // most recent command run — sticky
	wroteAll       []string // every file written, in order (monotonic; for the feed summary)
	ranAll         []string // every command run, in order
	subagents      []subagentItem
	plan           []events.PlanTodo
	specs          []string
	tests          []testItem
	reviewer       *bool
	reasons        []string
	coverage       *events.CoverageComputed
	passed         int
	failed         int
	errs           []string
	agentErr       string
	logs           []string
	verdict        string
	verdictOutcome string // what the run produced (PR/Issue URL + state) — from run.verdict
	done           bool
	closed         bool
	sumFocus       int    // focused summary section (done view)
	sumOpen        string // currently expanded summary section id
	exported       string // path of the exported JSON, once 'e' is pressed
	// Embedded assistant: ask about the run without leaving the live screen.
	client      *api.Client
	chatActive  bool
	chatInput   textinput.Model
	chatEntries []chatEntry
	chatLoading bool
	stopArmed   bool // 'x' pressed once; a second 'x' cancels the server-side run
	chatReveal  int  // runes of the latest answer revealed so far (typewriter effect)
	chatStream  bool // the latest answer is still being revealed
	spin        spinner.Model
	bar         progress.Model
	vp          viewport.Model
	ready       bool // a terminal size is known → the viewport is active
	width       int
	height      int
	ch          chan events.RunEvent
	cancel      context.CancelFunc
}

func newLiveModel(runID, app string, ch chan events.RunEvent, cancel context.CancelFunc, width, height int) liveModel {
	sp := spinner.New()
	sp.Spinner = spinner.MiniDot
	sp.Style = infoStyle
	ti := textinput.New()
	ti.Placeholder = "ask about this run…"
	ti.Prompt = "" // the chat panel draws its own ember caret
	ti.CharLimit = 400
	ti.Width = 48
	bar := progress.New(progress.WithScaledGradient(string(colInfo), string(colSuccess)), progress.WithoutPercentage())
	bar.Width = 24
	m := liveModel{runID: runID, app: app, ch: ch, cancel: cancel, spin: sp, chatInput: ti, bar: bar}
	if width > 0 && height > 0 {
		m.resize(width, height)
	}
	return m
}

func (m liveModel) Update(msg tea.Msg) (liveModel, tea.Cmd) {
	switch msg := msg.(type) {
	case runEventMsg:
		m.fold(events.RunEvent(msg))
		m.refresh()
		return m, waitForEventCmd(m.ch) // read the next event
	case streamClosedMsg:
		m.closed = true
		if msg.err != nil && !errors.Is(msg.err, context.Canceled) && !m.done {
			m.errs = append(m.errs, msg.err.Error())
		}
		m.refresh()
		return m, nil
	case tea.WindowSizeMsg:
		m.resize(msg.Width, msg.Height)
		return m, nil
	case spinner.TickMsg:
		if m.done && !m.chatStream {
			return m, nil // nothing left to animate (run finished, answer fully revealed)
		}
		var cmd tea.Cmd
		m.spin, cmd = m.spin.Update(msg)
		if m.chatStream {
			m.advanceChatReveal()
		}
		m.refresh() // re-render so the new spinner frame / revealed text reaches the viewport
		return m, cmd
	case answerMsg:
		m.chatLoading = false
		m.chatEntries = append(m.chatEntries, chatEntry{role: "a", text: renderMarkdown(msg.text, contentWidth(m.width)), raw: msg.text})
		// Reveal the answer progressively (typewriter), like the example. Kick the spinner
		// so the reveal animates even when the run has already finished (ticks were stopped).
		m.chatReveal = 0
		m.chatStream = true
		m.refresh()
		return m, m.spin.Tick
	case errMsg:
		// In the live screen, an errMsg can only come from the embedded assistant.
		m.chatLoading = false
		m.chatEntries = append(m.chatEntries, chatEntry{role: "err", text: msg.err.Error()})
		m.refresh()
		return m, nil
	case tea.KeyMsg:
		if m.chatActive {
			return m.updateChatKey(msg)
		}
		if msg.String() != "x" {
			m.stopArmed = false // any other key disarms the stop confirmation
		}
		switch msg.String() {
		case "esc":
			m.cancel() // detach: stop watching, but the run keeps going server-side
			return m, func() tea.Msg { return backMsg{} }
		case "x":
			// Stop the SERVER-SIDE run (two-press confirm), not just the view.
			if m.client != nil && !m.done {
				if m.stopArmed {
					m.stopArmed = false
					return m, cancelRunCmd(m.client, m.runID)
				}
				m.stopArmed = true
				m.refresh()
				return m, nil
			}
		case "a":
			// Open the embedded assistant inline (running or finished) — no screen change.
			if m.client != nil {
				m.chatActive = true
				m.chatInput.Focus()
				m.refresh()
				return m, textinput.Blink
			}
		case "c":
			if m.done {
				if failed := m.failedTests(); len(failed) > 0 {
					return m, func() tea.Msg { return continueMsg{cases: failed} }
				}
			}
		case "e":
			if m.done {
				if path, err := m.exportJSON(); err == nil {
					m.exported = path
				} else {
					m.exported = "(export failed: " + err.Error() + ")"
				}
				m.refresh()
				return m, nil
			}
		case "enter":
			if m.done {
				m.toggleSummary()
				return m, nil
			}
		case "up", "k":
			if m.done && len(m.tests) > 0 {
				m.moveSummary(-1) // a navigable test list → ↑↓ picks a case
				return m, nil
			}
			if m.ready {
				var cmd tea.Cmd
				m.vp, cmd = m.vp.Update(msg) // otherwise ↑↓ scrolls the recap (e.g. code/context runs)
				return m, cmd
			}
		case "down", "j":
			if m.done && len(m.tests) > 0 {
				m.moveSummary(1)
				return m, nil
			}
			if m.ready {
				var cmd tea.Cmd
				m.vp, cmd = m.vp.Update(msg)
				return m, cmd
			}
		case "pgup", "pgdown":
			if m.ready {
				var cmd tea.Cmd
				m.vp, cmd = m.vp.Update(msg)
				return m, cmd
			}
		}
	}
	return m, nil
}

// moveSummary moves the cursor through the test list in the recap (↑↓). The rest of the
// recap is always visible — only individual tests expand — so navigation == picking a test.
func (m *liveModel) moveSummary(delta int) {
	n := len(m.tests)
	if n == 0 {
		return
	}
	m.sumFocus = (m.sumFocus + delta + n) % n
	m.refresh()
}

// toggleSummary expands/collapses the focused test's detail (file · duration · failure tail).
func (m *liveModel) toggleSummary() {
	if m.sumFocus < 0 || m.sumFocus >= len(m.tests) {
		return
	}
	name := m.tests[m.sumFocus].name
	if m.sumOpen == name {
		m.sumOpen = ""
	} else {
		m.sumOpen = name
	}
	m.refresh()
}

// updateChatKey routes keystrokes to the embedded assistant input while it is active.
func (m liveModel) updateChatKey(msg tea.KeyMsg) (liveModel, tea.Cmd) {
	// On the summary screen ↑↓ still scan the test list while chat is open (a glance, not
	// a focus change); with no test list they scroll the recap instead so a long answer
	// stays reachable. Enter is NOT intercepted here — it must SEND the typed message;
	// only an EMPTY enter falls through to expand the focused test (handled below).
	if m.done {
		switch msg.String() {
		case "up", "k":
			if len(m.tests) > 0 {
				m.moveSummary(-1)
				m.refresh()
				return m, nil
			}
			if m.ready {
				var cmd tea.Cmd
				m.vp, cmd = m.vp.Update(msg)
				return m, cmd
			}
		case "down", "j":
			if len(m.tests) > 0 {
				m.moveSummary(1)
				m.refresh()
				return m, nil
			}
			if m.ready {
				var cmd tea.Cmd
				m.vp, cmd = m.vp.Update(msg)
				return m, cmd
			}
		}
	}
	switch msg.String() {
	case "esc":
		m.chatActive = false
		m.chatInput.Blur()
		m.refresh()
		return m, nil
	case "enter":
		q := strings.TrimSpace(m.chatInput.Value())
		if q == "" {
			if m.done {
				m.toggleSummary() // nothing to send → expand/collapse the focused test
			}
			return m, nil
		}
		if m.chatLoading || m.client == nil {
			return m, nil
		}
		hist := chatHistory(m.chatEntries)
		m.chatEntries = append(m.chatEntries, chatEntry{role: "q", text: q, raw: q})
		m.chatInput.SetValue("")
		m.chatLoading = true
		m.chatStream = false // a new question ends any in-flight reveal
		m.refresh()
		return m, askCmd(m.client, m.runID, q, hist)
	default:
		var cmd tea.Cmd
		m.chatInput, cmd = m.chatInput.Update(msg)
		m.refresh()
		return m, cmd
	}
}

// renderChat is the always-present inline assistant: a heavy rule splits it from the run
// detail, then a labelled rule, the last exchange (so it never stacks into scroll), and
// the input line. The latest answer is revealed progressively (typewriter) like the
// example; once fully revealed it switches to the Glamour-rendered markdown.
func (m liveModel) renderChat() string {
	w := contentWidth(m.width)
	var b strings.Builder
	b.WriteString(heavyRule(w) + "\n")
	b.WriteString(labelRule(w, "chat", hintStyle.Render("assistant")) + "\n")
	entries := lastExchange(m.chatEntries)
	for i, e := range entries {
		switch e.role {
		case "q":
			b.WriteString(renderSegs("", sg("▸ ", colEmber)) + labelStyle.Render(truncate(e.text, w-2)) + "\n")
		case "err":
			b.WriteString(errorStyle.Render("✗ "+e.text) + "\n")
		default:
			if i == len(entries)-1 && m.chatStream {
				b.WriteString(m.renderStreamingAnswer(e.raw, w) + "\n")
			} else {
				b.WriteString(e.text + "\n")
			}
		}
	}
	if m.chatLoading {
		b.WriteString(infoStyle.Render(m.spin.View()+" thinking…") + "\n")
	}
	if m.chatActive {
		b.WriteString(renderSegs("", sg("› ", colEmber)) + m.chatInput.View())
	} else {
		b.WriteString(renderSegs("", sg("› ", colFaint), sg("ask about this run", colDim)) + hintStyle.Render("   ‹a to ask›"))
	}
	return strings.TrimRight(b.String(), "\n")
}

// renderStreamingAnswer shows the first chatReveal runes of the answer, word-wrapped and
// indented, with a trailing ember cursor — the live typewriter.
func (m liveModel) renderStreamingAnswer(raw string, w int) string {
	r := []rune(raw)
	n := min(m.chatReveal, len(r))
	wrapped := lipgloss.NewStyle().Width(w - 2).Foreground(colFg).Render(string(r[:n]))
	lines := strings.Split(wrapped, "\n")
	for i := range lines {
		lines[i] = "  " + lines[i]
	}
	return strings.Join(lines, "\n") + renderSegs("", sg("█", colEmber))
}

// advanceChatReveal moves the typewriter forward; it ends the stream once the latest
// answer is fully shown. ~6 runes/tick (≈60/s at the spinner's cadence).
func (m *liveModel) advanceChatReveal() {
	total := len([]rune(m.lastAnswerRaw()))
	if total == 0 {
		m.chatStream = false
		return
	}
	m.chatReveal += 6
	if m.chatReveal >= total {
		m.chatReveal = total
		m.chatStream = false
	}
}

// lastAnswerRaw is the raw text of the most recent assistant answer (the one being
// revealed), or "" if the last entry is not an answer.
func (m liveModel) lastAnswerRaw() string {
	if n := len(m.chatEntries); n > 0 && m.chatEntries[n-1].role == "a" {
		return m.chatEntries[n-1].raw
	}
	return ""
}

// lastExchange returns at most the last question+answer pair, so the chat never
// piles up and forces scroll.
func lastExchange(entries []chatEntry) []chatEntry {
	if len(entries) > 2 {
		return entries[len(entries)-2:]
	}
	return entries
}

func (m liveModel) failedTests() []string {
	var out []string
	for _, t := range m.tests {
		if t.status == "fail" {
			out = append(out, t.name)
		}
	}
	return out
}

func (m *liveModel) fold(ev events.RunEvent) {
	// Track the server clock so the run-elapsed timer stays accurate across re-attach and
	// keeps ticking between events (via the wall delta since this event).
	if ev.Ts > 0 {
		m.lastTs = ev.Ts
		m.lastTsWall = time.Now()
	}
	switch b := ev.Body.(type) {
	case events.RunStarted:
		m.sha, m.target, m.mode = b.Sha, b.Target, b.Mode
		if ev.Ts > 0 {
			m.runStartTs = ev.Ts
		}
	case events.StepChanged:
		if b.Step != m.phase {
			m.phaseStart = time.Now() // reset the elapsed clock when the phase advances
		}
		m.phase = b.Step
		if b.Step == "retry" {
			m.retrying = true
		}
	case events.AgentActivity:
		if b.Kind == "subagent" {
			m.subagents = upsertSubagent(m.subagents, b)
		} else {
			m.activity = upsertActivity(m.activity, b)
			// Remember the latest file/command stickily — the focus card reads these, so a
			// row stays put instead of blinking as items slide out of the rolling window.
			if b.Target != "" {
				switch b.Kind {
				case "writing":
					m.lastFile = b.Target
					m.wroteAll = appendUnique(m.wroteAll, b.Target)
				case "command":
					m.lastCmd = b.Target
					m.ranAll = appendUnique(m.ranAll, b.Target)
				}
			}
		}
	case events.PlanUpdated:
		m.plan = b.Todos
	case events.SpecWritten:
		m.specs = appendUnique(m.specs, b.File)
	case events.TestDiscovered:
		m.tests = upsertDiscoveredTest(m.tests, b.Name, b.File)
	case events.TestStarted:
		m.tests = upsertTest(m.tests, b.Name, "running", 0, "", 0)
	case events.TestPassed:
		m.tests = upsertTest(m.tests, b.Name, "pass", b.DurationMs, "", 0)
	case events.TestFailed:
		m.tests = upsertTest(m.tests, b.Name, "fail", b.DurationMs, b.Detail, 0)
	case events.TestFlaky:
		m.tests = upsertTest(m.tests, b.Name, "flaky", 0, "", b.Attempts)
	case events.ReviewerVerdict:
		v := b.Approved
		m.reviewer = &v
		m.reasons = b.Reasons
	case events.CoverageComputed:
		c := b
		m.coverage = &c
	case events.RunVerdict:
		m.verdict = b.Verdict
		m.passed = b.Passed
		m.failed = b.Failed
		m.verdictOutcome = b.Outcome
		m.done = true
		// Land the cursor on the first failure (and pre-expand it) so the problem is
		// front-and-center in the recap instead of buried.
		for i, t := range m.tests {
			if t.status == "fail" {
				m.sumFocus = i
				m.sumOpen = t.name
				break
			}
		}
	case events.LogLine:
		if b.Text != "" {
			m.logs = append(m.logs, b.Text)
			if len(m.logs) > 200 {
				m.logs = m.logs[len(m.logs)-200:]
			}
		}
	case events.AgentError:
		// A failed tool call (e.g. a read that the agent retries) is routine and NOT
		// part of the verdict. The Ink TUI never surfaced these in the live view — it
		// showed forward progress, not every hiccup. Keep only the last one, to explain
		// a fail/infra-error in the SUMMARY; never as a live red banner.
		m.agentErr = b.Detail
	}
}

func upsertActivity(items []activityItem, a events.AgentActivity) []activityItem {
	if a.CallID != "" {
		for i := range items {
			if items[i].callID == a.CallID {
				items[i].status, items[i].target, items[i].kind = a.Status, a.Target, a.Kind
				return items
			}
		}
	}
	items = append(items, activityItem{callID: a.CallID, kind: a.Kind, target: a.Target, status: a.Status})
	if len(items) > maxActivity {
		items = items[len(items)-maxActivity:]
	}
	return items
}

func upsertSubagent(items []subagentItem, a events.AgentActivity) []subagentItem {
	key := a.WorkerID
	if key == "" {
		key = a.Target
	}
	for i := range items {
		if items[i].key == key {
			items[i].status, items[i].target, items[i].worker = a.Status, a.Target, a.WorkerID
			return items
		}
	}
	return append(items, subagentItem{key: key, worker: a.WorkerID, target: a.Target, status: a.Status})
}

func upsertDiscoveredTest(tests []testItem, name, file string) []testItem {
	for i := range tests {
		if tests[i].name == name {
			if file != "" {
				tests[i].file = file
			}
			if tests[i].status == "" {
				tests[i].status = "discovered"
			}
			return tests
		}
	}
	return append(tests, testItem{name: name, file: file, status: "discovered"})
}

func upsertTest(tests []testItem, name, status string, dur float64, detail string, attempts int) []testItem {
	for i := range tests {
		if tests[i].name == name {
			tests[i].status = status
			if dur > 0 {
				tests[i].durationMs = dur
			}
			if detail != "" {
				tests[i].detail = detail
			}
			if attempts > 0 {
				tests[i].attempts = attempts
			}
			return tests
		}
	}
	return append(tests, testItem{name: name, status: status, durationMs: dur, detail: detail, attempts: attempts})
}

func appendUnique(xs []string, s string) []string {
	for _, x := range xs {
		if x == s {
			return xs
		}
	}
	return append(xs, s)
}

// ── Layout ────────────────────────────────────────────────────────────────────

func (m *liveModel) resize(w, h int) {
	m.width, m.height = w, h
	vpHeight := h - lipgloss.Height(m.header()) - lipgloss.Height(m.footer()) - 4 // padding + join lines
	if vpHeight < 3 {
		vpHeight = 3
	}
	vpWidth := w - 4
	if vpWidth < 10 {
		vpWidth = 10
	}
	if !m.ready {
		m.vp = viewport.New(vpWidth, vpHeight)
		m.ready = true
	} else {
		m.vp.Width, m.vp.Height = vpWidth, vpHeight
	}
	m.vp.SetContent(m.body())
}

// refresh re-renders the body into the viewport after a state or spinner change.
func (m *liveModel) refresh() {
	if m.ready {
		m.vp.SetContent(m.body())
	}
}

func (m liveModel) View() string {
	if !m.ready {
		// No terminal size yet → render everything without scroll (fallback).
		return screenStyle.Render(m.header() + "\n" + m.body() + "\n" + m.footer())
	}
	return screenStyle.Render(m.header() + "\n" + m.vp.View() + "\n" + m.footer())
}

// header is rendered above the scrolling body: the run identity line, then the pipeline
// rail and a progress bar tinted by sub-state, fenced by hairlines. It is the fixed
// masthead the eye returns to; the live detail scrolls beneath it.
func (m liveModel) header() string {
	w := contentWidth(m.width)
	sc := m.stateColor()

	left := renderSegs("", sgb("run  ", colEmber), sgb(m.app, colFg))
	if m.target != "" {
		tgtCol := colInfra
		if m.target == "code" {
			tgtCol = colFlaky
		}
		left += renderSegs("", sg("   target ", colFaint), sg(m.target, tgtCol), sg(" · ", colFaint), sg(m.mode, colDim))
	}
	word := "running"
	icon := m.spin.View() + " "
	if m.done {
		word = strings.ToUpper(m.verdict)
		icon = ""
	} else if m.retrying {
		word = "↻ retrying"
		icon = ""
	}
	left += "   " + renderSegs("", sg(icon, sc)) + lipgloss.NewStyle().Bold(true).Foreground(sc).Render(word)

	right := ""
	if m.sha != "" {
		right = hintStyle.Render(shortSha(m.sha))
	}
	if el, ok := m.runElapsed(); ok {
		if right != "" {
			right += "  "
		}
		right += labelStyle.Render(mmss(el))
	}

	runLine := spread(w, left, right)
	rail := pipelineRail(w, pipelinePhases, m.phaseIndex(), m.done, sc)
	if idx := m.phaseIndex(); idx < 0 && m.phase != "" && !m.done {
		rail += "  " + titleStyle.Render("("+m.phase+")") // a transient phase (e.g. retry)
	}
	bar := progressBar(w, m.phaseFraction(), sc)
	return runLine + "\n" + hairline(w) + "\n" + rail + "\n" + bar + "\n" + hairline(w)
}

// runElapsed is the wall time since run.started: the server delta to the last event,
// plus the wall time since — so it ticks smoothly even between events while live.
func (m liveModel) runElapsed() (time.Duration, bool) {
	if m.runStartTs == 0 || m.lastTs == 0 {
		return 0, false
	}
	d := time.Duration(m.lastTs-m.runStartTs) * time.Millisecond
	if !m.done && !m.lastTsWall.IsZero() {
		d += time.Since(m.lastTsWall)
	}
	if d < 0 {
		d = 0
	}
	return d, true
}

func mmss(d time.Duration) string {
	s := int(d.Seconds())
	return fmt.Sprintf("%d:%02d", s/60, s%60)
}

// phaseIndex is the position of the current phase in the canonical pipeline, or -1 for a
// transient/unknown phase (e.g. "retry") that matches no canonical step.
func (m liveModel) phaseIndex() int { return indexOf(pipelinePhases, m.phase) }

// phaseFraction drives the header progress bar: how far through the pipeline we are.
func (m liveModel) phaseFraction() float64 {
	if m.done {
		return 1
	}
	idx := m.phaseIndex()
	if idx < 0 {
		return 0
	}
	return float64(idx) / float64(len(pipelinePhases)-1)
}

// stateColor tints the rail, bar and focus card by sub-state: infra-steel while the
// suite runs against DEV, the verdict ramp once decided, ember everywhere else.
func (m liveModel) stateColor() lipgloss.Color {
	if m.done {
		return verdictColor(m.verdict)
	}
	switch m.phase {
	case "execute", "health":
		return colInfra
	default:
		return colEmber
	}
}

func shortSha(s string) string {
	if len(s) > 7 {
		return s[:7]
	}
	return s
}

func (m liveModel) footer() string {
	if m.chatActive {
		if m.done {
			if len(m.tests) > 0 {
				return hintStyle.Render("↑↓ tests · ↵ expand · type to ask · esc close chat")
			}
			return hintStyle.Render("↑↓ scroll · type to ask · esc close chat")
		}
		return hintStyle.Render("type to ask · ↵ send · esc close chat")
	}
	if m.done {
		nav := "↑↓ scroll"
		if len(m.tests) > 0 {
			nav = "↑↓ tests · ↵ expand"
		}
		actions := nav + " · e export · a ask"
		if len(m.failedTests()) > 0 {
			actions += " · c continue"
		}
		return hintStyle.Render(actions + " · esc back")
	}
	if m.stopArmed {
		return errorStyle.Render("press x again to STOP the run") + hintStyle.Render("  ·  any other key keeps it running")
	}
	footer := "a ask · x stop · esc detach · ctrl+c quit"
	if m.ready && m.vp.TotalLineCount() > m.vp.Height {
		footer = "↑↓ scroll · " + footer // only advertise scroll when there is overflow
	}
	return hintStyle.Render(footer)
}

func (m liveModel) body() string {
	var base string
	if m.done {
		base = m.summaryBody()
	} else {
		base = m.liveBody()
	}
	// A blank line under the fixed header gives the body the example's breathing room.
	return "\n" + base + "\n\n" + m.renderChat() // the assistant panel is always present
}

func (m liveModel) liveBody() string {
	view := m.deriveActivity()
	card := m.renderFocusCard(view)
	// The horizontal pipeline rail lives in the fixed header; here the body carries the
	// live "what is happening now" line (renderPhaseStatus) plus the agent's work — no
	// second, vertical copy of the pipeline.
	sections := []string{
		m.renderPhaseStatus(),
		card,
		m.renderFeed(view),
		m.renderLogTail(),
		m.renderSubagents(),
		m.renderSpecs(),
		m.renderTests(),
		m.renderCoverage(),
		m.renderReviewer(),
		m.renderErrs(),
	}
	return joinSections(sections)
}

// renderLogTail surfaces the orchestrator's own narration (the log.line stream) right in
// the live view — the detail the user previously had to ask the chat for (phase work,
// runner output, heartbeats). The last few lines only, tinted by level.
func (m liveModel) renderLogTail() string {
	if len(m.logs) == 0 {
		return ""
	}
	w := contentWidth(m.width)
	var b strings.Builder
	b.WriteString(labelRule(w, "log", "") + "\n")
	for _, l := range lastN(m.logs, 6) {
		text := strings.TrimPrefix(l, "[qa] ")
		st := hintStyle
		switch {
		case strings.Contains(l, "✗") || strings.Contains(strings.ToLower(l), "error") || strings.Contains(strings.ToLower(l), "fail"):
			st = errorStyle
		case strings.Contains(l, "⚠") || strings.Contains(strings.ToLower(l), "warn") || strings.Contains(l, "flaky"):
			st = shadowStyle
		}
		b.WriteString("  " + st.Render(truncate(text, w-2)) + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

// renderPhaseStatus is the always-present, animated "what is happening now" line.
// It guarantees there is live content (and a moving spinner → continuous repaints)
// below the header even during quiet phases like gate/classify/setup, before the
// agent emits any activity.
func (m liveModel) renderPhaseStatus() string {
	if m.done || m.phase == "" {
		return ""
	}
	line := m.spin.View() + " " + infoStyle.Render(phaseDescription(m.phase))
	if !m.phaseStart.IsZero() {
		line += "  " + labelStyle.Render(formatElapsed(time.Since(m.phaseStart)))
	}
	return line
}

func phaseDescription(phase string) string {
	switch phase {
	case "gate":
		return "waiting for DEV to serve this commit"
	case "classify":
		return "classifying the commit"
	case "setup":
		return "installing the e2e project"
	case "generate":
		return "the agent is generating tests"
	case "validate":
		return "validating specs (tsc · eslint · playwright --list)"
	case "health":
		return "DEV health pre-flight"
	case "execute":
		return "running tests against DEV"
	case "coverage":
		return "measuring change coverage"
	case "decide":
		return "deciding the verdict"
	default:
		return phase
	}
}

// summaryBody is the finished-run recap. It answers "what did this run do and was it
// worth it" at a glance: a verdict badge + counts, a plain-English OUTCOME line, an
// always-visible "what happened" block (specs / files / commands / plan / reviewer /
// coverage), a NAVIGABLE test list (↑↓ move · ↵ expand a case's file · duration · failure
// detail), and a log tail. Only per-test detail hides behind expansion — nothing else.
func (m liveModel) summaryBody() string {
	w := contentWidth(m.width)
	var b strings.Builder

	icon, vs := verdictBadge(m.verdict)
	badge := lipgloss.NewStyle().Background(vs.GetForeground()).Foreground(colBg).Bold(true).Padding(0, 1).Render(icon + " " + strings.ToUpper(m.verdict))
	counts := okStyle.Render(fmt.Sprintf("%d passed", m.passed))
	if m.failed > 0 {
		counts += labelStyle.Render(" · ") + errorStyle.Render(fmt.Sprintf("%d failed", m.failed))
	}
	if fl := countTests(m.tests).flaky; fl > 0 {
		counts += labelStyle.Render(" · ") + shadowStyle.Render(fmt.Sprintf("%d flaky", fl))
	}
	right := ""
	if el, ok := m.runElapsed(); ok {
		right = labelStyle.Render(mmss(el))
	}
	b.WriteString(spread(w, badge+"   "+counts, right) + "\n")
	b.WriteString(hintStyle.Render(truncate(m.outcomeLine(), w)) + "\n\n")

	b.WriteString(m.renderWhatHappened(w) + "\n\n")
	if tl := m.renderTestList(w); tl != "" {
		b.WriteString(tl + "\n\n")
	}
	if len(m.logs) > 0 {
		b.WriteString(labelRule(w, "log", hintStyle.Render(pluralize(len(m.logs), "line", "lines"))) + "\n")
		for _, l := range lastN(m.logs, 10) {
			b.WriteString("  " + hintStyle.Render(truncate(strings.TrimPrefix(l, "[qa] "), w-2)) + "\n")
		}
	}
	if m.exported != "" {
		b.WriteString("\n" + okStyle.Render("✓ exported → "+m.exported))
	}
	return strings.TrimRight(b.String(), "\n")
}

// outcomeLine explains, in one plain sentence, what the verdict means and what the
// pipeline did with it — the "what value did this run provide" the recap must answer.
// Prefer the REAL outcome from the backend (the actual PR/Issue URL + merged state);
// fall back to a verdict-derived sentence when the run carried none.
func (m liveModel) outcomeLine() string {
	if m.verdictOutcome != "" {
		return m.verdictOutcome
	}
	switch m.verdict {
	case "pass":
		if m.reviewer != nil && !*m.reviewer {
			return "tests are green, but the reviewer rejected the suite — a GitHub Issue is filed instead of a PR"
		}
		return "tests are green and the reviewer approved — the suite is committed via an auto-merge PR"
	case "fail":
		return "a test failed against DEV — a GitHub Issue is filed with the human-readable cause"
	case "invalid":
		return "the generated specs failed the static gate (tsc · eslint · playwright --list) — nothing was run"
	case "flaky":
		return "a case only passed on retry — it is quarantined as flaky, not merged"
	case "infra-error":
		if m.agentErr != "" {
			return "infrastructure error (not a code fault): " + truncate(m.agentErr, 64)
		}
		return "infrastructure error — a DEV / runner / git problem, not a code fault"
	case "skipped":
		return "no test-worthy change — nothing was generated or published"
	default:
		return ""
	}
}

// renderWhatHappened is the always-visible recap of the agent's work and the gates. It
// lists what the run produced BY NAME — specs, other written files, commands — which is
// the entire substance of the recap for code/context runs that carry no Playwright list.
func (m liveModel) renderWhatHappened(w int) string {
	var b strings.Builder
	b.WriteString(labelRule(w, "what happened", "") + "\n")
	row := func(label, val string) {
		b.WriteString(renderSegs("", sg(padRight(label, 11), colDim)) + val + "\n")
	}
	// list prints a "label  summary" row, then each item on its own indented line
	// (bounded), so files/commands are visible by name rather than as a bare count.
	list := func(label, summary string, items []string, max int) {
		row(label, summary)
		for i, it := range items {
			if i >= max {
				b.WriteString(strings.Repeat(" ", 11) + hintStyle.Render(fmt.Sprintf("+%d more", len(items)-max)) + "\n")
				break
			}
			b.WriteString(strings.Repeat(" ", 11) + hintStyle.Render("· "+truncate(it, w-13)) + "\n")
		}
	}
	specSet := map[string]bool{}
	if len(m.specs) > 0 {
		var names []string
		for _, f := range m.specs {
			n := baseName(f)
			names = append(names, n)
			specSet[n] = true
		}
		list("generated", okStyle.Render(pluralize(len(m.specs), "spec", "specs")), names, 8)
	}
	// "wrote" lists the non-spec files (config, fixtures, context.json, code-mode tests)
	// — anything written that the "generated" row did not already name.
	var wrote []string
	for _, f := range m.wroteAll {
		if n := baseName(f); !specSet[n] {
			wrote = append(wrote, n)
		}
	}
	if len(wrote) > 0 {
		list("wrote", labelStyle.Render(pluralize(len(wrote), "file", "files")), wrote, 8)
	}
	if len(m.ranAll) > 0 {
		list("ran", labelStyle.Render(pluralize(len(m.ranAll), "command", "commands")), m.ranAll, 6)
	}
	if len(m.plan) > 0 {
		done := 0
		for _, t := range m.plan {
			if t.Status == "completed" {
				done++
			}
		}
		row("plan", labelStyle.Render(fmt.Sprintf("%d/%d done", done, len(m.plan))))
	}
	if m.reviewer != nil {
		if *m.reviewer {
			row("reviewer", okStyle.Render("approved"))
		} else {
			row("reviewer", errorStyle.Render("rejected"))
			for _, r := range m.reasons {
				b.WriteString("             " + hintStyle.Render("- "+truncate(r, w-15)) + "\n")
			}
		}
	}
	if txt, ok := m.coverageText(); ok {
		row("coverage", txt)
	}
	if m.agentErr != "" && m.verdict != "pass" && m.verdict != "skipped" {
		row("note", hintStyle.Render(truncate(m.agentErr, w-13)))
	}
	return strings.TrimRight(b.String(), "\n")
}

// renderTestList is the navigable per-test recap: one row per case (glyph · name ·
// duration), the focused one carrying the ember bar; the expanded one reveals its file,
// flaky attempts and failure detail.
func (m liveModel) renderTestList(w int) string {
	if len(m.tests) == 0 {
		return ""
	}
	c := countTests(m.tests)
	var b strings.Builder
	b.WriteString(labelRule(w, "tests", hintStyle.Render(formatTestHistory(c))) + "\n")
	for i, t := range m.tests {
		gi, st := testGlyph(t.status)
		dur := ""
		if t.durationMs > 0 {
			dur = hintStyle.Render(formatDuration(t.durationMs))
		}
		var left string
		if i == m.sumFocus {
			left = renderSegs("", sg("▌▸ ", colEmber), sg(gi+" ", st)) + lipgloss.NewStyle().Bold(true).Foreground(colFg).Render(truncate(t.name, w-24))
		} else {
			left = "   " + renderSegs("", sg(gi+" ", st)) + labelStyle.Render(truncate(t.name, w-24))
		}
		b.WriteString(spread(w, left, dur) + "\n")
		if m.sumOpen == t.name {
			if t.file != "" {
				b.WriteString("       " + hintStyle.Render(truncate(t.file, w-9)) + "\n")
			}
			if t.attempts > 0 {
				b.WriteString("       " + shadowStyle.Render(fmt.Sprintf("passed only after %d attempts", t.attempts)) + "\n")
			}
			if t.detail != "" {
				b.WriteString("       " + errorStyle.Render(truncate(t.detail, w-9)) + "\n")
			}
		}
	}
	return strings.TrimRight(b.String(), "\n")
}

func testGlyph(status string) (string, lipgloss.Color) {
	switch status {
	case "pass":
		return "✓", colPass
	case "fail":
		return "✗", colFail
	case "flaky":
		return "~", colFlaky
	case "running":
		return "◐", colInfra
	default:
		return "·", colFaint
	}
}

// coverageText is the change-coverage line, shared by the live section and the recap. ok
// is false when no coverage was measured, so callers omit it rather than show a 0%.
func (m liveModel) coverageText() (string, bool) {
	if m.coverage == nil || m.coverage.ChangedLines == 0 {
		return "", false
	}
	pct := float64(m.coverage.CoveredLines) / float64(m.coverage.ChangedLines) * 100
	st := okStyle
	if pct < 100 {
		st = shadowStyle
	}
	return st.Render(fmt.Sprintf("%d/%d changed lines (%.0f%%)", m.coverage.CoveredLines, m.coverage.ChangedLines, pct)), true
}

// baseName is the trailing path segment (the file name) for compact spec listing.
func baseName(p string) string {
	if i := strings.LastIndexByte(p, '/'); i >= 0 {
		return p[i+1:]
	}
	return p
}

// ── JSON export (the 'e' key on a finished run) ─────────────────────────────────

type testExport struct {
	Name       string  `json:"name"`
	Status     string  `json:"status"`
	DurationMs float64 `json:"durationMs,omitempty"`
	Detail     string  `json:"detail,omitempty"`
	Attempts   int     `json:"attempts,omitempty"`
}

type runExport struct {
	RunID    string                   `json:"runId"`
	App      string                   `json:"app"`
	Sha      string                   `json:"sha,omitempty"`
	Target   string                   `json:"target,omitempty"`
	Mode     string                   `json:"mode,omitempty"`
	Verdict  string                   `json:"verdict"`
	Passed   int                      `json:"passed"`
	Failed   int                      `json:"failed"`
	Specs    []string                 `json:"specs,omitempty"`
	Tests    []testExport             `json:"tests,omitempty"`
	Coverage *events.CoverageComputed `json:"coverage,omitempty"`
	Reviewer *bool                    `json:"reviewerApproved,omitempty"`
	Reasons  []string                 `json:"reviewerReasons,omitempty"`
}

func (m liveModel) exportJSON() (string, error) {
	exp := runExport{
		RunID: m.runID, App: m.app, Sha: m.sha, Target: m.target, Mode: m.mode,
		Verdict: m.verdict, Passed: m.passed, Failed: m.failed,
		Specs: m.specs, Coverage: m.coverage, Reviewer: m.reviewer, Reasons: m.reasons,
	}
	for _, t := range m.tests {
		exp.Tests = append(exp.Tests, testExport{t.name, t.status, t.durationMs, t.detail, t.attempts})
	}
	data, err := json.MarshalIndent(exp, "", "  ")
	if err != nil {
		return "", err
	}
	id := m.runID
	if len(id) > 24 {
		id = id[:24]
	}
	path := "qa-run-" + id + ".json"
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return "", err
	}
	return path, nil
}

func joinSections(sections []string) string {
	var out []string
	for _, s := range sections {
		if s != "" {
			out = append(out, s)
		}
	}
	return strings.Join(out, "\n\n") // a blank line between sections — the example's rhythm
}

// wrapJoin joins styled parts with sep, breaking to a new line whenever the next
// part would exceed width (measured in display cells, so ANSI styling is ignored).
// width <= 0 disables wrapping — used before a terminal size is known. Keeps the 8
// pipeline phases readable on terminals narrower than 80 columns.
func wrapJoin(parts []string, sep string, width int) string {
	if len(parts) == 0 {
		return ""
	}
	if width <= 0 {
		return strings.Join(parts, sep)
	}
	sepW := lipgloss.Width(sep)
	var b strings.Builder
	lineW := 0
	for i, p := range parts {
		pw := lipgloss.Width(p)
		switch {
		case i == 0:
			b.WriteString(p)
			lineW = pw
		case lineW+sepW+pw > width:
			b.WriteString("\n" + p)
			lineW = pw
		default:
			b.WriteString(sep + p)
			lineW += sepW + pw
		}
	}
	return b.String()
}

// ── Live activity: the FocusCard ("now") + the plan/wrote/ran feed ──────────────
// Ported from the Ink dashboard (FocusCard + LiveActivity): a bordered card with the
// current unit of work, then the agent's plan checklist, files written and commands
// run. Derived from the folded state, never invented.

type focusItem struct {
	title    string
	progress string // e.g. "3/8" of the plan todos
	lastFile string
	lastCmd  string
}

type activityView struct {
	focus *focusItem
	plan  []events.PlanTodo
	wrote []string
	ran   []string
}

func (m liveModel) deriveActivity() activityView {
	lastRunning := ""
	for _, a := range m.activity {
		if a.status == "running" && a.target != "" {
			lastRunning = a.target
		}
	}
	title, completed := "", 0
	for _, t := range m.plan {
		if t.Status == "completed" {
			completed++
		}
		if t.Status == "in_progress" && title == "" {
			title = t.Content
		}
	}
	if title == "" {
		title = lastRunning
	}
	if title == "" {
		title = m.lastFile
	}
	// Keep the card present for the whole live run once there's any work to show, so it
	// doesn't blink out between events; the wrote/ran/title come from sticky state.
	var focus *focusItem
	if title != "" || len(m.plan) > 0 || m.lastCmd != "" {
		f := focusItem{title: title, lastFile: m.lastFile, lastCmd: m.lastCmd}
		if len(m.plan) > 0 {
			f.progress = fmt.Sprintf("%d/%d", completed, len(m.plan))
		}
		focus = &f
	}
	return activityView{focus: focus, plan: m.plan, wrote: m.wroteAll, ran: m.ranAll}
}

// renderFocusCard is the single boxed element while a run is live: the one unit of work
// a reviewer's eye should land on. Border + spinner are tinted by sub-state; the body is
// verb/value rows derived from the folded activity, never invented.
func (m liveModel) renderFocusCard(v activityView) string {
	if v.focus == nil || m.done {
		return ""
	}
	f := v.focus
	w := contentWidth(m.width)
	sc := m.stateColor()
	valW := max(12, w-22) // room for glyph + verb + card walls

	title := lipgloss.NewStyle().Bold(true).Foreground(sc).Render(m.phase)
	rightHead := renderSegs("", sg(m.spin.View()+" ", sc))
	if f.progress != "" {
		rightHead += hintStyle.Render(f.progress)
	}
	if !m.phaseStart.IsZero() {
		rightHead += "  " + labelStyle.Render(formatElapsed(time.Since(m.phaseStart)))
	}

	var rows []cardKV
	if f.lastFile != "" {
		rows = append(rows, kv("✎", colEmberS, "wrote", labelStyle.Render(truncate(f.lastFile, valW))))
	}
	if f.lastCmd != "" {
		rows = append(rows, kv("⚙", colDim, "ran", labelStyle.Render(truncate(f.lastCmd, valW))))
	}
	rows = append(rows, kv(m.spin.View(), sc, "now", lipgloss.NewStyle().Foreground(colFg).Render(truncate(phaseDescription(m.phase), valW))))

	headline := f.title
	if headline == "" {
		headline = phaseDescription(m.phase) // never collapse the card's height mid-run
	}
	return focusCard(w, sc, title, rightHead, truncate(headline, w-10), "", rows)
}

const feedGutter = 7

func gutterLabel(s string) string {
	if len(s) >= feedGutter {
		return s[:feedGutter]
	}
	return s + strings.Repeat(" ", feedGutter-len(s))
}

// renderFeed is the PLAN checklist (done ✓ / active ▸ / pending ·) under a labelled
// rule, then the compact wrote / ran summary lines — the agent's forward progress.
func (m liveModel) renderFeed(v activityView) string {
	if len(v.plan) == 0 && len(v.wrote) == 0 && len(v.ran) == 0 {
		return ""
	}
	w := contentWidth(m.width)
	var b strings.Builder
	if len(v.plan) > 0 {
		done := 0
		for _, t := range v.plan {
			if t.Status == "completed" {
				done++
			}
		}
		right := renderSegs("", sg(fmt.Sprintf("%d/%d", done, len(v.plan)), colDim), sg(" done", colFaint))
		b.WriteString(labelRule(w, "plan", right) + "\n")
		for _, t := range v.plan {
			switch t.Status {
			case "completed":
				b.WriteString(okStyle.Render("✓ ") + labelStyle.Render(truncate(t.Content, w-2)) + "\n")
			case "in_progress":
				left := renderSegs("", sg("▸ ", m.stateColor())) + lipgloss.NewStyle().Bold(true).Foreground(colFg).Render(truncate(t.Content, w-10))
				b.WriteString(spread(w, left, hintStyle.Render("← now")) + "\n")
			case "cancelled":
				b.WriteString(hintStyle.Render("✗ "+truncate(t.Content, w-2)) + "\n")
			default:
				b.WriteString(renderSegs("", sg("· ", colFaint), sg(truncate(t.Content, w-2), colFaint)) + "\n")
			}
		}
		b.WriteString("\n")
	}
	if len(v.wrote) > 0 {
		shown := lastN(v.wrote, 3)
		line := strings.Join(shown, " · ")
		if extra := len(v.wrote) - len(shown); extra > 0 {
			line += fmt.Sprintf("   +%d", extra)
		}
		b.WriteString(labelStyle.Render(gutterLabel("wrote")) + hintStyle.Render(truncate(line, w-8)) + "\n")
	}
	if len(v.ran) > 0 {
		var parts []string
		for _, c := range lastN(v.ran, 2) {
			parts = append(parts, truncate(c, 40))
		}
		b.WriteString(labelStyle.Render(gutterLabel("ran")) + hintStyle.Render(truncate(strings.Join(parts, " · "), w-8)) + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

func lastN(xs []string, n int) []string {
	if len(xs) > n {
		return xs[len(xs)-n:]
	}
	return xs
}

func formatElapsed(d time.Duration) string {
	s := int(d.Seconds())
	if s < 60 {
		return fmt.Sprintf("%ds", s)
	}
	if s < 3600 {
		return fmt.Sprintf("%dm %ds", s/60, s%60)
	}
	return fmt.Sprintf("%dh %dm", s/3600, (s%3600)/60)
}

func (m liveModel) renderSubagents() string {
	if len(m.subagents) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString(labelRule(contentWidth(m.width), "subagents", "") + "\n")
	for _, s := range m.subagents {
		marker := okStyle.Render("✓")
		if s.status == "running" {
			marker = m.spin.View()
		}
		line := "  " + marker + " "
		if s.worker != "" {
			line += shadowStyle.Render("[" + s.worker + "] ")
		}
		b.WriteString(line + truncate(s.target, 56) + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

func (m liveModel) renderSpecs() string {
	if len(m.specs) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString(labelRule(contentWidth(m.width), "specs", "") + "\n")
	for _, f := range m.specs {
		b.WriteString("  " + okStyle.Render("✎ ") + f + "  " + labelStyle.Render("written") + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

func (m liveModel) renderTests() string {
	if len(m.tests) == 0 {
		return ""
	}
	counts := countTests(m.tests)
	current, currentIdx, hasCurrent := currentTest(m.tests)
	next, hasNext := nextQueuedTest(m.tests, currentIdx)

	var b strings.Builder
	b.WriteString(labelRule(contentWidth(m.width), "tests", "") + "\n")
	b.WriteString("  " + labelStyle.Render(formatTestHistory(counts)) + "\n")
	if total := len(m.tests); total > 0 && (counts.passed+counts.failed+counts.flaky) > 0 {
		b.WriteString("  " + m.bar.ViewAs(float64(counts.passed)/float64(total)) + " " + hintStyle.Render(fmt.Sprintf("%d/%d", counts.passed, total)) + "\n")
	}

	// renderTests is the LIVE test section (liveBody runs only while !m.done); the finished
	// recap is rendered separately by renderTestList. So there is no done-branch here.
	if hasCurrent {
		b.WriteString("  " + infoStyle.Bold(true).Render(m.spin.View()+" now "+current.name) + "\n")
		detail := current.file
		if detail == "" {
			detail = "executing current Playwright case"
		}
		b.WriteString("    " + hintStyle.Render(truncate(detail, 76)) + "\n")
	} else {
		b.WriteString("  " + hintStyle.Render("waiting for test runner") + "\n")
	}

	if hasNext {
		line := "next " + next.name
		if next.file != "" {
			line += "  " + truncate(next.file, 64)
		}
		b.WriteString("  " + hintStyle.Render(line) + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

type testCounts struct {
	passed  int
	failed  int
	flaky   int
	running int
	queued  int
}

func countTests(tests []testItem) testCounts {
	var c testCounts
	for _, t := range tests {
		switch t.status {
		case "pass":
			c.passed++
		case "fail":
			c.failed++
		case "flaky":
			c.flaky++
		case "running":
			c.running++
		case "discovered":
			c.queued++
		}
	}
	return c
}

func formatTestHistory(c testCounts) string {
	var parts []string
	if c.passed > 0 {
		parts = append(parts, fmt.Sprintf("%d passed", c.passed))
	}
	if c.failed > 0 {
		parts = append(parts, fmt.Sprintf("%d failed", c.failed))
	}
	if c.flaky > 0 {
		parts = append(parts, fmt.Sprintf("%d flaky", c.flaky))
	}
	if c.running > 0 {
		parts = append(parts, fmt.Sprintf("%d running", c.running))
	}
	if c.queued > 0 {
		parts = append(parts, fmt.Sprintf("%d queued", c.queued))
	}
	if len(parts) == 0 {
		return "history: none yet"
	}
	return "history: " + strings.Join(parts, " · ")
}

func currentTest(tests []testItem) (testItem, int, bool) {
	for i := len(tests) - 1; i >= 0; i-- {
		if tests[i].status == "running" {
			return tests[i], i, true
		}
	}
	return testItem{}, -1, false
}

func nextQueuedTest(tests []testItem, currentIdx int) (testItem, bool) {
	start := currentIdx + 1
	if start < 0 {
		start = 0
	}
	for i := start; i < len(tests); i++ {
		if tests[i].status == "discovered" {
			return tests[i], true
		}
	}
	for i := 0; i < start && i < len(tests); i++ {
		if tests[i].status == "discovered" {
			return tests[i], true
		}
	}
	return testItem{}, false
}

func formatDuration(ms float64) string {
	if ms <= 0 {
		return ""
	}
	if ms < 1000 {
		return fmt.Sprintf("%dms", int(ms))
	}
	return fmt.Sprintf("%.1fs", ms/1000)
}

func (m liveModel) renderCoverage() string {
	if m.coverage == nil || m.coverage.ChangedLines == 0 {
		return ""
	}
	pct := float64(m.coverage.CoveredLines) / float64(m.coverage.ChangedLines) * 100
	st := okStyle
	if pct < 100 {
		st = shadowStyle
	}
	line := fmt.Sprintf("%d/%d changed lines covered (%.0f%%)", m.coverage.CoveredLines, m.coverage.ChangedLines, pct)
	return labelRule(contentWidth(m.width), "coverage", "") + "\n  " + st.Render(line)
}

func (m liveModel) renderReviewer() string {
	if m.reviewer == nil {
		return ""
	}
	var b strings.Builder
	if *m.reviewer {
		b.WriteString(okStyle.Render("reviewer: approved"))
	} else {
		b.WriteString(errorStyle.Render("reviewer: rejected"))
	}
	for _, r := range m.reasons {
		b.WriteString("\n  " + hintStyle.Render("- "+truncate(r, 68)))
	}
	return b.String()
}

func (m liveModel) renderErrs() string {
	if len(m.errs) == 0 {
		return ""
	}
	var b strings.Builder
	for _, e := range m.errs {
		b.WriteString(errorStyle.Render("⚠ "+truncate(e, 70)) + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

// verdictColor is the raw ramp color (for borders, rails and bars that need a Color, not
// a Style).
func verdictColor(v string) lipgloss.Color {
	switch v {
	case "pass":
		return colPass
	case "skipped":
		return colInfra
	case "fail", "invalid":
		return colFail
	default:
		return colFlaky
	}
}

func verdictBadge(v string) (string, lipgloss.Style) {
	switch v {
	case "pass":
		return "✓", okStyle
	case "skipped":
		return "•", infoStyle
	case "fail", "invalid":
		return "✗", errorStyle
	default:
		return "⚠", shadowStyle
	}
}

func indexOf(xs []string, x string) int {
	for i, v := range xs {
		if v == x {
			return i
		}
	}
	return -1
}

// truncate clamps to n RUNES (not bytes): test names use " › " (U+203A) and files
// may be unicode, so byte-slicing would cut mid-rune into mojibake.
func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

// ── Stream plumbing: a goroutine reads the SSE stream and pushes events onto a
// channel; a read-next tea.Cmd hands each one to the main loop. The model is
// mutated only in Update — the goroutine never touches it (review note #7).

func startStreamCmd(ctx context.Context, c *api.Client, id string, ch chan events.RunEvent) tea.Cmd {
	return func() tea.Msg {
		err := c.StreamRunEventsReconnect(ctx, id, func(ev events.RunEvent) {
			sendRunEvent(ctx, ch, ev)
		})
		close(ch)
		return streamClosedMsg{err: err}
	}
}

func sendRunEvent(ctx context.Context, ch chan events.RunEvent, ev events.RunEvent) bool {
	select {
	case ch <- ev:
		return true
	case <-ctx.Done():
		return false
	}
}

func waitForEventCmd(ch chan events.RunEvent) tea.Cmd {
	return func() tea.Msg {
		ev, ok := <-ch
		if !ok {
			return nil // channel closed; streamClosedMsg already signalled the end
		}
		return runEventMsg(ev)
	}
}
