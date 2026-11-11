---
"@smthrs/ui": patch
---

`WebPageView` asks the Effect service `WebPageLoad` when its frame has loaded. `WebPageLoad.layer`, the default, waits for the frame's `load` event, as before. `WebPageLoadProvider` gives the views inside it another layer, so a test holds the preview until it releases it instead of racing the framed site.
