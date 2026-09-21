package repohostffi

import (
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseFFIError_Matrix(t *testing.T) {
	t.Parallel()

	caseCount := 0
	codes := []string{"invalid_argument", "bad_request", "not_found", "conflict", "internal", "permission_denied"}
	messages := []string{"boom", "", " spaced ", "symbols: []{}"}
	padding := []string{"", " ", "\n\t"}

	for _, code := range codes {
		for _, message := range messages {
			for _, pad := range padding {
				caseCount++

				payload := []byte(fmt.Sprintf(`%s{"code":%q,"error":%q}%s`, pad, code, message, pad))
				got, ok, err := parseFFIError(payload)
				require.NoError(t, err)
				require.Truef(t, ok, "code=%q message=%q", code, message)
				require.NotNil(t, got)
				assert.Equal(t, code, got.Code)
				assert.Equal(t, message, got.Message)
			}
		}
	}

	nonObjectPayloads := [][]byte{
		nil,
		[]byte(""),
		[]byte(" \n "),
		[]byte("[]"),
		[]byte(`"boom"`),
		[]byte("123"),
		[]byte("true"),
	}

	for _, payload := range nonObjectPayloads {
		caseCount++
		got, ok, err := parseFFIError(payload)
		require.NoError(t, err)
		assert.False(t, ok)
		assert.Nil(t, got)
	}

	noCodePayloads := [][]byte{
		[]byte(`{}`),
		[]byte(`{"error":"boom"}`),
		[]byte(`{"code":"","error":"boom"}`),
	}

	for _, payload := range noCodePayloads {
		caseCount++
		got, ok, err := parseFFIError(payload)
		require.NoError(t, err)
		assert.False(t, ok)
		assert.Nil(t, got)
	}

	malformedPayloads := [][]byte{
		[]byte(`{`),
		[]byte(`{"code":`),
		[]byte(`{"code":1}`),
		[]byte(`{"code":"bad","error":1}`),
	}

	for _, payload := range malformedPayloads {
		caseCount++
		got, ok, err := parseFFIError(payload)
		require.Error(t, err)
		assert.False(t, ok)
		assert.Nil(t, got)
	}

	assert.Equal(t, 86, caseCount)
}

func TestErrorStatusCode_Matrix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		code string
		want int
	}{
		{code: "invalid_argument", want: 400},
		{code: "bad_request", want: 400},
		{code: "not_found", want: 404},
		{code: "conflict", want: 409},
		{code: "unprocessable_entity", want: 422},
		{code: "permission_denied", want: 500},
		{code: "", want: 500},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.code, func(t *testing.T) {
			assert.Equal(t, tc.want, (&Error{Code: tc.code}).StatusCode())
		})
	}
}

func TestErrorString_Matrix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		in   Error
		want string
	}{
		{name: "message_wins", in: Error{Code: "not_found", Message: "missing"}, want: "missing"},
		{name: "code_fallback", in: Error{Code: "not_found"}, want: "not_found"},
		{name: "default", in: Error{}, want: "smithers ffi error"},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, tc.in.Error())
		})
	}
}
