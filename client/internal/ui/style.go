package ui

import (
	"strconv"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

// Design system — the shared visual language of the TUI redesign mock. Structure is
// drawn with labelled hairline rules, never nested boxes; exactly ONE boxed element
// lives on a screen (a focus card); selection is an ember bar over an ember wash;
// status always uses the verdict ramp. Every helper is width-aware so the 84-column
// grid holds its proportions on wider terminals and gracefully narrows below it.

const maxContentWidth = 84

// contentWidth is the inner grid width: the terminal minus the screen gutter, capped so
// wide terminals don't stretch rules edge-to-edge, with a floor — and a sane default
// when the size is not yet known (first paint, or hermetic tests with no WindowSizeMsg).
func contentWidth(termWidth int) int {
	if termWidth <= 0 {
		return maxContentWidth
	}
	w := termWidth - 4 // screenStyle padding: 2 cols each side
	if w > maxContentWidth {
		return maxContentWidth
	}
	if w < 24 {
		return 24
	}
	return w
}

// ── Segments: a (text, fg, bold) tuple, mirroring the mock's s(). Rendering each
// segment with a shared background is how a multi-color row gets one continuous wash —
// a single outer style would have its background cleared by the nested resets. ────────

type seg struct {
	text string
	fg   lipgloss.Color
	bold bool
}

func sg(text string, fg lipgloss.Color) seg  { return seg{text: text, fg: fg} }
func sgb(text string, fg lipgloss.Color) seg { return seg{text: text, fg: fg, bold: true} }

// renderSegs paints each segment with its own fg over the (optional) shared bg.
func renderSegs(bg lipgloss.Color, segs ...seg) string {
	var b strings.Builder
	for _, s := range segs {
		st := lipgloss.NewStyle()
		if s.fg != "" {
			st = st.Foreground(s.fg)
		}
		if bg != "" {
			st = st.Background(bg)
		}
		if s.bold {
			st = st.Bold(true)
		}
		b.WriteString(st.Render(s.text))
	}
	return b.String()
}

// ── Rules: structure is rules, not boxes. ─────────────────────────────────────────────

// hairline is a full-width rule in the structural grey.
func hairline(width int) string {
	return lipgloss.NewStyle().Foreground(colRule).Render(strings.Repeat("─", max(0, width)))
}

// heavyRule is the stronger `═` divider that splits major regions (e.g. log / chat).
func heavyRule(width int) string {
	return lipgloss.NewStyle().Foreground(colRuleS).Render(strings.Repeat("═", max(0, width)))
}

// labelRule renders an eyebrow, a hairline that fills the row, and an optional, already
// styled right annotation:  LABEL ─────────────────────────── right
func labelRule(width int, label, right string) string {
	return styledRule(width, eyebrowStyle.Render(strings.ToUpper(label)), right)
}

// accentRule is labelRule with an ember eyebrow — the one primary header on a screen.
func accentRule(width int, label, right string) string {
	return styledRule(width, lipgloss.NewStyle().Bold(true).Foreground(colEmber).Render(strings.ToUpper(label)), right)
}

func styledRule(width int, left, right string) string {
	used := 0
	if left != "" {
		used += lipgloss.Width(left) + 1 // trailing space
	}
	if right != "" {
		used += lipgloss.Width(right) + 1 // leading space
	}
	dashes := max(0, width-used)
	var b strings.Builder
	if left != "" {
		b.WriteString(left + " ")
	}
	b.WriteString(lipgloss.NewStyle().Foreground(colRule).Render(strings.Repeat("─", dashes)))
	if right != "" {
		b.WriteString(" " + right)
	}
	return b.String()
}

// ── Selection rows: the ember bar + wash that marks the cursor. ────────────────────────

// selectedRow is the focused list row: ember bar `▌▸`, optional icon, bold label, and an
// optional right-aligned ember hint — all over an ember wash spanning the full width.
func selectedRow(width int, icon, label, hint string) string {
	segs := []seg{sg("▌▸ ", colEmber)}
	if icon != "" {
		segs = append(segs, sg(icon+"  ", colEmber))
	}
	segs = append(segs, sgb(label, colFg))
	left := renderSegs(colWash, segs...)
	if hint == "" {
		// Pad to width so the wash reaches the right edge.
		fill := max(0, width-lipgloss.Width(left))
		return left + renderSegs(colWash, sg(strings.Repeat(" ", fill), colFg))
	}
	h := renderSegs(colWash, sg(hint, colEmberS))
	fill := max(2, width-lipgloss.Width(left)-lipgloss.Width(h))
	return left + renderSegs(colWash, sg(strings.Repeat(" ", fill), colFg)) + h
}

// normalRow is an unfocused list row: dim icon + label, with an optional faint right
// hint aligned to the same width as the selected rows so the column stays steady.
func normalRow(width int, icon, label, hint string) string {
	left := "   " // align under the `▌▸ ` of a selected row
	if icon != "" {
		left += labelStyle.Render(icon + "  ")
	}
	left += labelStyle.Render(label)
	if hint == "" {
		return left
	}
	h := hintStyle.Render(hint)
	fill := max(2, width-lipgloss.Width(left)-lipgloss.Width(h))
	return left + strings.Repeat(" ", fill) + h
}

// ── The focus card: the single boxed element. A titled rounded box whose header is woven
// into the top border (left title · filler · right status), a dotted divider, then a body
// of verb/value rows. One frame is shared by generate / execute / fail. ───────────────

type cardKV struct {
	glyph    string
	glyphCol lipgloss.Color
	verb     string
	value    string // already styled
	right    string // already styled, right-aligned (optional)
}

// kv builds one verb/value row for a focus card body.
func kv(glyph string, glyphCol lipgloss.Color, verb, value string) cardKV {
	return cardKV{glyph: glyph, glyphCol: glyphCol, verb: verb, value: value}
}

func (r cardKV) withRight(right string) cardKV { r.right = right; return r }

// focusCard renders the boxed centerpiece. border is the state color (ember/infra/fail);
// title and rightHead are already styled; body holds the verb/value rows.
func focusCard(width int, border lipgloss.Color, title, rightHead, headline, headlineRight string, rows []cardKV) string {
	inner := max(10, width-4) // between the "│ " … " │" walls
	bs := lipgloss.NewStyle().Foreground(border)

	// Top border with the woven header: ┌─ title ───── rightHead ─┐
	// Fixed glyphs: "┌─ "(3) + " "(1) + " "(1) + " ─┐"(3) = 8, so the dashes fill the
	// rest — anything less leaves the top row wider than the body walls (a broken corner).
	usedTop := 8 + lipgloss.Width(title) + lipgloss.Width(rightHead)
	dashes := max(1, width-usedTop)
	top := bs.Render("┌─ ") + title + bs.Render(" "+strings.Repeat("─", dashes)+" ") + rightHead + bs.Render(" ─┐")

	var b strings.Builder
	b.WriteString(top + "\n")

	if headline != "" {
		b.WriteString(cardLine(inner, border, headlineRow(inner, headline, headlineRight)) + "\n")
		b.WriteString(cardLine(inner, border, lipgloss.NewStyle().Foreground(colRule).Render(strings.Repeat("┄", inner))) + "\n")
	}
	for _, r := range rows {
		b.WriteString(cardLine(inner, border, kvLine(inner, r)) + "\n")
	}
	b.WriteString(bs.Render("└" + strings.Repeat("─", width-2) + "┘"))
	return b.String()
}

// cardLine wraps one body line in the card walls, clipping (ANSI-aware) then padding the
// content to the inner width — so an over-long value can never push the right wall out.
func cardLine(inner int, border lipgloss.Color, content string) string {
	bs := lipgloss.NewStyle().Foreground(border)
	if lipgloss.Width(content) > inner {
		content = ansi.Truncate(content, inner, "…")
	}
	fill := max(0, inner-lipgloss.Width(content))
	return bs.Render("│ ") + content + strings.Repeat(" ", fill) + bs.Render(" │")
}

func headlineRow(inner int, headline, right string) string {
	left := lipgloss.NewStyle().Bold(true).Foreground(colFg).Render(headline)
	if right == "" {
		return left
	}
	fill := max(2, inner-lipgloss.Width(left)-lipgloss.Width(right))
	return left + strings.Repeat(" ", fill) + right
}

func kvLine(inner int, r cardKV) string {
	left := lipgloss.NewStyle().Foreground(r.glyphCol).Render(r.glyph) + "  " +
		labelStyle.Render(padRight(r.verb, 7)) + "  " + r.value
	if r.right == "" {
		return left
	}
	fill := max(2, inner-lipgloss.Width(left)-lipgloss.Width(r.right))
	return left + strings.Repeat(" ", fill) + r.right
}

// ── Pipeline rail + progress bar. ─────────────────────────────────────────────────────

// pipelineRail joins the phases with ` · `: completed are dim, the active one is ember
// (or the given state color) and arrowed, pending are faint. activeColor lets the live
// screen tint the rail by sub-state (generate=ember, execute=infra, fail=fail).
func pipelineRail(width int, phases []string, activeIdx int, done bool, activeColor lipgloss.Color) string {
	parts := make([]string, len(phases))
	for i, p := range phases {
		switch {
		case done:
			parts[i] = labelStyle.Render(p)
		case i < activeIdx:
			parts[i] = labelStyle.Render(p)
		case i == activeIdx:
			parts[i] = lipgloss.NewStyle().Bold(true).Foreground(activeColor).Render("▸" + p)
		default:
			parts[i] = hintStyle.Render(p)
		}
	}
	return wrapJoin(parts, hintStyle.Render(" · "), width)
}

// progressBar is the `▰▱` meter with a trailing percentage, both in the state color.
func progressBar(width int, frac float64, color lipgloss.Color) string {
	if frac < 0 {
		frac = 0
	}
	if frac > 1 {
		frac = 1
	}
	barW := max(8, width-6) // leave room for "  100%"
	filled := int(float64(barW)*frac + 0.5)
	if filled > barW {
		filled = barW
	}
	pct := int(frac*100 + 0.5)
	return lipgloss.NewStyle().Foreground(color).Render(strings.Repeat("▰", filled)) +
		lipgloss.NewStyle().Foreground(colRule).Render(strings.Repeat("▱", barW-filled)) +
		lipgloss.NewStyle().Foreground(color).Render("  "+strconv.Itoa(pct)+"%")
}

// spread lays out a left and right cluster on one line, filling the gap to width.
func spread(width int, left, right string) string {
	fill := max(1, width-lipgloss.Width(left)-lipgloss.Width(right))
	return left + strings.Repeat(" ", fill) + right
}
