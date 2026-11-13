import { startInline } from "./browser"

startInline(window.fetch.bind(window))
