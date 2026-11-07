# Package output imports

Package assembly removes private VibeLang emitted routes from the CommonJS import map. Ordinary package imports retain their compiled paths and conditions.

Published JavaScript and declarations must import sibling modules through their emitted paths. The build rejects any private emitted route left under `dist`; source maps can retain the source spelling. Rebuild with a compiler that rewrites routed imports to the corresponding output module before packaging.
