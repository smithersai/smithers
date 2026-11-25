import Lake
open Lake DSL

package «smithers-state» where

@[default_target]
lean_lib SmithersState where

@[default_target]
lean_exe oracle where
  root := `Main
