import Foundation

struct SkillItem: Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let description: String
    let scope: SkillScope
    let path: URL
    let license: String?
    let metadata: [String: String]
    let allowedTools: [String]
    let hasScripts: Bool
    let argumentHint: String?
    let source: String?
    let installedAt: Date?
    let enabled: Bool

    init(
        name: String,
        description: String,
        scope: SkillScope,
        path: URL,
        license: String?,
        metadata: [String: String],
        allowedTools: [String],
        hasScripts: Bool,
        argumentHint: String?,
        source: String?,
        installedAt: Date?,
        enabled: Bool
    ) {
        self.name = name
        self.description = description
        self.scope = scope
        self.path = path
        self.license = license
        self.metadata = metadata
        self.allowedTools = allowedTools
        self.hasScripts = hasScripts
        self.argumentHint = argumentHint
        self.source = source
        self.installedAt = installedAt
        self.enabled = enabled
        self.id = "\(scope.rawValue.lowercased())::\(path.path)"
    }
}

enum SkillScope: String, CaseIterable, Codable, Sendable {
    case project = "Project"
    case user = "User"
    case admin = "Admin"
    case system = "System"

    var order: Int {
        switch self {
        case .project: return 0
        case .user: return 1
        case .admin: return 2
        case .system: return 3
        }
    }
}

struct SkillRegistryEntry: Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let description: String
    let source: String
    let stars: Int?
    let license: String?
    let lastUpdated: Date?
    let tags: [String]
    let compatibility: [String]
    let installs: Int?
    let skillId: String
}

struct SkillFrontmatter: Hashable {
    let name: String?
    let description: String?
    let license: String?
    let metadata: [String: String]
    let allowedTools: [String]
    let argumentHint: String?
}

struct SkillDocument: Hashable {
    let frontmatter: SkillFrontmatter
    let body: String
}

struct SkillInstallRecord: Codable, Hashable {
    let path: String
    let source: String?
    let installedAt: Date
    let lastUpdatedAt: Date?
}

enum SkillActivationMode: Hashable {
    case inline
    case tab(threadId: String)
}

struct ActiveSkill: Identifiable, Hashable {
    let id: String
    let skill: SkillItem
    let activatedAt: Date
    let mode: SkillActivationMode
    let arguments: String?
}
