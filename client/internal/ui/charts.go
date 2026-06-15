package ui

// charts.go renders a self-describing report insight (from the control plane) into the TUI's own
// visual language. Clients render BY INTENT, not by the literal `chart` field: a terminal has no
// good pie, so a `composition` becomes a stacked bar + legend, a `distribution` becomes ranked
// bars, a `trend` becomes a sparkline, a `single-value` becomes a gauge / big number. The brand
// palette and the existing primitives (sparkline, progressBar, renderSegs, rules) are reused so the
// report reads as part of the same design — structure is rules, status is the verdict ramp — rather
// than a bolted-on chart library.

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/ArielFalcon/panchito/internal/contract"
	"github.com/charmbracelet/lipgloss"
)

// ── value formatting ──────────────────────────────────────────────────────────

func toF64(xs []float32) []float64 {
	out := make([]float64, len(xs))
	for i, x := range xs {
		out[i] = float64(x)
	}
	return out
}

func abs32(v float32) float32 {
	if v < 0 {
		return -v
	}
	return v
}

// trimNum prints a whole number without a decimal, else one decimal place.
func trimNum(v float32) string {
	if v == float32(int64(v)) {
		return fmt.Sprintf("%d", int64(v))
	}
	return fmt.Sprintf("%.1f", v)
}

// fmtDuration turns milliseconds into a compact human duration (1.2s, 2m05s).
func fmtDuration(ms float32) string {
	s := float64(ms) / 1000
	if s < 60 {
		return fmt.Sprintf("%.1fs", s)
	}
	m := int(s) / 60
	return fmt.Sprintf("%dm%02ds", m, int(s)%60)
}

// fmtValue formats a metric value by its unit so every screen reads it consistently. A nil value is
// "not measured" — rendered as an em dash, never a fabricated zero.
func fmtValue(v *float32, unit *contract.ReportInsightUnit) string {
	if v == nil {
		return "—"
	}
	switch unitStr(unit) {
	case "ratio":
		return fmt.Sprintf("%.0f%%", float64(*v)*100)
	case "percent":
		return fmt.Sprintf("%.0f%%", float64(*v))
	case "ms":
		return fmtDuration(*v)
	default: // count, score, unset
		return trimNum(*v)
	}
}

func unitStr(u *contract.ReportInsightUnit) string {
	if u == nil {
		return ""
	}
	return string(*u)
}

// ── colour ─────────────────────────────────────────────────────────────────────

// insightColor maps a metric to the verdict ramp by whether it moved in its good direction. A gauge
// with a target is coloured by whether it MEETS the target; a neutral metric stays foreground.
func insightColor(ins contract.ReportInsight) lipgloss.Color {
	gw := string(ins.GoodWhen)
	if gw == "neutral" {
		return colFg
	}
	if ins.Target != nil && ins.Value != nil {
		meets := (*ins.Value >= *ins.Target) == (gw == "up")
		if meets {
			return colPass
		}
		return colFail
	}
	switch string(ins.Direction) {
	case "up":
		if gw == "up" {
			return colPass
		}
		return colFail
	case "down":
		if gw == "down" {
			return colPass
		}
		return colFail
	default:
		return colFg
	}
}

// semanticColor paints one breakdown slice: the backend owns the domain meaning (pass=good,
// fail=bad) so every client colours it identically.
func semanticColor(s *contract.ReportInsightBreakdownSemantic) lipgloss.Color {
	if s == nil {
		return colDim
	}
	switch string(*s) {
	case "good":
		return colPass
	case "bad":
		return colFail
	default:
		return colInfra
	}
}

func dirArrow(direction string) string {
	switch direction {
	case "up":
		return "▲"
	case "down":
		return "▼"
	default:
		return "•"
	}
}

// ── per-intent renderers (full, for the detail screen) ──────────────────────────

// renderInsightFull renders one insight as a titled block: a labelled rule with the headline value,
// the intent's native visual, then the caption. Used on the dedicated report screen.
func renderInsightFull(ins contract.ReportInsight, w int) string {
	var b strings.Builder
	right := lipgloss.NewStyle().Bold(true).Foreground(insightColor(ins)).Render(fmtValue(ins.Value, ins.Unit))
	b.WriteString(labelRule(w, ins.Title, right) + "\n")
	switch string(ins.Intent) {
	case "composition":
		if bar := renderStacked(ins, w); bar != "" {
			b.WriteString(bar + "\n")
		}
		b.WriteString(renderLegend(ins, w))
	case "distribution":
		b.WriteString(renderRankedBars(ins, w))
	case "trend":
		b.WriteString(renderTrend(ins, w))
	default: // single-value, comparison
		b.WriteString(renderGauge(ins, w))
	}
	if ins.Caption != nil && *ins.Caption != "" {
		b.WriteString("\n" + hintStyle.Render(truncate(*ins.Caption, w)))
	}
	return strings.TrimRight(b.String(), "\n")
}

// renderGauge draws a single value: a 0..1 ratio becomes a progress meter (tinted by meeting its
// target); any other unit becomes a big number with an optional delta arrow.
func renderGauge(ins contract.ReportInsight, w int) string {
	if ins.Value == nil {
		return hintStyle.Render("not measured")
	}
	col := insightColor(ins)
	if u := unitStr(ins.Unit); u == "ratio" || u == "percent" {
		frac := float64(*ins.Value)
		if u == "percent" {
			frac /= 100
		}
		return progressBar(w, frac, col)
	}
	big := lipgloss.NewStyle().Bold(true).Foreground(col).Render(fmtValue(ins.Value, ins.Unit))
	if ins.Delta != nil && *ins.Delta != 0 {
		big += "  " + lipgloss.NewStyle().Foreground(col).Render(dirArrow(string(ins.Direction))+" "+trimNum(abs32(*ins.Delta)))
	}
	return big
}

// renderStacked draws a composition as one full-width bar split by each slice's share, coloured by
// its semantic. The last slice fills the remainder so rounding never leaves a gap.
func renderStacked(ins contract.ReportInsight, w int) string {
	if ins.Breakdown == nil || len(*ins.Breakdown) == 0 {
		return ""
	}
	var total float32
	for _, s := range *ins.Breakdown {
		total += s.Value
	}
	if total <= 0 {
		return hintStyle.Render("—")
	}
	barW := max(8, w)
	var b strings.Builder
	used := 0
	bd := *ins.Breakdown
	for i, s := range bd {
		seg := int(float64(s.Value)/float64(total)*float64(barW) + 0.5)
		if i == len(bd)-1 {
			seg = barW - used // last slice absorbs the rounding remainder
		}
		if seg < 0 {
			seg = 0
		}
		b.WriteString(lipgloss.NewStyle().Foreground(semanticColor(s.Semantic)).Render(strings.Repeat("█", seg)))
		used += seg
	}
	return b.String()
}

// renderLegend lists a composition's slices as "■ label value (pct)", wrapped to width.
func renderLegend(ins contract.ReportInsight, w int) string {
	if ins.Breakdown == nil || len(*ins.Breakdown) == 0 {
		return ""
	}
	var total float32
	for _, s := range *ins.Breakdown {
		total += s.Value
	}
	parts := make([]string, 0, len(*ins.Breakdown))
	for _, s := range *ins.Breakdown {
		pctTxt := ""
		if total > 0 {
			pctTxt = fmt.Sprintf(" (%.0f%%)", float64(s.Value)/float64(total)*100)
		}
		parts = append(parts, renderSegs("", sg("■ ", semanticColor(s.Semantic)), sg(s.Label+" ", colDim), sg(trimNum(s.Value), colFg))+hintStyle.Render(pctTxt))
	}
	return wrapJoin(parts, hintStyle.Render("  ·  "), w)
}

// renderRankedBars draws a distribution as one labelled proportional bar per slice (top 6), each
// scaled to the largest value and coloured by its semantic.
func renderRankedBars(ins contract.ReportInsight, w int) string {
	if ins.Breakdown == nil || len(*ins.Breakdown) == 0 {
		return hintStyle.Render("—")
	}
	bd := *ins.Breakdown
	var maxV float32
	labelW := 0
	for _, s := range bd {
		if s.Value > maxV {
			maxV = s.Value
		}
		if lw := lipgloss.Width(s.Label); lw > labelW {
			labelW = lw
		}
	}
	if labelW > 20 {
		labelW = 20
	}
	barMax := max(8, w-labelW-8)
	var b strings.Builder
	for i, s := range bd {
		if i >= 6 {
			b.WriteString(hintStyle.Render(fmt.Sprintf("  +%d more", len(bd)-6)))
			break
		}
		frac := 0.0
		if maxV > 0 {
			frac = float64(s.Value) / float64(maxV)
		}
		fill := int(float64(barMax)*frac + 0.5)
		bar := lipgloss.NewStyle().Foreground(semanticColor(s.Semantic)).Render(strings.Repeat("▰", fill)) +
			lipgloss.NewStyle().Foreground(colRule).Render(strings.Repeat("▱", barMax-fill))
		b.WriteString(labelStyle.Render(padRight(truncate(s.Label, labelW), labelW)) + "  " + bar + "  " +
			lipgloss.NewStyle().Foreground(colFg).Render(trimNum(s.Value)) + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

// renderTrend draws a trend as a sparkline over the series (0..1 ratios on a fixed scale so an
// all-high run reads as full bars, not a flat line) plus a "now / target" reading.
func renderTrend(ins contract.ReportInsight, w int) string {
	var b strings.Builder
	if ins.Series != nil && len(*ins.Series) > 0 {
		var spark string
		if unitStr(ins.Unit) == "ratio" {
			spark = sparklineRange(toF64(*ins.Series), 0, 1)
		} else {
			spark = sparkline(toF64(*ins.Series))
		}
		b.WriteString(lipgloss.NewStyle().Foreground(insightColor(ins)).Render(spark) + "\n")
	}
	line := renderSegs("", sg("now ", colDim), sgb(fmtValue(ins.Value, ins.Unit), colFg))
	if ins.Delta != nil && *ins.Delta != 0 {
		line += "  " + lipgloss.NewStyle().Foreground(insightColor(ins)).Render(dirArrow(string(ins.Direction))+" "+trimNum(abs32(*ins.Delta)))
	}
	if ins.Target != nil {
		line += hintStyle.Render("   target " + fmtValue(ins.Target, ins.Unit))
	}
	b.WriteString(line)
	return b.String()
}

// ── compact renderer (one line, for the run-summary top-K) ──────────────────────

// renderInsightCompact renders one insight on a single line: an eyebrow title on the left, a small
// intent-appropriate metric on the right. Used inside the post-run summary where space is tight.
func renderInsightCompact(ins contract.ReportInsight, w int) string {
	return spread(w, eyebrowStyle.Render(strings.ToUpper(ins.Title)), compactMetric(ins))
}

func compactMetric(ins contract.ReportInsight) string {
	col := insightColor(ins)
	switch string(ins.Intent) {
	case "trend":
		spark := ""
		if ins.Series != nil && len(*ins.Series) > 0 {
			if unitStr(ins.Unit) == "ratio" {
				spark = sparklineRange(toF64(*ins.Series), 0, 1)
			} else {
				spark = sparkline(toF64(*ins.Series))
			}
			spark = lipgloss.NewStyle().Foreground(colFaint).Render(spark) + " "
		}
		return spark + lipgloss.NewStyle().Bold(true).Foreground(col).Render(fmtValue(ins.Value, ins.Unit))
	case "composition":
		if ins.Breakdown == nil || len(*ins.Breakdown) == 0 {
			return hintStyle.Render("—")
		}
		parts := make([]string, 0, len(*ins.Breakdown))
		for _, s := range *ins.Breakdown {
			parts = append(parts, lipgloss.NewStyle().Foreground(semanticColor(s.Semantic)).Render(trimNum(s.Value)+" "+s.Label))
		}
		return strings.Join(parts, hintStyle.Render(" · "))
	case "distribution":
		if ins.Breakdown != nil && len(*ins.Breakdown) > 0 {
			top := (*ins.Breakdown)[0]
			return renderSegs("", sg(top.Label+" ", colDim)) + lipgloss.NewStyle().Bold(true).Foreground(semanticColor(top.Semantic)).Render(trimNum(top.Value))
		}
		return lipgloss.NewStyle().Bold(true).Foreground(col).Render(fmtValue(ins.Value, ins.Unit))
	default: // single-value, comparison
		v := lipgloss.NewStyle().Bold(true).Foreground(col).Render(fmtValue(ins.Value, ins.Unit))
		if ins.Delta != nil && *ins.Delta != 0 {
			v += " " + lipgloss.NewStyle().Foreground(col).Render(dirArrow(string(ins.Direction)))
		}
		return v
	}
}

// ── report-level renderers ──────────────────────────────────────────────────────

// renderReportSummary is the compact report block embedded in the post-run summary: the headline
// plus the top-K insights (already interestingness-ranked by the backend), and an "r open" hint.
func renderReportSummary(view contract.ReportView, w, maxK int) string {
	var b strings.Builder
	b.WriteString(labelRule(w, "report", hintStyle.Render("r open full report")) + "\n")
	b.WriteString(lipgloss.NewStyle().Bold(true).Foreground(colFg).Render(truncate(view.Headline, w)) + "\n")
	shown := 0
	for _, ins := range view.Insights {
		if shown >= maxK {
			break
		}
		b.WriteString(renderInsightCompact(ins, w) + "\n")
		// A one-line caption under each headline metric — the "why it matters" the bare value lacked
		// (e.g. "78% of changed lines exercised (target 70%)"), so the recap reads as a real summary.
		if ins.Caption != nil && *ins.Caption != "" {
			b.WriteString("   " + hintStyle.Render(truncate(*ins.Caption, w-3)) + "\n")
		}
		shown++
	}
	if more := len(view.Insights) - shown; more > 0 {
		b.WriteString(hintStyle.Render("   +"+strconv.Itoa(more)+" more insights · press r") + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

// renderReportDetail renders every insight in full — the body of the dedicated report screen.
func renderReportDetail(view contract.ReportView, w int) string {
	if len(view.Insights) == 0 {
		return hintStyle.Render("no insights for this report")
	}
	var b strings.Builder
	b.WriteString(lipgloss.NewStyle().Bold(true).Foreground(colFg).Render(view.Headline) + "\n\n")
	for i, ins := range view.Insights {
		b.WriteString(renderInsightFull(ins, w))
		if i < len(view.Insights)-1 {
			b.WriteString("\n\n")
		}
	}
	return b.String()
}
