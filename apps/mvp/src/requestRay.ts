/** The incoming Cloudflare ray returned on API errors, using the app's x-smithers-* header convention. */
export const RAY_HEADER = "x-smithers-ray"

/** Cloudflare's opaque request identifier only; never echo arbitrary header content. */
export const rayOf = (value: string | undefined): string | undefined =>
  value !== undefined && /^[a-f0-9]{16,32}(?:-[A-Za-z0-9]{3,10})?$/.test(value) ? value : undefined
