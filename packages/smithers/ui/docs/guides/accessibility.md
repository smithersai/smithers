
## Page navigation

Render `PageFocus pathname={pathname}` beside your router outlet after its screen
commits. Initial load and search-only changes preserve focus. A different path
focuses the first main heading, or main when there is no heading. A form marked
`data-page-focus` focuses its first input or textarea instead. The main receives
`id="main-content"` and `tabIndex={-1}` for a host's skip link.
