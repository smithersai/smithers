import Foundation

enum SkillInstallSource: Hashable, Sendable {
    case registry(entry: SkillRegistryEntry)
    case git(url: String, skillName: String?)
    case local(path: String, skillName: String?)
}

enum SkillInstallError: Error, LocalizedError {
    case invalidSource
    case skillNotFound
    case invalidSkillFrontmatter
    case nameMismatch(expected: String, actual: String)
    case installCancelled
    case gitFailed(String)

    var errorDescription: String? {
        switch self {
        case .invalidSource:
            return "Invalid skill source"
        case .skillNotFound:
            return "Skill directory not found"
        case .invalidSkillFrontmatter:
            return "Skill frontmatter is missing required fields"
        case .nameMismatch(let expected, let actual):
            return "Skill name \(actual) does not match directory \(expected)"
        case .installCancelled:
            return "Skill installation cancelled"
        case .gitFailed(let message):
            return "Git failed: \(message)"
        }
    }
}

struct SkillInstallResult: Sendable {
    let skill: SkillItem
    let scripts: [URL]
}

final class SkillInstaller {
    func install(
        source: SkillInstallSource,
        scope: SkillScope,
        rootDirectory: URL?,
        confirmScripts: (([URL]) -> Bool)? = nil
    ) throws -> SkillInstallResult {
        let fileManager = FileManager.default
        let tempRoot = fileManager.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        var tempDirectory: URL?
        defer {
            if let tempDirectory {
                try? fileManager.removeItem(at: tempDirectory)
            }
        }

        let resolved: URL
        let sourceLabel: String?
        switch source {
        case .registry(let entry):
            tempDirectory = tempRoot
            try cloneRepo(source: entry.source, into: tempRoot)
            guard let skillDir = resolveSkillDirectory(root: tempRoot, skillName: entry.skillId) else {
                throw SkillInstallError.skillNotFound
            }
            resolved = skillDir
            sourceLabel = entry.source
        case .git(let url, let skillName):
            tempDirectory = tempRoot
            try cloneRepo(source: url, into: tempRoot)
            guard let skillDir = resolveSkillDirectory(root: tempRoot, skillName: skillName) else {
                throw SkillInstallError.skillNotFound
            }
            resolved = skillDir
            sourceLabel = url
        case .local(let path, let skillName):
            let url = URL(fileURLWithPath: path)
            guard fileManager.fileExists(atPath: url.path) else {
                throw SkillInstallError.invalidSource
            }
            if url.lastPathComponent.lowercased() == "skill.md" {
                resolved = url.deletingLastPathComponent()
            } else if let skillDir = resolveSkillDirectory(root: url, skillName: skillName) {
                resolved = skillDir
            } else {
                throw SkillInstallError.skillNotFound
            }
            sourceLabel = path
        }

        let skillFile = resolved.appendingPathComponent("SKILL.md")
        guard let contents = try? String(contentsOf: skillFile, encoding: .utf8) else {
            throw SkillInstallError.invalidSkillFrontmatter
        }
        let document = SkillFrontmatterParser.parseDocument(from: contents)
        guard let name = document.frontmatter.name, let description = document.frontmatter.description else {
            throw SkillInstallError.invalidSkillFrontmatter
        }
        let directoryName = resolved.lastPathComponent
        guard name == directoryName else {
            throw SkillInstallError.nameMismatch(expected: directoryName, actual: name)
        }

        let scriptsDirectory = resolved.appendingPathComponent("scripts", isDirectory: true)
        let scripts = collectScripts(in: scriptsDirectory)
        if !scripts.isEmpty, let confirmScripts {
            guard confirmScripts(scripts) else {
                throw SkillInstallError.installCancelled
            }
        }

        guard let destinationBase = skillScopeDirectory(scope: scope, rootDirectory: rootDirectory) else {
            throw SkillInstallError.invalidSource
        }
        try fileManager.createDirectory(at: destinationBase, withIntermediateDirectories: true)
        let destination = destinationBase.appendingPathComponent(name, isDirectory: true)
        if fileManager.fileExists(atPath: destination.path) {
            try fileManager.removeItem(at: destination)
        }
        try fileManager.copyItem(at: resolved, to: destination)
        let destinationScripts = destination.appendingPathComponent("scripts", isDirectory: true)
        let installedScripts = collectScripts(in: destinationScripts)
        for script in installedScripts {
            makeExecutable(script)
        }

        let installRecord = SkillInstallRecord(
            path: destination.standardizedFileURL.path,
            source: sourceLabel,
            installedAt: Date(),
            lastUpdatedAt: nil
        )
        SkillInstallStore.shared.upsert(record: installRecord)

        let item = SkillItem(
            name: name,
            description: description,
            scope: scope,
            path: destination,
            license: document.frontmatter.license,
            metadata: document.frontmatter.metadata,
            allowedTools: document.frontmatter.allowedTools,
            hasScripts: !installedScripts.isEmpty,
            argumentHint: document.frontmatter.argumentHint,
            source: installRecord.source,
            installedAt: installRecord.installedAt,
            enabled: true
        )

        return SkillInstallResult(skill: item, scripts: installedScripts)
    }

    private func resolveSkillDirectory(root: URL, skillName: String?) -> URL? {
        let fm = FileManager.default
        if let skillName, !skillName.isEmpty {
            let direct = root.appendingPathComponent(skillName, isDirectory: true)
            if fm.fileExists(atPath: direct.appendingPathComponent("SKILL.md").path) {
                return direct
            }
            let inSkills = root.appendingPathComponent("skills", isDirectory: true).appendingPathComponent(skillName, isDirectory: true)
            if fm.fileExists(atPath: inSkills.appendingPathComponent("SKILL.md").path) {
                return inSkills
            }
        }

        if fm.fileExists(atPath: root.appendingPathComponent("SKILL.md").path) {
            return root
        }

        if let found = singleSkillDirectory(in: root.appendingPathComponent("skills", isDirectory: true)) {
            return found
        }

        if let found = singleSkillDirectory(in: root) {
            return found
        }

        return nil
    }

    private func singleSkillDirectory(in root: URL) -> URL? {
        let fm = FileManager.default
        guard let children = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey]) else {
            return nil
        }
        let candidates = children.filter { url in
            let values = try? url.resourceValues(forKeys: [.isDirectoryKey])
            guard values?.isDirectory == true else { return false }
            let skillFile = url.appendingPathComponent("SKILL.md")
            return fm.fileExists(atPath: skillFile.path)
        }
        return candidates.count == 1 ? candidates[0] : nil
    }

    private func collectScripts(in directory: URL) -> [URL] {
        let fm = FileManager.default
        guard fm.fileExists(atPath: directory.path) else { return [] }
        guard let children = try? fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isDirectoryKey]) else {
            return []
        }
        return children.filter { url in
            let values = try? url.resourceValues(forKeys: [.isDirectoryKey])
            return values?.isDirectory == false
        }
    }

    private func makeExecutable(_ url: URL) {
        let fm = FileManager.default
        guard let attributes = try? fm.attributesOfItem(atPath: url.path) else { return }
        if var permissions = attributes[.posixPermissions] as? NSNumber {
            let current = permissions.intValue
            let updated = current | 0o111
            permissions = NSNumber(value: updated)
            try? fm.setAttributes([.posixPermissions: permissions], ofItemAtPath: url.path)
        }
    }

    private func skillScopeDirectory(scope: SkillScope, rootDirectory: URL?) -> URL? {
        let fm = FileManager.default
        switch scope {
        case .project:
            guard let rootDirectory else { return nil }
            return rootDirectory.appendingPathComponent(".agents/skills", isDirectory: true)
        case .user:
            return fm.homeDirectoryForCurrentUser.appendingPathComponent(".agents/skills", isDirectory: true)
        case .admin:
            return URL(fileURLWithPath: "/etc/codex/skills", isDirectory: true)
        case .system:
            return nil
        }
    }

    private func cloneRepo(source: String, into destination: URL) throws {
        let repoURL = normalizeGitURL(source)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["git", "clone", "--depth", "1", repoURL, destination.path]
        let pipe = Pipe()
        process.standardError = pipe
        process.standardOutput = pipe
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        if process.terminationStatus != 0 {
            let message = String(data: data, encoding: .utf8) ?? "Unknown error"
            throw SkillInstallError.gitFailed(message)
        }
    }

    private func normalizeGitURL(_ source: String) -> String {
        if source.hasPrefix("http") || source.hasPrefix("git@") {
            return source
        }
        if source.contains("/") {
            let normalized = source.hasSuffix(".git") ? source : "\(source).git"
            return "https://github.com/\(normalized)"
        }
        return source
    }
}
