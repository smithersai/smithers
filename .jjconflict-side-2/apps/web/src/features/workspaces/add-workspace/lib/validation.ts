export function slugifyWorkspaceName(name: string) {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

  return slug || "workspace"
}

export function isAbsolutePath(pathValue: string) {
  return (
    pathValue.startsWith("/") ||
    pathValue.startsWith("\\\\") ||
    /^[a-zA-Z]:[\\/]/.test(pathValue)
  )
}

export function validateWorkspaceName(name: string) {
  return name.trim() ? null : "Workspace title is required."
}

export function validateLocalPath(pathValue: string) {
  const trimmedPath = pathValue.trim()
  if (!trimmedPath) {
    return "Repository path is required."
  }

  if (!isAbsolutePath(trimmedPath)) {
    return "Repository path must be an absolute path."
  }

  return null
}

export function validateRepositoryUrl(repoUrl: string) {
  const trimmedRepoUrl = repoUrl.trim()
  if (!trimmedRepoUrl) {
    return "Repository URL is required."
  }

  const sshUrlPattern = /^[\w.-]+@[\w.-]+:[\w./-]+(?:\.git)?$/u
  if (sshUrlPattern.test(trimmedRepoUrl)) {
    return null
  }

  try {
    const parsedUrl = new URL(trimmedRepoUrl)
    if (["http:", "https:", "ssh:", "git:"].includes(parsedUrl.protocol)) {
      return null
    }
  } catch {
    // Invalid URL handled below.
  }

  return "Enter a valid git URL (HTTPS, SSH, or git protocol)."
}

export function validateTargetFolder(targetFolder: string) {
  const trimmedTargetFolder = targetFolder.trim()
  if (!trimmedTargetFolder) {
    return "Target folder is required."
  }

  if (isAbsolutePath(trimmedTargetFolder)) {
    return "Target folder must be relative to workspace root."
  }

  if (trimmedTargetFolder.split(/[\\/]+/u).some((segment) => segment === "..")) {
    return "Target folder cannot contain '..' segments."
  }

  return null
}

export function validateSmithersUrl(baseUrl: string) {
  const trimmed = baseUrl.trim()
  if (!trimmed) {
    return "Smithers URL is required."
  }

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "Smithers URL must use http or https."
    }
  } catch {
    return "Smithers URL must be a valid absolute URL."
  }

  return null
}
