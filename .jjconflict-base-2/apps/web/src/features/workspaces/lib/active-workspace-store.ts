import { useSyncExternalStore } from "react"

const STORAGE_KEY = "burns.active-workspace-id"

type Listener = () => void

const listeners = new Set<Listener>()

function readStoredWorkspaceId() {
  if (typeof window === "undefined") {
    return null
  }

  return window.localStorage.getItem(STORAGE_KEY)
}

let currentWorkspaceId: string | null = readStoredWorkspaceId()

function emitChange() {
  for (const listener of listeners) {
    listener()
  }
}

export function getActiveWorkspaceId() {
  return currentWorkspaceId
}

export function setActiveWorkspaceId(workspaceId?: string | null) {
  currentWorkspaceId = workspaceId ?? null

  if (typeof window !== "undefined") {
    if (currentWorkspaceId) {
      window.localStorage.setItem(STORAGE_KEY, currentWorkspaceId)
    } else {
      window.localStorage.removeItem(STORAGE_KEY)
    }
  }

  emitChange()
}

export function useStoredActiveWorkspaceId() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getActiveWorkspaceId,
    () => null
  )
}
