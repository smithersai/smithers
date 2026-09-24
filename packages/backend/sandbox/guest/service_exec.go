package guest

import (
	"strconv"
	"strings"
)

// systemdExecLine preserves each argv element through unit-file parsing,
// specifier expansion and environment substitution. It never invokes a shell.
// A multiline shell script remains one argument to an explicit /bin/sh -c.
func systemdExecLine(argv []string) string {
	words := make([]string, len(argv))
	for i, arg := range argv {
		arg = strings.ReplaceAll(arg, "%", "%%")
		arg = strings.ReplaceAll(arg, "$", "$$")
		words[i] = strconv.Quote(arg)
	}
	return strings.Join(words, " ")
}
