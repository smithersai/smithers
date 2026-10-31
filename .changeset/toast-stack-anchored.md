---
"@smthrs/ui": minor
---

`ToastStack` overlays the page in every placement. `placement="anchored"` replaces `inline`: it hangs under its positioned parent, such as a page's header, at the parent's end edge, and takes no layout space, so a toast arriving or leaving never pushes the page down. Every toast now arrives by opacity and transform only, and a `delayed` toast's 300 ms wait holds under reduced motion (`--motion-hold`). `PageHeader` renders its `children` last in its positioned row, so an anchored stack hangs under the bar.
