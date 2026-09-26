package modelproxy

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/modelprice"
)

func responsesBody(model string, promptBytes int) string {
	return fmt.Sprintf(`{"model":%q,"max_output_tokens":1000,"input":%q}`, model, strings.Repeat("a", promptBytes))
}

// The reservation follows the prompt bound: a request whose bound reaches
// the threshold is reserved at the long-context rates, one below it at the
// standard rates.
func TestBoundSelectsTheLongContextRatesFromThePromptBound(t *testing.T) {
	_, price, ok := Price(ProviderOpenAI, "gpt-6-sol")
	require.True(t, ok)
	for _, tc := range []struct {
		name  string
		delta int64
		long  bool
	}{{"below", -1, false}, {"at", 0, true}, {"above", 1, true}} {
		t.Run(tc.name, func(t *testing.T) {
			// Solve for a body whose bound is exactly threshold+delta.
			probe, err := parseRequest(ProviderOpenAI, "v1/responses", http.Header{}, []byte(responsesBody("gpt-6-sol", 0)))
			require.NoError(t, err)
			overhead := probe.maximum(price).PromptTokens()
			size := modelprice.OpenAILongContextFrom + tc.delta - overhead
			parsed, err := parseRequest(ProviderOpenAI, "v1/responses", http.Header{}, []byte(responsesBody("gpt-6-sol", int(size))))
			require.NoError(t, err)
			maximum := parsed.maximum(price)
			require.Equal(t, modelprice.OpenAILongContextFrom+tc.delta, maximum.PromptTokens())
			rates := price.Rates
			if tc.long {
				rates = price.LongContext
			}
			// All of the prompt is reserved in the dearest class: cache writes.
			require.Equal(t, maximum.PromptTokens(), maximum.CacheWriteTokens)
			bound, err := Bound(price, maximum)
			require.NoError(t, err)
			want := (maximum.CacheWriteTokens*rates.CacheWritePerMTok + 1000*rates.OutputPerMTok) / 1000
			require.Equal(t, want, bound)
		})
	}
}

// Responses report cache writes inside input_tokens (GPT-5.6 and later).
func TestResponsesUsageSeparatesCacheWrites(t *testing.T) {
	usage, ok := usageFromJSON([]byte(`{"type":"response.completed","response":{"usage":{"input_tokens":300000,"output_tokens":50,
		"input_tokens_details":{"cached_tokens":200000,"cache_write_tokens":40000}}}}`))
	require.True(t, ok)
	require.Equal(t, modelprice.Usage{InputTokens: 60_000, CacheReadTokens: 200_000, CacheWriteTokens: 40_000, OutputTokens: 50}, usage)
	require.Equal(t, int64(300_000), usage.PromptTokens())
}

// A model with no declared context pricing is not offered.
func TestModelWithUnknownContextPricingIsNotOffered(t *testing.T) {
	modelprice.Table["gpt-test-untiered"] = modelprice.Price{Provider: ProviderOpenAI, Rates: modelprice.Rates{InputPerMTok: 1, OutputPerMTok: 1}}
	defer delete(modelprice.Table, "gpt-test-untiered")
	_, _, ok := Price(ProviderOpenAI, "gpt-test-untiered")
	require.False(t, ok)
}
