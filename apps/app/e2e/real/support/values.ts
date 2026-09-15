/** Arbitrary comment text authored by a fixture, never a product identifier. */
export const fixtureCommentBody = (body: string): string => body

/** A fixture-owned GitHub name, within the same namespace its cleanup accepts. */
export const fixtureRepositoryName = (name: string): string => {
  if (!/^smithers-e2e-import-[a-z0-9-]+$/.test(name)) {
    throw new Error("The fixture repository name is outside its owned cleanup namespace.")
  }
  return name
}

/** The label of a test evidence attachment, never a rendered card ID. */
export const fixtureAttachmentName = (name: string): string => name

/** Text a fixture supplies as a workflow input, not a registered flow name. */
export const fixtureInputText = (text: string): string => text

/** An opaque external-protocol identifier supplied by a fixture, not an app card ID. */
export const fixtureProtocolId = (id: string): string => id
