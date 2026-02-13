import type * as React from "react";

export { jsx, jsxs, Fragment } from "react/jsx-runtime";
export { jsxDEV } from "react/jsx-dev-runtime";

// Re-export React's JSX namespace so `jsxImportSource: "smithers"` keeps
// intrinsic attributes (`key`, `ref`) and intrinsic elements (e.g. `div`).
export namespace JSX {
  export type ElementType = React.JSX.ElementType;
  export interface Element extends React.JSX.Element {}
  export interface ElementClass extends React.JSX.ElementClass {}
  export interface ElementAttributesProperty
    extends React.JSX.ElementAttributesProperty {}
  export interface ElementChildrenAttribute
    extends React.JSX.ElementChildrenAttribute {}
  export type LibraryManagedAttributes<C, P> = React.JSX.LibraryManagedAttributes<
    C,
    P
  >;
  export interface IntrinsicAttributes extends React.JSX.IntrinsicAttributes {}
  export interface IntrinsicClassAttributes<T>
    extends React.JSX.IntrinsicClassAttributes<T> {}
  export interface IntrinsicElements extends React.JSX.IntrinsicElements {}
}
