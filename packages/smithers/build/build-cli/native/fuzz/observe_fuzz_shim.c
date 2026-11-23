#define main observe_cli_main_unused
#include "../observe.c"
#undef main

size_t fuzz_observe_escaped(const char *s, size_t n, int angled, char *out, size_t cap) {
  struct text t = {0};
  escaped(&t, s, n, angled);
  if (t.failed || t.data == NULL) {
    free(t.data);
    if (cap > 0) out[0] = 0;
    return 0;
  }
  size_t copy = t.length < (cap > 0 ? cap - 1 : 0) ? t.length : (cap > 0 ? cap - 1 : 0);
  if (copy > 0) memcpy(out, t.data, copy);
  if (cap > 0) out[copy] = 0;
  size_t len = t.length;
  free(t.data);
  return len;
}

void fuzz_observe_key_of(const char *name, char *out, size_t cap) {
  keyOf(name, out, cap);
}

size_t fuzz_observe_part_of(const char *s, size_t *start_offset) {
  const char *at = s;
  size_t len = partOf(&at);
  *start_offset = (size_t)(at - s);
  return len;
}

int fuzz_observe_number_of(const char *part, size_t len, long *val_out) {
  return numberOf(part, len, val_out);
}

int fuzz_observe_pseudo(const char *path) {
  return pseudo(path);
}

uint64_t fuzz_observe_full_hash(const char *name) {
  return fullHash(name);
}

const char *fuzz_observe_errno_name(int err) {
  return errnoName(err);
}
