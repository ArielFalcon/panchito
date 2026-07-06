package ui

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/contract"
	"github.com/ArielFalcon/panchito/internal/events"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

const maxActivity = 6

// Silent-stream watchdog: if no SSE event arrives for streamStaleAfter while the run is still in
// flight, the live view re-seeds from the authoritative record (GET /api/runs/:id). This is the
// client safety net for a stream that goes silent — e.g. a run executing in another process whose
// events never reach the server's in-process bus. streamStaleAfter sits above the generate-phase
// heartbeat (~15s) so a healthy in-process run never polls.
const (
	watchdogInterval = 7 * time.Second
	streamStaleAfter = 20 * time.Second
)

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
	lastActivity   time.Time // wall time of the last stream event — drives the silent-stream watchdog
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
	// report is the run's two-part report (current execution + evolution), fetched once the run
	// reaches a terminal state so the summary can show the top-K and drill into the full screen.
	report          *contract.RunReportView
	reportRequested bool // the one-shot fetch has been fired (avoids re-fetching on every event)
	// Embedded assistant: ask about the run without leaving the live screen.
	client      *api.Client
	chatActive  bool
	chatInput   textinput.Model
	chatEntries []chatEntry
	chatLoading bool
	stopArmed   bool // 'x' pressed once; a second 'x' cancels the server-side run
	spin        spinner.Model
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
	m := liveModel{runID: runID, app: app, ch: ch, cancel: cancel, spin: sp, chatInput: ti}
	m.lastActivity = time.Now() // the watchdog measures silence from mount, not from the zero time
	if width > 0 && height > 0 {
		m.resize(width, height)
	}
	return m
}

func (m liveModel) Update(msg tea.Msg) (liveModel, tea.Cmd) {
	switch msg := msg.(type) {
	case runEventMsg:
		m.lastActivity = time.Now() // a live event → the stream is healthy; reset the watchdog clock
		m.fold(events.RunEvent(msg))
		m.refresh()
		// Read the next event; once the run is done, also fetch its report (once) for the summary.
		return m, tea.Batch(waitForEventCmd(m.ch), m.maybeLoadReportCmd())
	case runSnapshotMsg:
		// Paint the run's current state — on attach, or when the watchdog re-polls a silent
		// stream. seedFromRecord never regresses live state; the SSE replay+tail reconciles.
		wasDone := m.done
		m.seedFromRecord(msg.rec)
		m.refresh()
		// The record shows the run finished while we were attached to an out-of-process run (no
		// run.verdict ever crossed this server's bus) → stop the background reconnect loop.
		if m.done && !wasDone && m.cancel != nil {
			m.cancel()
		}
		// A run that finished out-of-process lands here (not via run.verdict) — load its report too.
		return m, m.maybeLoadReportCmd()
	case streamClosedMsg:
		m.closed = true
		if msg.err != nil && !errors.Is(msg.err, context.Canceled) && !m.done {
			m.errs = append(m.errs, msg.err.Error())
		}
		m.refresh()
		// The stream ended without a verdict — most often because the run executes in another
		// process, so run.verdict never reaches this bus and the server closes the stream when the
		// record goes terminal. Pull the authoritative record so the view lands on the recap
		// instead of freezing on the last live frame.
		if !m.done && m.client != nil {
			return m, fetchRunSnapshotCmd(m.client, m.runID)
		}
		return m, nil
	case watchdogTickMsg:
		if m.done {
			return m, nil // run finished → stop the watchdog (no re-arm)
		}
		cmds := []tea.Cmd{watchdogTickCmd()} // keep ticking while the run is live
		if m.watchdogShouldReseed(time.Now()) {
			cmds = append(cmds, fetchRunSnapshotCmd(m.client, m.runID))
		}
		return m, tea.Batch(cmds...)
	case tea.WindowSizeMsg:
		m.resize(msg.Width, msg.Height)
		return m, nil
	case spinner.TickMsg:
		// Keep animating while the run is live, OR while a chat answer is pending after it finished —
		// otherwise the "thinking…" spinner would freeze on a question asked on the recap screen.
		if m.done && !m.chatLoading {
			return m, nil
		}
		var cmd tea.Cmd
		m.spin, cmd = m.spin.Update(msg)
		m.refresh() // re-render so the new spinner frame reaches the viewport
		return m, cmd
	case answerMsg:
		m.chatLoading = false
		m.chatEntries = append(m.chatEntries, chatEntry{role: "a", text: renderMarkdown(msg.text, contentWidth(m.width)), raw: msg.text})
		// Show the rendered markdown immediately.
		if m.ready {
			m.vp.GotoBottom() // bring the fresh answer into view
		}
		m.refresh()
		return m, nil
	case errMsg:
		// In the live screen a plain errMsg can only come from the embedded assistant (a failed
		// stop arrives as cancelErrMsg, handled below). Render it inside the chat thread.
		m.chatLoading = false
		m.chatEntries = append(m.chatEntries, chatEntry{role: "err", text: msg.err.Error()})
		m.refresh()
		return m, nil
	case cancelErrMsg:
		// A stop the server rejected (or that timed out) is RUN-CONTROL feedback, not an assistant
		// answer — surface it on the run's error rail so it is visible even with the chat closed,
		// and disarm the confirmation so the next 'x' re-arms a fresh attempt.
		m.stopArmed = false
		m.errs = append(m.errs, "stop failed: "+msg.err.Error())
		m.refresh()
		return m, nil
	case runReportLoadedMsg:
		// The run's report arrived — store it for the summary top-K. A fetch error is non-fatal:
		// the report is supplementary to the recap, so we just leave it unshown — but re-arm the
		// one-shot so a transient blip retries on the next terminal-state trigger instead of hiding
		// the report permanently for this live view.
		if msg.runID == m.runID {
			if msg.err != nil {
				m.reportRequested = false
			} else {
				v := msg.view
				m.report = &v
				m.refresh()
			}
		}
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
		case "r":
			// Open the dedicated report screen, handing it the already-loaded view (no re-fetch).
			if m.done && m.report != nil {
				runID, app, rep := m.runID, m.app, m.report
				return m, func() tea.Msg { return reportSelectedMsg{runID: runID, app: app, preloaded: rep} }
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
			if m.done && len(m.summaryKeys()) > 0 {
				m.moveSummary(-1) // a navigable test list → ↑↓ picks a case
				return m, nil
			}
			if m.ready {
				var cmd tea.Cmd
				m.vp, cmd = m.vp.Update(msg) // otherwise ↑↓ scrolls the recap (e.g. code/context runs)
				return m, cmd
			}
		case "down", "j":
			if m.done && len(m.summaryKeys()) > 0 {
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
// summaryKeys is the flat list of navigable item keys in the recap, IN RENDER ORDER: each test
// (keyed by its name) first, then each reviewer correction (keyed "rev:<i>"). sumFocus indexes into
// this list and sumOpen holds the single open key — so tests stay first and their existing
// navigation is unchanged, with the corrections simply appended after them.
func (m liveModel) summaryKeys() []string {
	keys := make([]string, 0, len(m.tests)+len(m.reasons))
	for _, t := range m.tests {
		keys = append(keys, t.name)
	}
	if m.reviewer != nil && !*m.reviewer {
		for i := range m.reasons {
			keys = append(keys, "rev:"+strconv.Itoa(i))
		}
	}
	return keys
}

func (m *liveModel) moveSummary(delta int) {
	n := len(m.summaryKeys())
	if n == 0 {
		return
	}
	m.sumFocus = (m.sumFocus + delta + n) % n
	m.refresh()
}

// toggleSummary expands/collapses the focused item — a test's detail, or a reviewer correction's
// full text. One item is open at a time (toggling another closes the previous).
func (m *liveModel) toggleSummary() {
	keys := m.summaryKeys()
	if m.sumFocus < 0 || m.sumFocus >= len(keys) {
		return
	}
	key := keys[m.sumFocus]
	if m.sumOpen == key {
		m.sumOpen = ""
	} else {
		m.sumOpen = key
	}
	m.refresh()
}

// maybeLoadReportCmd fires the run-report fetch exactly once — when the run first reaches a
// terminal state — so the summary can show the report top-K and drill into the full screen. It
// returns nil (a no-op inside a tea.Batch) until the run is done, and never re-fires.
func (m *liveModel) maybeLoadReportCmd() tea.Cmd {
	if !m.done || m.client == nil || m.reportRequested {
		return nil
	}
	m.reportRequested = true
	return loadRunReportCmd(m.client, m.runID)
}

// updateChatKey routes keystrokes to the embedded assistant input while it is active.
func (m liveModel) updateChatKey(msg tea.KeyMsg) (liveModel, tea.Cmd) {
	// The chat is FOCUSED here (entered via 'a'), so the arrows scroll the conversation — a long
	// answer stays readable. Item navigation (↑↓ over tests/corrections) happens only when the chat
	// is closed. j/k are deliberately NOT bound: they must stay typeable inside a question. Enter is
	// not intercepted here — it must SEND the typed message (an empty enter is handled below).
	switch msg.String() {
	case "up", "down", "pgup", "pgdown":
		if m.ready {
			var cmd tea.Cmd
			m.vp, cmd = m.vp.Update(msg)
			return m, cmd
		}
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
		m.refresh()
		return m, m.withChatSpin(askCmd(m.client, m.runID, q, hist))
	case "1", "2", "3":
		// A numbered FAQ shortcut sends that suggested question — but ONLY when the input is literally
		// empty, so typing a digit anywhere in a real question never fires a FAQ or wipes the draft.
		qs := chatSuggestions()
		idx := int(msg.String()[0] - '1')
		if m.chatInput.Value() == "" && !m.chatLoading && m.client != nil && idx < len(qs) {
			q := qs[idx]
			hist := chatHistory(m.chatEntries)
			m.chatEntries = append(m.chatEntries, chatEntry{role: "q", text: q, raw: q})
			m.chatLoading = true
			m.refresh()
			return m, m.withChatSpin(askCmd(m.client, m.runID, q, hist))
		}
		var cmd tea.Cmd
		m.chatInput, cmd = m.chatInput.Update(msg)
		m.refresh()
		return m, cmd
	default:
		var cmd tea.Cmd
		m.chatInput, cmd = m.chatInput.Update(msg)
		m.refresh()
		return m, cmd
	}
	// A matched scroll case that had nothing to scroll (vp not ready) falls through to here.
	return m, nil
}

// withChatSpin pairs the assistant query with a spinner restart when the run has already finished
// (its ticks are stopped once done) so the "thinking…" indicator animates. While the run is live the
// spinner is already ticking, so it returns the query alone — never starting a second tick chain.
func (m liveModel) withChatSpin(cmd tea.Cmd) tea.Cmd {
	if m.done {
		return tea.Batch(cmd, m.spin.Tick)
	}
	return cmd
}

// chatSuggestions are the common run questions offered under the chat input (sendable with 1/2/3).
func chatSuggestions() []string {
	return []string{"How is the run going?", "Has it found anything notable?", "What failed, and why?"}
}

// renderChat is the always-present inline assistant: a heavy rule splits it from the run
// detail, then a labelled rule, the last exchange (so it never stacks into scroll), and
// the input line. Each answer is shown as Glamour-rendered markdown as soon as it arrives.
func (m liveModel) renderChat() string {
	w := contentWidth(m.width)
	var b strings.Builder
	b.WriteString(heavyRule(w) + "\n")
	b.WriteString(labelRule(w, "chat", hintStyle.Render("assistant")) + "\n")
	entries := lastExchange(m.chatEntries)
	for _, e := range entries {
		switch e.role {
		case "q":
			b.WriteString(renderSegs("", sg("▸ ", colEmber)) + labelStyle.Render(truncate(e.text, w-2)) + "\n")
		case "err":
			b.WriteString(errorStyle.Render("✗ "+e.text) + "\n")
		default:
			b.WriteString(e.text + "\n")
		}
	}
	if m.chatLoading {
		b.WriteString(infoStyle.Render(m.spin.View()+" thinking…") + "\n")
	}
	if m.chatActive {
		b.WriteString(renderSegs("", sg("› ", colEmber)) + m.chatInput.View())
		// Common questions, sendable with 1/2/3 — only while the input is literally empty (matching
		// the send guard) so they never get in the way of a real question.
		if m.chatInput.Value() == "" {
			chips := make([]string, 0, 3)
			for i, q := range chatSuggestions() {
				chips = append(chips, renderSegs("", sg(strconv.Itoa(i+1)+" ", colEmber), sg(q, colDim)))
			}
			b.WriteString("\n" + hintStyle.Render("try  ") + strings.Join(chips, hintStyle.Render("  ·  ")))
		}
	} else {
		b.WriteString(renderSegs("", sg("› ", colFaint), sg("ask about this run", colDim)) + hintStyle.Render("   ‹a to ask›"))
	}
	return strings.TrimRight(b.String(), "\n")
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

// seedFromRecord folds a run-record snapshot into the live state on attach, filling only
// what the (fresher) event stream has not already established — so a re-attach paints the
// current phase, identity, work-so-far and, if the run finished while detached, the verdict,
// without ever regressing live state. The stream's upsert helpers reconcile any overlap.
func (m *liveModel) seedFromRecord(rec contract.RunRecord) {
	if m.sha == "" {
		m.sha = rec.Sha
	}
	if m.target == "" {
		m.target = string(rec.Target)
	}
	if m.mode == "" {
		m.mode = string(rec.Mode)
	}
	if rec.Retrying != nil && *rec.Retrying {
		m.retrying = true
	}
	// Phase drives the rail, the header progress bar and the animated status line. Seed it when
	// empty, or advance FORWARD when the record is further along the pipeline than the stream has
	// shown (a watchdog re-poll of a silent stream) — but never regress a fresher live phase, as
	// the snapshot can be staler than the stream.
	if rec.Step != nil && *rec.Step != "" {
		cur := indexOf(pipelinePhases, m.phase)
		next := indexOf(pipelinePhases, *rec.Step)
		if m.phase == "" || (next >= 0 && next > cur) {
			m.phase = *rec.Step
			if rec.StepStartedAt != nil {
				if t, err := time.Parse(time.RFC3339, *rec.StepStartedAt); err == nil {
					m.phaseStart = t
				}
			}
		}
	}
	if m.phaseStart.IsZero() {
		m.phaseStart = time.Now()
	}
	// Anchor the elapsed clock to the run's age so the header shows real time-on-task right
	// away (corrected by the first stream event's authoritative server ts).
	if m.runStartTs == 0 {
		if t, err := time.Parse(time.RFC3339, rec.At); err == nil {
			m.runStartTs = t.UnixMilli()
			if m.lastTs == 0 {
				m.lastTs = time.Now().UnixMilli()
				m.lastTsWall = time.Now()
			}
		}
	}
	// Sticky focus-card rows: the most recent file written / command run. Seed them only
	// when the stream has not already established a focus card, so a snapshot that lands
	// after live events never clobbers a fresher file/command with a staler one.
	if rec.Activity != nil && m.lastFile == "" && m.lastCmd == "" {
		for _, a := range *rec.Activity {
			switch a.Kind {
			case contract.AgentActivityKindFile:
				if a.Text != "" {
					m.lastFile = a.Text
					m.wroteAll = appendUnique(m.wroteAll, a.Text)
				}
			case contract.AgentActivityKindCommand:
				if a.Text != "" {
					m.lastCmd = a.Text
					m.ranAll = appendUnique(m.ranAll, a.Text)
				}
			}
		}
	}
	if len(m.specs) == 0 && rec.Specs != nil {
		for _, s := range *rec.Specs {
			m.specs = appendUnique(m.specs, s.Name)
		}
	}
	if len(m.tests) == 0 {
		for _, c := range rec.Cases {
			dur := 0.0
			if c.DurationMs != nil {
				dur = float64(*c.DurationMs)
			}
			detail := ""
			if c.Detail != nil {
				detail = *c.Detail
			}
			m.tests = upsertTest(m.tests, c.Name, caseStatusToTest(c.Status), dur, detail, 0)
		}
	}
	// If the run finished between detach and resume, land directly on the recap.
	if rec.Verdict != nil {
		m.verdict = string(*rec.Verdict)
		m.done = true
		if rec.Passed != nil {
			m.passed = *rec.Passed
		}
		if rec.Failed != nil {
			m.failed = *rec.Failed
		}
		// Land the cursor on the first failure (and pre-expand it), mirroring the live
		// RunVerdict handler, so the recap opens on the problem rather than on test 0.
		for i, t := range m.tests {
			if t.status == "fail" {
				m.sumFocus = i
				m.sumOpen = t.name
				break
			}
		}
	}
}

// caseStatusToTest maps a persisted QaCase status onto the live test-item vocabulary. A case
// with no terminal status yet is treated as discovered (queued).
func caseStatusToTest(status contract.QaCaseStatus) string {
	switch status {
	case contract.QaCaseStatusPass:
		return "pass"
	case contract.QaCaseStatusFail:
		return "fail"
	case contract.QaCaseStatusFlaky:
		return "flaky"
	default:
		return "discovered"
	}
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
	// Widen the chat input to the content width so a long question scrolls far less — the old fixed
	// 48 cols hid the start of the line as you typed.
	if iw := contentWidth(w) - 4; iw > 20 {
		m.chatInput.Width = iw
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
	// A transient phase (retry) has no position in the canonical pipeline, so a progress fraction
	// would sit frozen at 0% — show a marquee instead, which reads as "working". The empty
	// not-started window (phase == "") keeps the normal 0% bar, so the marquee fires only for a
	// real transient phase.
	bar := progressBar(w, m.phaseFraction(), sc)
	if !m.done && m.phase != "" && m.phaseIndex() < 0 {
		bar = indeterminateBar(w, sc)
	}
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
		// Focused on the chat: the arrows scroll the conversation; item navigation resumes on close.
		return hintStyle.Render("↑↓ scroll · type to ask · ↵ send · esc close chat")
	}
	if m.done {
		nav := "↑↓ scroll"
		if len(m.tests) > 0 {
			nav = "↑↓ items · ↵ expand"
		}
		actions := nav + " · e export · a ask"
		if m.report != nil {
			actions += " · r report"
		}
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
	if m.report != nil {
		b.WriteString(renderReportSummary(m.report.Current, w, 3) + "\n\n")
	}

	if wh := m.renderWhatHappened(w); wh != "" {
		b.WriteString(wh + "\n\n")
	}
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
			row("reviewer", errorStyle.Render("rejected · "+pluralize(len(m.reasons), "correction", "corrections")))
			// The corrections are navigable expand rows (one open at a time), keyed after the tests
			// in the recap cursor — readable badge + spec, full detail on expand instead of a "…" cut.
			if len(m.reasons) > 0 {
				notes := make([]reviewerNote, len(m.reasons))
				for i, r := range m.reasons {
					notes[i] = parseReviewerNote(r)
				}
				openIdx := -1
				for i := range notes {
					if m.sumOpen == "rev:"+strconv.Itoa(i) {
						openIdx = i
					}
				}
				rows := reviewerRows(notes, w-3, openIdx)
				focus := -1
				if base := len(m.tests); m.sumFocus >= base && m.sumFocus < base+len(rows) {
					focus = m.sumFocus - base
				}
				b.WriteString(renderExpandList(w, rows, focus, m.sumOpen) + "\n")
			}
		}
	}
	if txt, ok := m.coverageText(); ok {
		row("coverage", txt)
	}
	if m.agentErr != "" && m.verdict != "pass" && m.verdict != "skipped" {
		row("note", hintStyle.Render(truncate(m.agentErr, w-13)))
	}
	body := strings.TrimRight(b.String(), "\n")
	if body == "" {
		return "" // nothing to recap (e.g. a code/context run with no recorded activity) — omit the heading
	}
	return labelRule(w, "what happened", "") + "\n" + body
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
			// Expanded → the test detail card (spec · flow · duration · retries · cause), no path.
			b.WriteString(indentBlock(renderTestCard(t, w-7), "     ") + "\n")
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
	if total := len(m.tests); total > 0 {
		b.WriteString("  " + renderTestBar(counts, total, contentWidth(m.width)-2) + "\n")
	}

	// renderTests is the LIVE test section (liveBody runs only while !m.done); the finished
	// recap is rendered separately by renderTestList. So there is no done-branch here.
	if hasCurrent {
		// The current case as the focus card — readable spec/flow/assertion, not a raw path.
		b.WriteString("  " + eyebrowStyle.Render("NOW RUNNING") + " " + infoStyle.Render(m.spin.View()) + "\n")
		b.WriteString(indentBlock(renderTestCard(current, contentWidth(m.width)-2), "  ") + "\n")
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

// renderTestBar draws a STACKED progress bar over the discovered cases: green (passed), red
// (failed), amber (flaky) and steel (running) segments fill from the left in proportion to the
// total, the remainder grey (queued). It reads as both progress (how much has run) AND health
// (how much is green) — unlike the old passed/total bar, which sat still while cases failed.
// Cumulative rounding keeps the segments summing to exactly the bar width (no overflow).
func renderTestBar(c testCounts, total, width int) string {
	if total <= 0 {
		return ""
	}
	barW := max(10, width-20) // leave room for the trailing "  8/10 2✓ 6✗"
	bound := func(n int) int { return int(float64(n)/float64(total)*float64(barW) + 0.5) }
	p := bound(c.passed)
	pf := bound(c.passed + c.failed)
	pfx := bound(c.passed + c.failed + c.flaky)
	pfxr := bound(c.passed + c.failed + c.flaky + c.running)
	fill := func(col lipgloss.Color, n int) string {
		return lipgloss.NewStyle().Foreground(col).Render(strings.Repeat("█", n))
	}
	bar := fill(colPass, p) + fill(colFail, pf-p) + fill(colFlaky, pfx-pf) + fill(colInfra, pfxr-pfx) +
		lipgloss.NewStyle().Foreground(colRule).Render(strings.Repeat("░", barW-pfxr))

	executed := c.passed + c.failed + c.flaky
	right := hintStyle.Render(fmt.Sprintf("  %d/%d", executed, total))
	if c.passed > 0 {
		right += " " + okStyle.Render(fmt.Sprintf("%d✓", c.passed))
	}
	if c.failed > 0 {
		right += " " + errorStyle.Render(fmt.Sprintf("%d✗", c.failed))
	}
	if c.flaky > 0 {
		right += " " + shadowStyle.Render(fmt.Sprintf("%d~", c.flaky))
	}
	return bar + right
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
	w := contentWidth(m.width)
	if *m.reviewer {
		return labelRule(w, "reviewer", okStyle.Render("approved"))
	}
	var b strings.Builder
	b.WriteString(labelRule(w, "reviewer", errorStyle.Render("rejected · "+pluralize(len(m.reasons), "correction", "corrections"))) + "\n")
	// Each correction parsed into a readable badge + spec headline, with its full detail wrapped
	// beneath — never the old single opaque "…"-truncated line. The live view scrolls, so the
	// detail is shown inline (the navigable expand/collapse lives in the finished-run recap).
	for i, r := range m.reasons {
		if i >= 6 {
			b.WriteString("  " + hintStyle.Render(fmt.Sprintf("+%d more · open the recap to read them", len(m.reasons)-6)) + "\n")
			break
		}
		n := parseReviewerNote(r)
		head := "  "
		if badge := classBadge(n.class); badge != "" {
			head += badge + " "
		}
		title := n.spec
		if title == "" {
			title = truncate(n.detail, max(12, w-20))
		}
		b.WriteString(head + lipgloss.NewStyle().Foreground(colFg).Render(title) + "\n")
		// Live view: a SYNTHESISED one-liner (first sentence) with inline markdown — the full,
		// markdown-rendered detail is one keystroke away in the finished-run recap.
		if n.spec != "" && n.detail != "" {
			syn := firstSentence(n.detail, 150)
			for _, line := range wrapMarkedLines(syn, w-6) {
				b.WriteString("    " + line + "\n")
			}
		}
	}
	return strings.TrimRight(b.String(), "\n")
}

// wrapMarkedLines word-wraps a string to width, then applies inline markdown per line — so `code`
// spans stay styled without the wrap miscounting ANSI escapes.
func wrapMarkedLines(s string, width int) []string {
	plain := wrapText(s, width)
	out := make([]string, 0, len(plain))
	for _, l := range plain {
		out = append(out, renderInlineMd(l))
	}
	return out
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

// watchdogShouldReseed reports whether the silent-stream watchdog should pull a fresh record
// snapshot: the run is still live, a client is available to fetch with, and no stream event has
// arrived for streamStaleAfter.
func (m liveModel) watchdogShouldReseed(now time.Time) bool {
	return !m.done && m.client != nil && !m.lastActivity.IsZero() && now.Sub(m.lastActivity) >= streamStaleAfter
}

// watchdogTickMsg fires on a fixed cadence while a run is live; the handler re-seeds from the
// record when the stream has gone silent (see watchdogShouldReseed) and stops once the run is done.
type watchdogTickMsg struct{}

func watchdogTickCmd() tea.Cmd {
	return tea.Tick(watchdogInterval, func(time.Time) tea.Msg { return watchdogTickMsg{} })
}

// runSnapshotMsg carries the authoritative run-record fetched once on attach. The live view
// rebuilds its state from the SSE stream starting empty, so on a re-attach mid-run there is a
// window (a quiet phase, a slow replay) where the rail is blank and the bar reads 0%. Seeding
// from this snapshot closes that window — the view is correct from the first frame.
type runSnapshotMsg struct{ rec contract.RunRecord }

// fetchRunSnapshotCmd loads the run record so the live view can seed its state on mount.
// Best-effort: the SSE stream is the primary, fresher source, so a failed or absent snapshot
// is silently ignored (it must never surface as an errMsg — that path is the chat assistant).
func fetchRunSnapshotCmd(c *api.Client, id string) tea.Cmd {
	return func() tea.Msg {
		if c == nil {
			return nil
		}
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		rec, err := c.GetRun(ctx, id)
		if err != nil {
			return nil
		}
		return runSnapshotMsg{rec: rec}
	}
}

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
