// Package modelprice is the single checked-in price table for every model
// Smithers runs on platform keys. Every metered model call computes its cost
// here; nothing else in the tree holds a price.
//
// Prices are list prices per million tokens in micro-dollars (1 USD =
// 1_000_000). A model missing from the table is refused by the metering
// point, never estimated: an unpriced model is an unmetered bill.
package modelprice

import (
	"errors"
	"math/big"
	"strings"
)

// Price is one model's rate card. Zero fields mean "not charged".
type Price struct {
	// Provider is the upstream the model is served by (anthropic, openai,
	// cerebras, openrouter, vercel).
	Provider string
	// InputPerMTok / OutputPerMTok are micro-dollars per million tokens.
	InputPerMTok  int64
	OutputPerMTok int64
	// CacheReadPerMTok / CacheWritePerMTok apply to prompt-cache tokens the
	// provider reports separately from InputPerMTok.
	CacheReadPerMTok  int64
	CacheWritePerMTok int64
	// FlatPerCall is charged once per call for endpoints that report no
	// token usage (the Jev evaluation model).
	FlatPerCall int64
}

// Usage is what a provider reported for one call.
type Usage struct {
	InputTokens      int64
	OutputTokens     int64
	CacheReadTokens  int64
	CacheWriteTokens int64
}

// usd converts a dollar amount to micro-dollars: usd(2.5) == 2_500_000.
func usd(dollars float64) int64 { return int64(dollars*1_000_000 + 0.5) }

// Table is keyed by the model id the caller sends on the wire. Anthropic ids
// are the first-party API rates (cache read 0.1x input, cache write 1.25x
// input). Non-Anthropic rows marked VERIFY were entered from vendor pages on
// 2026-09-23 and must be re-checked against the invoice before a price cut.
var Table = map[string]Price{
	// Anthropic (docs.anthropic.com pricing, 2026-06).
	"claude-sonnet-5":   anthropic(2, 10),
	"claude-sonnet-4-6": anthropic(3, 15),
	"claude-sonnet-4-5": anthropic(3, 15),
	"claude-opus-5":     anthropic(5, 25),
	"claude-opus-4-8":   anthropic(5, 25),
	"claude-opus-4-7":   anthropic(5, 25),
	"claude-opus-4-6":   anthropic(5, 25),
	"claude-haiku-4-5":  anthropic(1, 5),
	"claude-fable-5-1":  anthropic(10, 50),
	"claude-fable-5":    anthropic(10, 50),

	// OpenAI (VERIFY).
	"gpt-4o":                  openai(2.5, 10, 1.25),
	"gpt-5.5":                 openai(5, 25, 0.5),
	"gpt-5.6-luna":            openai(5, 25, 0.5),
	"gpt-5.6-sol":             openai(5, 25, 0.5),
	"gpt-6-astra":             openai(10, 50, 1),
	"gpt-6-sol":               openai(10, 50, 1),
	"gpt-6-luna":              openai(10, 50, 1),
	"gpt-oss-120b":            {Provider: "cerebras", InputPerMTok: usd(0.35), OutputPerMTok: usd(0.75)},   // VERIFY
	"qwen-3.8-27b":            {Provider: "cerebras", InputPerMTok: usd(0.60), OutputPerMTok: usd(1.20)},   // VERIFY
	"qwen-3-235b":             {Provider: "cerebras", InputPerMTok: usd(0.60), OutputPerMTok: usd(1.20)},   // VERIFY
	"qwen-3-coder-480b":       {Provider: "cerebras", InputPerMTok: usd(2.00), OutputPerMTok: usd(2.00)},   // VERIFY
	"llama-4-scout":           {Provider: "cerebras", InputPerMTok: usd(0.65), OutputPerMTok: usd(0.85)},   // VERIFY
	"gpt-oss-120b@openrouter": {Provider: "openrouter", InputPerMTok: usd(0.35), OutputPerMTok: usd(0.75)}, // VERIFY

	// Google Generative Language (VERIFY).
	"gemini-2.0-flash-001": {Provider: "google", InputPerMTok: usd(0.10), OutputPerMTok: usd(0.40)},

	// Vercel AI Gateway evaluation model: no token usage on the wire, flat
	// per call (VERIFY against the gateway invoice).
	"typesafe-ai/jev": {Provider: "vercel", FlatPerCall: usd(0.002)},
}

func anthropic(in, out float64) Price {
	return Price{
		Provider:          "anthropic",
		InputPerMTok:      usd(in),
		OutputPerMTok:     usd(out),
		CacheReadPerMTok:  usd(in * 0.1),
		CacheWritePerMTok: usd(in * 1.25),
	}
}

func openai(in, out, cached float64) Price {
	return Price{Provider: "openai", InputPerMTok: usd(in), OutputPerMTok: usd(out), CacheReadPerMTok: usd(cached)}
}

// Lookup returns the price for a model id. Provider-prefixed ids such as
// "anthropic/claude-sonnet-5" (OpenRouter and the Vercel gateway) resolve to
// the bare id.
func Lookup(model string) (Price, bool) {
	model = strings.TrimSpace(model)
	if price, ok := Table[model]; ok {
		return price, true
	}
	if i := strings.LastIndex(model, "/"); i >= 0 {
		if price, ok := Table[model[i+1:]]; ok {
			return price, true
		}
	}
	return Price{}, false
}

// CostNanos computes a provider charge in integer USD nanos. The sum is
// rounded upward once, preserving sub-cent value without floats.
func CostNanos(price Price, usage Usage) (int64, error) {
	if usage.InputTokens < 0 || usage.OutputTokens < 0 || usage.CacheReadTokens < 0 || usage.CacheWriteTokens < 0 {
		return 0, errors.New("negative model usage")
	}
	if price.FlatPerCall < 0 {
		return 0, errors.New("negative model price")
	}
	numerator := new(big.Int)
	for _, part := range [][2]int64{{usage.InputTokens, price.InputPerMTok}, {usage.OutputTokens, price.OutputPerMTok}, {usage.CacheReadTokens, price.CacheReadPerMTok}, {usage.CacheWriteTokens, price.CacheWritePerMTok}} {
		if part[1] < 0 {
			return 0, errors.New("negative model price")
		}
		numerator.Add(numerator, new(big.Int).Mul(big.NewInt(part[0]), big.NewInt(part[1])))
	}
	numerator.Mul(numerator, big.NewInt(1000))
	quotient, remainder := new(big.Int), new(big.Int)
	quotient.QuoRem(numerator, big.NewInt(1_000_000), remainder)
	if remainder.Sign() > 0 {
		quotient.Add(quotient, big.NewInt(1))
	}
	quotient.Add(quotient, new(big.Int).Mul(big.NewInt(price.FlatPerCall), big.NewInt(1000)))
	if !quotient.IsInt64() {
		return 0, errors.New("model cost overflow")
	}
	return quotient.Int64(), nil
}
