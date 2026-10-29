/**
 * A presentation bundle built from React alone, for this package's tests.
 *
 * `@smthrs/ui` builds the bundle Smithers ships, with its own components. This
 * one carries three small stand-ins, so the realm is tested without the
 * component library.
 */
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import * as jsxRuntime from "react/jsx-runtime"
import { install } from "../../src/Presentation.ts"

const join = (...names: ReadonlyArray<unknown>) => names.filter((name) => typeof name === "string" && name).join(" ")

const Card = ({ children, className }: { readonly children?: React.ReactNode; readonly className?: string }) =>
  jsxRuntime.jsx("div", { "data-slot": "card", className: join("sui-card", className), children })

/**
 * Radix's `Slot`, as `@smthrs/ui`'s `Button` reaches it under `asChild`: a
 * forwardRef component no view imports, whose `render` React reads on every
 * render, and which a view reaches only by calling `Button` itself.
 */
const Slot = React.forwardRef<unknown, { readonly children?: React.ReactNode }>(({ children, ...rest }, _ref) =>
  React.cloneElement(React.Children.only(children) as React.ReactElement, rest)
)

const Button = (
  { asChild, children, className, ...rest }: {
    readonly asChild?: boolean
    readonly children?: React.ReactNode
    readonly className?: string
  }
) =>
  asChild
    ? jsxRuntime.jsx(Slot, { "data-slot": "button", className: join("sui-button", className), ...rest, children })
    : jsxRuntime.jsx("button", {
      "data-slot": "button",
      type: "button",
      className: join("sui-button", className),
      ...rest,
      children
    })

const Badge = ({ children }: { readonly children?: React.ReactNode }) =>
  jsxRuntime.jsx("span", { "data-slot": "badge", className: "sui-badge", children })

// Fault injection through InstallOptions' renderer dependency, kept inside the
// realm so no host object crosses its boundary. Happy paths use React's renderer.
declare const __RENDERER_FAILURE__: "none" | "value" | "message"
const render = __RENDERER_FAILURE__ === "value"
  ? () => {
    throw "renderer failed"
  }
  : __RENDERER_FAILURE__ === "message"
  ? () => {
    throw new Error("renderer failed")
  }
  : renderToStaticMarkup

install({ react: React, jsxRuntime, renderToStaticMarkup: render, components: { Badge, Button, Card } })
