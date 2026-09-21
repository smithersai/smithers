package smitherscli

import (
	"reflect"
	"testing"

	incur "github.com/smithersai/incur"
)

func TestSchema_Cov_BuildersAndValueHelpers(t *testing.T) {
	name := stringSchema("repo name")
	private := booleanSchema("private repo", true)
	size := numberSchema("cache size", 12)
	tags := arraySchema("labels")
	visibility := enumSchema("visibility", []string{"public", "private"}, "public")
	obj := objectSchema([]string{"name"}, map[string]*incur.JSONSchema{
		"name":       name,
		"private":    private,
		"size":       size,
		"tags":       tags,
		"visibility": visibility,
	})

	if obj.Type != "object" || len(obj.Required) != 1 || obj.Required[0] != "name" || obj.Properties["name"] != name {
		t.Fatalf("objectSchema returned unexpected schema: %#v", obj)
	}
	if name.Type != "string" || name.Description != "repo name" {
		t.Fatalf("stringSchema = %#v", name)
	}
	if private.Type != "boolean" || private.Default != true {
		t.Fatalf("booleanSchema = %#v", private)
	}
	if size.Type != "number" || size.Default != 12 {
		t.Fatalf("numberSchema = %#v", size)
	}
	if tags.Type != "array" || tags.Items == nil || tags.Items.Type != "string" || !reflect.DeepEqual(tags.Default, []any{}) {
		t.Fatalf("arraySchema = %#v", tags)
	}
	if visibility.Type != "string" || visibility.Default != "public" || !reflect.DeepEqual(visibility.Enum, []any{"public", "private"}) {
		t.Fatalf("enumSchema = %#v", visibility)
	}

	if got := stringValue(nil); got != "" {
		t.Fatalf("stringValue(nil) = %q", got)
	}
	if got := stringValue(" smithers "); got != " smithers " {
		t.Fatalf("stringValue(string) = %q", got)
	}
	if got := stringValue(42); got != "42" {
		t.Fatalf("stringValue(int) = %q", got)
	}
	if got := stringSliceValue([]string{"a", "b"}); !reflect.DeepEqual(got, []string{"a", "b"}) {
		t.Fatalf("stringSliceValue([]string) = %#v", got)
	}
	if got := stringSliceValue([]any{"a", 2, nil}); !reflect.DeepEqual(got, []string{"a", "2", ""}) {
		t.Fatalf("stringSliceValue([]any) = %#v", got)
	}
	if got := stringSliceValue("not a slice"); got != nil {
		t.Fatalf("stringSliceValue(other) = %#v", got)
	}
	if got := nullableString(""); got != nil {
		t.Fatalf("nullableString(empty) = %#v", got)
	}
	if got := nullableString("value"); got != "value" {
		t.Fatalf("nullableString(value) = %#v", got)
	}
	if got := displayNullable(nil); got != "(not set)" {
		t.Fatalf("displayNullable(nil) = %q", got)
	}
	if got := displayNullable(""); got != "(not set)" {
		t.Fatalf("displayNullable(empty) = %q", got)
	}
	if got := displayNullable(7); got != "7" {
		t.Fatalf("displayNullable(number) = %q", got)
	}
	if got := joinLines([]string{"one", "two"}); got != "one\ntwo" {
		t.Fatalf("joinLines = %q", got)
	}
}
