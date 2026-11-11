---
"@smthrs/targets": patch
---

`S.Remote.Http({ url, token, machines, limits?, workdir, setup?, cli? })` declares machines an HTTP service starts on
demand, such as a Worker holding Cloudflare containers, for `smthrs ci --remote <name>`. The token is an `S.Secret`;
`url` must be `https:`, or `http:` to a loopback address.
