/**
 * Compile-time guard for smithers/jsx-runtime types.
 *
 * Ensures `key` is accepted through JSX IntrinsicAttributes and intrinsic
 * elements are available when using `jsxImportSource: "smithers"`.
 */
import { Sequence } from "../src/components";

const items = [1, 2, 3];

export const sequenceList = (
  <>
    {items.map((n) => (
      <Sequence key={`s${n}`} skipIf={false}>
        <div>{n}</div>
      </Sequence>
    ))}
  </>
);
