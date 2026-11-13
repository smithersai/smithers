import { startInline } from "../firstPaint/browser"
import { coldReadsFor, heldFetch, type ColdReadPage } from "./coldReads"

// Vite selects this entry only in development. Production's inline entry uses the real browser fetch directly.
const target = window as unknown as ColdReadPage
const real = window.fetch.bind(window)
startInline(target.coldReadHolds === undefined ? real : heldFetch(real, coldReadsFor(target)))
