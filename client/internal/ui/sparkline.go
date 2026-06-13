package ui

import "strings"

// sparkRamp is the eight-step block ramp for inline trend glyphs — the same block
// family as the progress bar, so a sparkline reads as part of the same visual language
// rather than a bolted-on chart.
var sparkRamp = []rune("▁▂▃▄▅▆▇█")

// sparkline renders values (oldest→newest) as a compact block-ramp trend, normalized to
// the series' own min/max so it shows shape rather than absolute scale. Use this for
// open-ended series (durations, counts). An empty series renders empty.
func sparkline(values []float64) string {
	if len(values) == 0 {
		return ""
	}
	lo, hi := values[0], values[0]
	for _, v := range values {
		if v < lo {
			lo = v
		}
		if v > hi {
			hi = v
		}
	}
	return sparklineRange(values, lo, hi)
}

// sparklineRange renders values against a FIXED [lo,hi] scale. Use this when the scale is
// semantic — e.g. a 0..1 quality score — so an all-high series reads as full bars and an
// all-low series as low bars, instead of both collapsing to a flat line.
func sparklineRange(values []float64, lo, hi float64) string {
	if len(values) == 0 {
		return ""
	}
	span := hi - lo
	var b strings.Builder
	for _, v := range values {
		idx := len(sparkRamp) / 2 // a flat series (span 0) reads as mid-ramp, not "low"
		if span > 0 {
			idx = int((v-lo)/span*float64(len(sparkRamp)-1) + 0.5)
		}
		if idx < 0 {
			idx = 0
		} else if idx >= len(sparkRamp) {
			idx = len(sparkRamp) - 1
		}
		b.WriteRune(sparkRamp[idx])
	}
	return b.String()
}
