export type TaggedErrorDetails = Record<string, unknown>;

export type GenericTaggedErrorArgs = {
  readonly message: string;
  readonly details?: TaggedErrorDetails;
};
