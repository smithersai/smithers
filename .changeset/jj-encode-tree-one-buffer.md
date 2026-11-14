---
"@smthrs/jj": patch
---

`Repository.encodeTree` sorts names by comparing the strings in code point order, which is UTF-8 byte order, instead of encoding each name first, and writes the body into one buffer, each header encoded in place and each id written from its hex digits. The memory repository's `writeTree` sorts once rather than twice. A 5,700-entry tree encodes 3.1 times faster (25 ms to 8.0 ms in Node 26); the bytes, and so every `hashTree` id, are unchanged, a lone surrogate included (it sorts as the U+FFFD it is written as).
