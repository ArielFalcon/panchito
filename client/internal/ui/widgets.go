package ui

// widgets.go holds the reusable building blocks introduced for the live/summary UX pass: an
// indeterminate marquee meter (for transient phases with no known progress), a navigable
// expand/collapse list (one item open at a time), and a test detail card. They reuse the brand
// palette and the existing primitives so the new surfaces read as part of the same design.

import (
	"strconv"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

// indeterminateBar is a marquee meter for a transient phase with no known progress (e.g. the retry
// pass): a short lit segment slides across the track, so the bar reads as "working" rather than a
// frozen 0%. It is animated by wall-clock time; the live header already repaints on each spinner
// tick, so the segment advances smoothly.
func indeterminateBar(width int, color lipgloss.Color) string {
	barW := max(8, width-6)
	seg := max(3, barW/6)
	span := barW + seg
	pos := int(time.Now().UnixMilli()/110) % span // slides one cell per ~110ms
	var b strings.Builder
	lit := lipgloss.NewStyle().Foreground(color)
	track := lipgloss.NewStyle().Foreground(colRule)
	for i := 0; i < barW; i++ {
		if i >= pos-seg && i < pos {
			b.WriteString(lit.Render("▰"))
		} else {
			b.WriteString(track.Render("▱"))
		}
	}
	return b.String() + lit.Render("  ···")
}

// ── reviewer corrections: parse one opaque "[class] spec: detail" line into readable parts ──────

// reviewerNote is a parsed reviewer correction. The raw lines look like
// "[fragile-selector] navigation.spec.ts: getByRole('heading', { name: 'Owner' })" — one opaque,
// always-truncated string. Splitting it lets the recap show a coloured class badge + the spec name
// as a one-line header, with the full detail revealed on expand instead of cut off with "…".
type reviewerNote struct {
	class  string // e.g. "fragile-selector"
	spec   string // e.g. "navigation.spec.ts"
	detail string // the actionable remainder
	raw    string
}

func parseReviewerNote(s string) reviewerNote {
	n := reviewerNote{raw: strings.TrimSpace(s)}
	t := n.raw
	if strings.HasPrefix(t, "[") {
		if i := strings.IndexByte(t, ']'); i > 0 {
			n.class = strings.TrimSpace(t[1:i])
			t = strings.TrimSpace(t[i+1:])
		}
	}
	// "spec: detail" — only treat the head as a spec when it looks like a single file token.
	if i := strings.Index(t, ": "); i > 0 {
		head := strings.TrimSpace(t[:i])
		if !strings.ContainsAny(head, " \t") && strings.Contains(head, ".") {
			n.spec = head
			n.detail = strings.TrimSpace(t[i+1:])
			return n
		}
	}
	n.detail = t
	return n
}

// reviewerClassColor maps a correction class to the palette so the badge reads at a glance: a
// fragile-selector is a stability concern (flaky-amber), coverage/value is a signal concern
// (infra-steel), anything else is the generic accent.
func reviewerClassColor(class string) lipgloss.Color {
	switch {
	case class == "":
		return colDim
	case strings.Contains(class, "fragile") || strings.Contains(class, "selector") || strings.Contains(class, "flaky"):
		return colFlaky
	case strings.Contains(class, "coverage") || strings.Contains(class, "value") || strings.Contains(class, "assert"):
		return colInfra
	default:
		return colEmber
	}
}

// classBadge renders the correction class as a filled chip; empty class → an empty string.
func classBadge(class string) string {
	if class == "" {
		return ""
	}
	return lipgloss.NewStyle().Foreground(colBg).Background(reviewerClassColor(class)).Bold(true).Padding(0, 1).Render(class)
}

// wrapText word-wraps s to width (ANSI-naive — for plain detail text), returning the lines.
func wrapText(s string, width int) []string {
	if width < 8 {
		width = 8
	}
	words := strings.Fields(s)
	if len(words) == 0 {
		return nil
	}
	var lines []string
	cur := words[0]
	for _, wd := range words[1:] {
		if len(cur)+1+len(wd) > width {
			lines = append(lines, cur)
			cur = wd
		} else {
			cur += " " + wd
		}
	}
	return append(lines, cur)
}

// codeStyle paints inline `code` spans, so a reviewer note reads like the chat's markdown.
var codeStyle = lipgloss.NewStyle().Foreground(colEmberS)

// shortRunID truncates a run id to a stable 8-char prefix — the single length used wherever a run
// is labelled (history list, report header) so the same run reads identically across screens.
func shortRunID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// firstSentence synthesises a long reviewer detail down to its lead: the first sentence when that is
// short enough, otherwise a hard cut — so the live view shows the gist, not a six-line paragraph.
func firstSentence(s string, maxLen int) string {
	s = strings.TrimSpace(strings.Join(strings.Fields(s), " ")) // collapse whitespace/newlines
	if i := strings.Index(s, ". "); i > 0 && i+1 <= maxLen {
		return s[:i+1]
	}
	if len([]rune(s)) > maxLen {
		return strings.TrimSpace(string([]rune(s)[:maxLen])) + "…"
	}
	return s
}

// renderInlineMd is a minimal inline-markdown pass: `code` spans get the code style, everything else
// stays plain. Glamour is for whole documents; this is for one synthesised line on the live view.
func renderInlineMd(s string) string {
	parts := strings.Split(s, "`")
	var b strings.Builder
	for i, p := range parts {
		if i%2 == 1 { // between a pair of backticks
			b.WriteString(codeStyle.Render(p))
		} else {
			b.WriteString(hintStyle.Render(p))
		}
	}
	return b.String()
}

// ── navigable expand/collapse list — one item open at a time ─────────────────────────────────

// expandRow is one navigable item: a collapsed one-line header and the lines revealed on expand.
type expandRow struct {
	key    string   // stable id, matched against the open key
	header string   // already-styled, one line (the collapsed view)
	body   []string // already-styled lines shown when expanded
}

// renderExpandList draws rows with the focused one bearing the ember bar and the open one revealing
// its body. focusIdx is the index of the focused row WITHIN this list (or -1 when focus is elsewhere);
// openKey is the globally-open row key. Indentation matches the test list so columns stay aligned.
func renderExpandList(w int, rows []expandRow, focusIdx int, openKey string) string {
	var b strings.Builder
	for i, r := range rows {
		if i == focusIdx {
			b.WriteString(renderSegs("", sg("▌▸ ", colEmber)) + r.header + "\n")
		} else {
			b.WriteString("   " + r.header + "\n")
		}
		if r.key == openKey {
			for _, line := range r.body {
				b.WriteString("       " + line + "\n")
			}
		}
	}
	return strings.TrimRight(b.String(), "\n")
}

// reviewerRows turns the reviewer corrections into navigable expand rows, keyed "rev:<i>". The
// header is "badge spec" (with a caret when there is detail to reveal); the body is the wrapped,
// full detail — no more truncation with "…".
func reviewerRows(notes []reviewerNote, w, openIdx int) []expandRow {
	rows := make([]expandRow, 0, len(notes))
	for i, n := range notes {
		open := i == openIdx
		caret := hintStyle.Render("▸")
		if open {
			caret = hintStyle.Render("▾")
		}
		head := caret + " "
		if badge := classBadge(n.class); badge != "" {
			head += badge + " "
		}
		title := n.spec
		if title == "" {
			title = ansi.Truncate(n.detail, max(12, w-24), "…")
		}
		head += lipgloss.NewStyle().Foreground(colFg).Render(title)
		// The expanded detail is rendered as markdown (same renderer as the chat) so `code`, lists
		// and emphasis read the same way — the full text, not a synthesis.
		var body []string
		body = append(body, strings.Split(strings.TrimRight(renderMarkdown(n.detail, max(20, w-9)), "\n"), "\n")...)
		rows = append(rows, expandRow{key: "rev:" + strconv.Itoa(i), header: head, body: body})
	}
	return rows
}

// ── test detail card — readable facts, no file paths ────────────────────────────────────────

// parsedTest splits a Playwright case name "spec.spec.ts › Describe › it does X" into the parts a
// human reads: the spec (sans path/extension), the flow (the describe), and the assertion title.
type parsedTest struct{ spec, flow, title string }

func parseTestName(name string) parsedTest {
	parts := strings.Split(name, " › ")
	p := parsedTest{title: name}
	if len(parts) == 0 {
		return p
	}
	spec := baseName(parts[0])
	spec = strings.TrimSuffix(spec, ".ts")
	spec = strings.TrimSuffix(spec, ".spec")
	p.spec = spec
	if len(parts) >= 3 {
		p.flow = parts[1]
	}
	if len(parts) >= 2 {
		p.title = parts[len(parts)-1]
	}
	return p
}

func statusWord(status string) string {
	switch status {
	case "pass":
		return "passed"
	case "fail":
		return "failed"
	case "flaky":
		return "flaky"
	case "running":
		return "running"
	case "discovered":
		return "queued"
	default:
		return status
	}
}

// renderTestCard draws one case as the screen's focus card: the spec in the title, the assertion as
// the headline, then readable rows (flow · duration · retries · failure cause). It deliberately
// never shows the absolute file path — a basename spec is enough to locate the test.
func renderTestCard(t testItem, w int) string {
	pt := parseTestName(t.name)
	_, col := testGlyph(t.status)
	gi, _ := testGlyph(t.status)
	right := lipgloss.NewStyle().Foreground(col).Bold(true).Render(gi + " " + statusWord(t.status))
	headline := pt.title
	var rows []cardKV
	if pt.flow != "" {
		rows = append(rows, kv("◇", colDim, "flow", labelStyle.Render(pt.flow)))
	}
	if t.durationMs > 0 {
		rows = append(rows, kv("⏱", colInfra, "took", hintStyle.Render(formatDuration(t.durationMs))))
	}
	if t.attempts > 0 {
		rows = append(rows, kv("↻", colFlaky, "retries", shadowStyle.Render(strconv.Itoa(t.attempts)+" before green")))
	}
	if t.detail != "" {
		for i, line := range wrapText(t.detail, max(12, w-22)) {
			verb := ""
			if i == 0 {
				verb = "cause"
			}
			rows = append(rows, kv("", colFail, verb, errorStyle.Render(line)))
		}
	}
	title := titleStyle.Render(pt.spec)
	if pt.spec == "" {
		title = titleStyle.Render("test")
	}
	return focusCard(w, col, title, right, headline, "", rows)
}

// indentBlock prefixes every line of s with pad — for nesting a multi-line card inside a list.
func indentBlock(s, pad string) string {
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		lines[i] = pad + l
	}
	return strings.Join(lines, "\n")
}
