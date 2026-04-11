export type StableJson =
  | null
  | boolean
  | number
  | string
  | StableJson[]
  | { [key: string]: StableJson };
