import type { APIRequestContext, APIResponse, Page } from "@playwright/test"
import { LOCAL_SESSION_HEADER, LOCAL_SESSION_META } from "@smthrs/rpc/LocalSession"

const localSessionHeaders = async (page: Page): Promise<Record<string, string>> => {
  const token = await page.locator(`meta[name="${LOCAL_SESSION_META}"]`).getAttribute("content")
  if (token === null) throw new Error("The local SPA did not receive a local-session capability.")
  return { [LOCAL_SESSION_HEADER]: token }
}

export const localApiGet = async (
  page: Page,
  request: APIRequestContext,
  path: string
): Promise<APIResponse> => request.get(path, { headers: await localSessionHeaders(page) })

export const localApiPost = async (
  page: Page,
  request: APIRequestContext,
  path: string,
  data: unknown
): Promise<APIResponse> => request.post(path, { headers: await localSessionHeaders(page), data })

export const localApiDelete = async (
  page: Page,
  request: APIRequestContext,
  path: string
): Promise<APIResponse> => request.delete(path, { headers: await localSessionHeaders(page) })
