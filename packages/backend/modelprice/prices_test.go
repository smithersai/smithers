package modelprice

import "testing"

func TestCostNanosPreservesSubCentAndRejectsOverflow(t *testing.T) {
	price, ok := Lookup("gpt-oss-120b")
	if !ok {
		t.Fatal("missing model")
	}
	nanos, err := CostNanos(price, Usage{InputTokens: 1})
	if err != nil || nanos != 350 {
		t.Fatalf("one token=%d nanos err=%v", nanos, err)
	}
	nanos, err = CostNanos(price, Usage{InputTokens: 10_000, OutputTokens: 1_000})
	if err != nil || nanos != 4_250_000 {
		t.Fatalf("usage=%d nanos err=%v", nanos, err)
	}
	if _, err = CostNanos(price, Usage{InputTokens: -1}); err == nil {
		t.Fatal("negative usage accepted")
	}
	if _, err = CostNanos(price, Usage{InputTokens: 1 << 62}); err == nil {
		t.Fatal("overflow accepted")
	}
}

// nanos is tokens at microPerMTok in USD nanos (exact for these rates).
func nanos(tokens, microPerMTok int64) int64 { return tokens * microPerMTok / 1000 }

func TestTableDeclaresContextPricingAndLongRatesNeverUndercut(t *testing.T) {
	for model, price := range Table {
		if _, ok := Lookup(model); !ok {
			t.Errorf("%s: context pricing is not declared", model)
		}
		if price.Context != ContextTiered {
			continue
		}
		base, long := price.Rates, price.LongContext
		if long.InputPerMTok < base.InputPerMTok || long.OutputPerMTok < base.OutputPerMTok ||
			long.CacheReadPerMTok < base.CacheReadPerMTok || long.CacheWritePerMTok < base.CacheWritePerMTok {
			t.Errorf("%s: a long-context rate is below its standard rate", model)
		}
	}
}

func TestUnknownContextPricingIsRefused(t *testing.T) {
	Table["test-untiered"] = Price{Provider: "openai", Rates: Rates{InputPerMTok: 1, OutputPerMTok: 1}}
	Table["test-tiered-without-threshold"] = Price{Provider: "openai", Context: ContextTiered, Rates: Rates{InputPerMTok: 1}}
	defer delete(Table, "test-untiered")
	defer delete(Table, "test-tiered-without-threshold")
	for _, model := range []string{"test-untiered", "openrouter/test-untiered", "test-tiered-without-threshold"} {
		if _, ok := Lookup(model); ok {
			t.Errorf("%s: unknown context pricing was priced", model)
		}
	}
	if _, err := CostNanos(Table["test-untiered"], Usage{InputTokens: 1}); err == nil {
		t.Fatal("unknown context pricing was costed")
	}
}

// OpenAI: prompts over 272K input tokens are priced at 2x input and cache
// rates and 1.5x output for the full request.
func TestOpenAILongContextPremiumAtBelowAndAboveThreshold(t *testing.T) {
	type card struct{ in, cacheRead, cacheWrite, out float64 }
	cards := map[string]card{
		"gpt-6-astra":   {10, 1, 12.5, 50},
		"gpt-6-sol":     {2, 0.2, 2.5, 10},
		"gpt-6-luna":    {0.1, 0.01, 0.125, 0.5},
		"gpt-5.6-sol":   {4, 0.4, 5, 20},
		"gpt-5.6-terra": {2, 0.2, 2.5, 12},
		"gpt-5.6-luna":  {0.2, 0.02, 0.25, 1.2},
		"gpt-5.5":       {5, 0.5, 5, 30},
	}
	for model, c := range cards {
		price, ok := Lookup(model)
		if !ok || price.Context != ContextTiered || price.LongContextFrom != 272_000 {
			t.Fatalf("%s: not tiered at 272,000: %+v", model, price)
		}
		for _, tc := range []struct {
			prompt int64
			long   bool
		}{{271_999, false}, {272_000, true}, {272_001, true}, {1_000_000, true}} {
			// Split the prompt across every class, as providers report it.
			usage := Usage{CacheReadTokens: 100_000, CacheWriteTokens: 50_000, OutputTokens: 10_000}
			usage.InputTokens = tc.prompt - usage.CacheReadTokens - usage.CacheWriteTokens
			in, read, write, out := c.in, c.cacheRead, c.cacheWrite, c.out
			if tc.long {
				in, read, write, out = in*2, read*2, write*2, out*1.5
			}
			want := nanos(usage.InputTokens, usd(in)) + nanos(usage.CacheReadTokens, usd(read)) +
				nanos(usage.CacheWriteTokens, usd(write)) + nanos(usage.OutputTokens, usd(out))
			got, err := CostNanos(price, usage)
			if err != nil || got != want {
				t.Errorf("%s prompt=%d: got %d want %d (err %v)", model, tc.prompt, got, want, err)
			}
			bound, err := CostNanos(price, price.Maximum(tc.prompt, usage.OutputTokens))
			if err != nil || bound < got {
				t.Errorf("%s prompt=%d: bound %d below the charge %d (err %v)", model, tc.prompt, bound, got, err)
			}
			if rates := price.RatesFor(tc.prompt); (rates == price.LongContext) != tc.long {
				t.Errorf("%s prompt=%d: wrong rate card", model, tc.prompt)
			}
		}
	}
}

// Anthropic: Claude 4.6 and later bill the full 1M context at standard
// rates; Haiku 4.5 stops at 200k.
func TestAnthropicContextIsFlatAtEverySize(t *testing.T) {
	for model, price := range Table {
		if price.Provider != "anthropic" || model == "claude-sonnet-4-5" {
			continue
		}
		if price.Context != ContextFlat {
			t.Fatalf("%s: not flat", model)
		}
		for _, prompt := range []int64{199_999, 200_000, 200_001, 272_000, 999_999, 1_000_000} {
			got, err := CostNanos(price, Usage{InputTokens: prompt, OutputTokens: 1000})
			want := nanos(prompt, price.InputPerMTok) + nanos(1000, price.OutputPerMTok)
			if err != nil || got != want {
				t.Errorf("%s prompt=%d: got %d want %d", model, prompt, got, want)
			}
		}
	}
}

func TestPublishedRateCards(t *testing.T) {
	for model, want := range map[string]Rates{
		"claude-fable-5-1": {usd(10), usd(50), usd(0.25), usd(12.5)},
		"claude-opus-5-5":  {usd(4), usd(20), usd(0.2), usd(5)},
		"claude-sonnet-5":  {usd(2), usd(10), usd(0.2), usd(2.5)},
		"qwen-3.8-27b":     {usd(0.99), usd(1.49), usd(0.99), usd(0.99)},
		"gpt-4o":           {usd(2.5), usd(10), usd(1.25), usd(2.5)},
	} {
		if price, ok := Lookup(model); !ok || price.Rates != want {
			t.Errorf("%s: %+v, want %+v", model, price.Rates, want)
		}
	}
}

func TestMaximumCoversEverySplitAcrossTheThreshold(t *testing.T) {
	price, _ := Lookup("gpt-6-astra")
	for _, bound := range []int64{100_000, 271_999, 272_000, 500_000} {
		limit, err := CostNanos(price, price.Maximum(bound, 5000))
		if err != nil {
			t.Fatal(err)
		}
		for prompt := int64(0); prompt <= bound; prompt += bound / 7 {
			for _, u := range []Usage{
				{InputTokens: prompt, OutputTokens: 5000},
				{CacheReadTokens: prompt, OutputTokens: 5000},
				{CacheWriteTokens: prompt, OutputTokens: 5000},
				{InputTokens: prompt / 3, CacheReadTokens: prompt / 3, CacheWriteTokens: prompt - 2*(prompt/3), OutputTokens: 5000},
			} {
				if got, _ := CostNanos(price, u); got > limit {
					t.Fatalf("bound=%d usage=%+v costs %d above the reservation %d", bound, u, got, limit)
				}
			}
		}
	}
}

// Sonnet 4.5 on OpenRouter has a 1M window charged at $6/$22.50 (cache
// $0.60/$7.50) from 200,000 prompt tokens.
func TestSonnet45LongContextPremiumAtBelowAndAboveThreshold(t *testing.T) {
	price, ok := Lookup("anthropic/claude-sonnet-4-5")
	if !ok || price.LongContext != (Rates{usd(6), usd(22.5), usd(0.6), usd(7.5)}) {
		t.Fatalf("sonnet 4.5 long rates: %+v", price.LongContext)
	}
	for _, tc := range []struct {
		prompt int64
		in     float64
		out    float64
	}{{199_999, 3, 15}, {200_000, 6, 22.5}, {200_001, 6, 22.5}} {
		got, err := CostNanos(price, Usage{InputTokens: tc.prompt, OutputTokens: 1000})
		want := nanos(tc.prompt, usd(tc.in)) + nanos(1000, usd(tc.out))
		if err != nil || got != want {
			t.Errorf("prompt=%d: got %d want %d", tc.prompt, got, want)
		}
	}
}
