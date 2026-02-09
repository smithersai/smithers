import Foundation

enum CodexEvent: Sendable {
    case turnStarted(turnId: String)
    case agentMessageDelta(turnId: String, text: String)
    case agentMessageCompleted(turnId: String, text: String)
    case commandStarted(turnId: String, itemId: String, command: String, cwd: String)
    case commandOutput(turnId: String, itemId: String, text: String)
    case commandCompleted(turnId: String, itemId: String, exitCode: Int?)
    case fileChange(turnId: String, item: FileChangeItem)
    case fileChangeDelta(turnId: String, itemId: String, delta: String)
    case turnDiffUpdated(turnId: String, diff: String)
    case turnCompleted(turnId: String, status: String)
    case error(message: String)
}

@MainActor
final class CodexService: ObservableObject {
    enum ServiceError: Error, LocalizedError {
        case missingBinary
        case notRunning
        case threadUnavailable
        case turnUnavailable

        var errorDescription: String? {
            switch self {
            case .missingBinary:
                return "codex-app-server binary not found"
            case .notRunning:
                return "Codex service is not running"
            case .threadUnavailable:
                return "Codex thread is not initialized"
            case .turnUnavailable:
                return "Codex turn is not active"
            }
        }
    }

    @Published private(set) var isRunning = false

    nonisolated let events: AsyncStream<CodexEvent>
    private let eventContinuation: AsyncStream<CodexEvent>.Continuation
    private var transport: JSONRPCTransport?
    private var incomingTask: Task<Void, Never>?
    private var threadId: String?
    private var activeTurnId: String?
    private var smithersCtlInterpreter: SmithersCtlInterpreter?
    private var handledSmithersCommandItemIds: Set<String> = []

    init() {
        var continuation: AsyncStream<CodexEvent>.Continuation?
        events = AsyncStream<CodexEvent> { streamContinuation in
            streamContinuation.onTermination = { _ in }
            continuation = streamContinuation
        }
        eventContinuation = continuation!
    }

    func attachWorkspace(_ workspace: WorkspaceState) {
        smithersCtlInterpreter = SmithersCtlInterpreter(workspace: workspace)
    }

    func start(cwd: String, resumeThreadId: String? = nil) async throws -> ThreadStartResult {
        if isRunning {
            guard let threadId else { throw ServiceError.threadUnavailable }
            return ThreadStartResult(threadId: threadId, restoredThread: nil, resumed: false)
        }

        let binaryURL = try locateCodexBinary()
        let workingDirectory = URL(fileURLWithPath: cwd)
        let transport = try JSONRPCTransport(
            executableURL: binaryURL,
            arguments: ["--listen", "stdio://"],
            currentDirectoryURL: workingDirectory
        )
        self.transport = transport
        try transport.start()
        isRunning = true

        incomingTask = Task.detached { [weak self] in
            guard let self else { return }
            let transport = await self.transport
            guard let transport else { return }
            for await message in transport.incoming {
                await self.handleIncoming(message)
            }
            await self.handleTransportEnded()
        }

        try await initializeSession()
        if let resumeThreadId {
            do {
                let thread = try await resumeThread(threadId: resumeThreadId, cwd: cwd)
                return ThreadStartResult(threadId: thread.id, restoredThread: thread, resumed: true)
            } catch {
                try await startThread(cwd: cwd)
                guard let threadId else { throw ServiceError.threadUnavailable }
                return ThreadStartResult(threadId: threadId, restoredThread: nil, resumed: false)
            }
        } else {
            try await startThread(cwd: cwd)
            guard let threadId else { throw ServiceError.threadUnavailable }
            return ThreadStartResult(threadId: threadId, restoredThread: nil, resumed: false)
        }
    }

    func stop() {
        incomingTask?.cancel()
        incomingTask = nil
        transport?.stop()
        transport = nil
        threadId = nil
        activeTurnId = nil
        smithersCtlInterpreter = nil
        handledSmithersCommandItemIds.removeAll()
        isRunning = false
    }

    @discardableResult
    func sendMessage(
        _ text: String,
        images: [ChatImage] = [],
        extraInputs: [UserInput] = []
    ) async throws -> String {
        guard let transport, isRunning else { throw ServiceError.notRunning }
        guard let threadId else { throw ServiceError.threadUnavailable }

        var input: [UserInput] = extraInputs
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            input.append(UserInput.text(trimmed))
        }
        for image in images {
            input.append(UserInput.image(image.payloadDataURL()))
        }
        let params = TurnStartParams(threadId: threadId, input: input)
        let response: TurnStartResponse = try await transport.sendRequest(
            method: "turn/start",
            params: params,
            responseType: TurnStartResponse.self
        )
        activeTurnId = response.turn.id
        eventContinuation.yield(.turnStarted(turnId: response.turn.id))
        return response.turn.id
    }

    func interrupt() async throws {
        guard let transport, isRunning else { throw ServiceError.notRunning }
        guard let threadId, let activeTurnId else { throw ServiceError.turnUnavailable }

        let params = TurnInterruptParams(threadId: threadId, turnId: activeTurnId)
        _ = try await transport.sendRequest(
            method: "turn/interrupt",
            params: params,
            responseType: EmptyResponse.self
        )
    }

    func login(apiKey: String) async throws {
        guard let transport, isRunning else { throw ServiceError.notRunning }

        let params = LoginApiKeyParams(apiKey: apiKey)
        _ = try await transport.sendRequest(
            method: "account/login/start",
            params: params,
            responseType: LoginApiKeyResponse.self
        )
    }

    func startNewThread(cwd: String) async throws -> String {
        guard let transport, isRunning else { throw ServiceError.notRunning }

        let params = ThreadStartParams(
            cwd: cwd,
            approvalPolicy: .never,
            sandbox: .workspaceWrite
        )
        let response: ThreadStartResponse = try await transport.sendRequest(
            method: "thread/start",
            params: params,
            responseType: ThreadStartResponse.self
        )
        threadId = response.thread.id
        activeTurnId = nil
        return response.thread.id
    }

    func forkThread(threadId: String, cwd: String) async throws -> ThreadSnapshot {
        guard let transport, isRunning else { throw ServiceError.notRunning }

        let params = ThreadForkParams(
            threadId: threadId,
            cwd: cwd,
            approvalPolicy: .never,
            sandbox: .workspaceWrite
        )
        let response: ThreadForkResponse = try await transport.sendRequest(
            method: "thread/fork",
            params: params,
            responseType: ThreadForkResponse.self
        )
        self.threadId = response.thread.id
        activeTurnId = nil
        return response.thread
    }

    func rollbackThread(threadId: String, numTurns: Int) async throws -> ThreadSnapshot {
        guard let transport, isRunning else { throw ServiceError.notRunning }

        let params = ThreadRollbackParams(threadId: threadId, numTurns: numTurns)
        let response: ThreadRollbackResponse = try await transport.sendRequest(
            method: "thread/rollback",
            params: params,
            responseType: ThreadRollbackResponse.self
        )
        activeTurnId = nil
        return response.thread
    }

    private func handleIncoming(_ incoming: JSONRPCTransport.Incoming) async {
        switch incoming {
        case .notification(let method, let params):
            handleNotification(method: method, params: params)
        case .request(let id, let method, let params):
            handleRequest(id: id, method: method, params: params)
        }
    }

    private func handleTransportEnded() async {
        isRunning = false
        eventContinuation.yield(.error(message: "Codex service stopped."))
    }

    private func handleNotification(method: String, params: JSONValue?) {
        switch method {
        case "item/agentMessage/delta":
            if let params, let decoded = try? params.decode(AgentMessageDeltaParams.self) {
                eventContinuation.yield(.agentMessageDelta(turnId: decoded.turnId, text: decoded.delta))
            }
        case "item/commandExecution/outputDelta":
            if let params, let decoded = try? params.decode(CommandExecutionOutputDeltaParams.self) {
                if handledSmithersCommandItemIds.contains(decoded.itemId) {
                    return
                }
                eventContinuation.yield(.commandOutput(turnId: decoded.turnId, itemId: decoded.itemId, text: decoded.delta))
            }
        case "item/fileChange/outputDelta":
            if let params, let decoded = try? params.decode(FileChangeOutputDeltaParams.self) {
                eventContinuation.yield(.fileChangeDelta(turnId: decoded.turnId, itemId: decoded.itemId, delta: decoded.delta))
            }
        case "item/started":
            if let params, let decoded = try? params.decode(ItemNotificationParams.self) {
                switch decoded.item {
                case .commandExecution(let item):
                    eventContinuation.yield(.commandStarted(
                        turnId: decoded.turnId,
                        itemId: item.id,
                        command: item.command,
                        cwd: item.cwd
                    ))
                default:
                    break
                }
            }
        case "item/completed":
            if let params, let decoded = try? params.decode(ItemNotificationParams.self) {
                switch decoded.item {
                case .agentMessage(let item):
                    eventContinuation.yield(.agentMessageCompleted(turnId: decoded.turnId, text: item.text))
                case .commandExecution(let item):
                    if handledSmithersCommandItemIds.remove(item.id) != nil {
                        break
                    }
                    eventContinuation.yield(.commandCompleted(
                        turnId: decoded.turnId,
                        itemId: item.id,
                        exitCode: item.exitCode
                    ))
                case .fileChange(let item):
                    eventContinuation.yield(.fileChange(turnId: decoded.turnId, item: item))
                default:
                    break
                }
            }
        case "turn/diff/updated":
            if let params, let decoded = try? params.decode(TurnDiffUpdatedParams.self) {
                eventContinuation.yield(.turnDiffUpdated(turnId: decoded.turnId, diff: decoded.diff))
            }
        case "turn/completed":
            if let params, let decoded = try? params.decode(TurnCompletedParams.self) {
                eventContinuation.yield(.turnCompleted(turnId: decoded.turn.id, status: decoded.turn.status))
                activeTurnId = nil
            }
        case "error":
            if let params, let decoded = try? params.decode(ErrorNotificationParams.self) {
                eventContinuation.yield(.error(message: decoded.error.message))
                activeTurnId = nil
            }
        default:
            break
        }
    }

    private func handleRequest(id: RPCID, method: String, params: JSONValue?) {
        switch method {
        case "item/commandExecution/requestApproval":
            if let params,
               let decoded = try? params.decode(CommandExecutionRequestApprovalParams.self),
               isSmithersCtlCommand(decoded.command),
               let interpreter = smithersCtlInterpreter {
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    let result = await interpreter.dispatch(commandLine: decoded.command, cwd: decoded.cwd)
                    handledSmithersCommandItemIds.insert(decoded.itemId)
                    if !result.output.isEmpty {
                        eventContinuation.yield(.commandOutput(turnId: decoded.turnId, itemId: decoded.itemId, text: result.output))
                    }
                    eventContinuation.yield(.commandCompleted(turnId: decoded.turnId, itemId: decoded.itemId, exitCode: result.exitCode))
                    let response = CommandExecutionRequestApprovalResponse(decision: "decline")
                    try? transport?.sendResponse(id: id, result: response)
                }
                return
            }
            let response = CommandExecutionRequestApprovalResponse(decision: "approve")
            try? transport?.sendResponse(id: id, result: response)
        case "item/fileChange/requestApproval":
            let response = FileChangeRequestApprovalResponse(decision: "approve")
            try? transport?.sendResponse(id: id, result: response)
        default:
            try? transport?.sendError(id: id, code: -32601, message: "Method not implemented")
        }
    }

    private func isSmithersCtlCommand(_ command: String) -> Bool {
        let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed == "smithers-ctl"
            || trimmed.hasPrefix("smithers-ctl ")
            || trimmed == "smithers"
            || trimmed.hasPrefix("smithers ")
    }

    private func initializeSession() async throws {
        guard let transport else { throw ServiceError.notRunning }

        let initParams = InitializeParams(
            clientInfo: ClientInfo(name: "smithers", title: "Smithers", version: "0.1.0"),
            capabilities: InitializeCapabilities(experimentalApi: false)
        )
        _ = try await transport.sendRequest(
            method: "initialize",
            params: initParams,
            responseType: InitializeResponse.self
        )
        try transport.sendNotification(method: "initialized", params: Optional<EmptyResponse>.none)
    }

    private func startThread(cwd: String) async throws {
        guard let transport else { throw ServiceError.notRunning }

        let params = ThreadStartParams(
            cwd: cwd,
            approvalPolicy: .never,
            sandbox: .workspaceWrite
        )
        let response: ThreadStartResponse = try await transport.sendRequest(
            method: "thread/start",
            params: params,
            responseType: ThreadStartResponse.self
        )
        threadId = response.thread.id
    }

    func resumeThread(threadId: String, cwd: String) async throws -> ThreadSnapshot {
        guard let transport else { throw ServiceError.notRunning }

        let params = ThreadResumeParams(
            threadId: threadId,
            cwd: cwd,
            approvalPolicy: .never,
            sandbox: .workspaceWrite
        )
        let response: ThreadResumeResponse = try await transport.sendRequest(
            method: "thread/resume",
            params: params,
            responseType: ThreadResumeResponse.self
        )
        self.threadId = response.thread.id
        activeTurnId = nil
        return response.thread
    }

    private func locateCodexBinary() throws -> URL {
        let fm = FileManager.default
        if let overridePath = ProcessInfo.processInfo.environment["SMITHERS_CODEX_APP_SERVER_PATH"],
           !overridePath.isEmpty {
            let overrideURL = URL(fileURLWithPath: overridePath)
            if fm.isExecutableFile(atPath: overrideURL.path) {
                return overrideURL
            }
        }

        let bundleBinary = Bundle.main.resourceURL?.appendingPathComponent("codex-app-server")
        if let bundleBinary, fm.isExecutableFile(atPath: bundleBinary.path) {
            return bundleBinary
        }

        let releaseRelativePath = "codex/codex-rs/target/release/codex-app-server"
        let debugRelativePath = "codex/codex-rs/target/debug/codex-app-server"
        let searchRoots = [
            URL(fileURLWithPath: fm.currentDirectoryPath),
            Bundle.main.bundleURL
        ]

        for root in searchRoots {
            if let found = findBinary(relativePath: releaseRelativePath, from: root) {
                return found
            }
            if let found = findBinary(relativePath: debugRelativePath, from: root) {
                return found
            }
        }

        throw ServiceError.missingBinary
    }

    private func findBinary(relativePath: String, from root: URL) -> URL? {
        var candidateRoot = root
        for _ in 0..<12 {
            let candidate = candidateRoot.appendingPathComponent(relativePath)
            if FileManager.default.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
            candidateRoot.deleteLastPathComponent()
        }
        return nil
    }
}

struct EmptyResponse: Codable {}

struct ThreadStartResult {
    let threadId: String
    let restoredThread: ThreadSnapshot?
    let resumed: Bool
}

struct InitializeParams: Encodable {
    let clientInfo: ClientInfo
    let capabilities: InitializeCapabilities?
}

struct ClientInfo: Encodable {
    let name: String
    let title: String?
    let version: String
}

struct InitializeCapabilities: Encodable {
    let experimentalApi: Bool
}

struct InitializeResponse: Decodable {
    let userAgent: String
}

struct ThreadStartParams: Encodable {
    let cwd: String?
    let approvalPolicy: ApprovalPolicy?
    let sandbox: SandboxMode?
}

struct ThreadStartResponse: Decodable {
    let thread: ThreadInfo
}

struct ThreadResumeParams: Encodable {
    let threadId: String
    let cwd: String?
    let approvalPolicy: ApprovalPolicy?
    let sandbox: SandboxMode?
}

struct ThreadResumeResponse: Decodable {
    let thread: ThreadSnapshot
}

struct ThreadForkParams: Encodable {
    let threadId: String
    let cwd: String?
    let approvalPolicy: ApprovalPolicy?
    let sandbox: SandboxMode?
}

struct ThreadForkResponse: Decodable {
    let thread: ThreadSnapshot
}

struct ThreadRollbackParams: Encodable {
    let threadId: String
    let numTurns: Int
}

struct ThreadRollbackResponse: Decodable {
    let thread: ThreadSnapshot
}

struct ThreadInfo: Decodable {
    let id: String
}

struct ThreadSnapshot: Decodable {
    let id: String
    let turns: [TurnSnapshot]
}

struct TurnSnapshot: Decodable {
    let id: String
    let status: String
    let items: [ThreadItem]
}

struct TurnStartParams: Encodable {
    let threadId: String
    let input: [UserInput]
}

struct TurnStartResponse: Decodable {
    let turn: TurnInfo
}

struct TurnInterruptParams: Encodable {
    let threadId: String
    let turnId: String
}

struct TurnInfo: Decodable {
    let id: String
    let status: String
}

struct TurnCompletedParams: Decodable {
    let threadId: String
    let turn: TurnInfo
}

struct AgentMessageDeltaParams: Decodable {
    let delta: String
    let itemId: String
    let threadId: String
    let turnId: String
}

struct CommandExecutionOutputDeltaParams: Decodable {
    let itemId: String
    let delta: String
    let threadId: String
    let turnId: String
}

struct FileChangeOutputDeltaParams: Decodable {
    let threadId: String
    let turnId: String
    let itemId: String
    let delta: String
}

struct ErrorNotificationParams: Decodable {
    let error: TurnErrorInfo
}

struct TurnErrorInfo: Decodable {
    let message: String
}

struct ItemNotificationParams: Decodable {
    let item: ThreadItem
    let threadId: String
    let turnId: String
}

struct TurnDiffUpdatedParams: Decodable {
    let threadId: String
    let turnId: String
    let diff: String
}

struct CommandExecutionRequestApprovalParams: Decodable {
    let threadId: String
    let turnId: String
    let itemId: String
    let command: String
    let cwd: String
}

struct CommandExecutionRequestApprovalResponse: Encodable {
    let decision: String
}

struct FileChangeRequestApprovalResponse: Encodable {
    let decision: String
}

struct LoginApiKeyParams: Encodable {
    let type: String = "apiKey"
    let apiKey: String
}

struct LoginApiKeyResponse: Decodable {
    let type: String
}

enum ApprovalPolicy: String, Encodable {
    case untrusted = "untrusted"
    case onFailure = "on-failure"
    case onRequest = "on-request"
    case never = "never"
}

enum SandboxMode: String, Encodable {
    case readOnly = "read-only"
    case workspaceWrite = "workspace-write"
    case dangerFullAccess = "danger-full-access"
}

struct UserInput: Encodable {
    let type: String
    let text: String?
    let url: String?
    let name: String?
    let path: String?

    static func text(_ text: String) -> UserInput {
        UserInput(type: "text", text: text, url: nil, name: nil, path: nil)
    }

    static func image(_ url: String) -> UserInput {
        UserInput(type: "image", text: nil, url: url, name: nil, path: nil)
    }

    static func skill(name: String, path: String) -> UserInput {
        UserInput(type: "skill", text: nil, url: nil, name: name, path: path)
    }

    static func mention(name: String, path: String) -> UserInput {
        UserInput(type: "mention", text: nil, url: nil, name: name, path: path)
    }

    private enum CodingKeys: String, CodingKey {
        case type
        case text
        case url
        case name
        case path
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        if let text {
            try container.encode(text, forKey: .text)
        }
        if let url {
            try container.encode(url, forKey: .url)
        }
        if let name {
            try container.encode(name, forKey: .name)
        }
        if let path {
            try container.encode(path, forKey: .path)
        }
    }
}

enum UserInputPayload: Decodable {
    case text(String)
    case image(String)
    case localImage(String)
    case other

    private enum CodingKeys: String, CodingKey {
        case type
        case text
        case url
        case path
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = (try? container.decode(String.self, forKey: .type)) ?? ""
        switch type {
        case "text":
            let text = (try? container.decode(String.self, forKey: .text)) ?? ""
            self = .text(text)
        case "image":
            let url = (try? container.decode(String.self, forKey: .url)) ?? ""
            self = .image(url)
        case "localImage":
            let path = (try? container.decode(String.self, forKey: .path)) ?? ""
            self = .localImage(path)
        default:
            self = .other
        }
    }
}

enum ThreadItem: Decodable {
    case userMessage(UserMessageItem)
    case agentMessage(AgentMessageItem)
    case plan(PlanItem)
    case reasoning(ReasoningItem)
    case commandExecution(CommandExecutionItem)
    case fileChange(FileChangeItem)
    case other

    enum CodingKeys: String, CodingKey {
        case type
        case id
        case text
        case content
        case summary
        case command
        case cwd
        case exitCode
        case aggregatedOutput
        case changes
        case status
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = (try? container.decode(String.self, forKey: .type)) ?? ""
        switch type {
        case "userMessage":
            let id = try container.decode(String.self, forKey: .id)
            let content = (try? container.decode([UserInputPayload].self, forKey: .content)) ?? []
            self = .userMessage(UserMessageItem(id: id, content: content))
        case "agentMessage":
            let id = try container.decode(String.self, forKey: .id)
            let text = (try? container.decode(String.self, forKey: .text)) ?? ""
            self = .agentMessage(AgentMessageItem(id: id, text: text))
        case "plan":
            let id = try container.decode(String.self, forKey: .id)
            let text = (try? container.decode(String.self, forKey: .text)) ?? ""
            self = .plan(PlanItem(id: id, text: text))
        case "reasoning":
            let id = try container.decode(String.self, forKey: .id)
            let summary = (try? container.decode([String].self, forKey: .summary)) ?? []
            let content = (try? container.decode([String].self, forKey: .content)) ?? []
            self = .reasoning(ReasoningItem(id: id, summary: summary, content: content))
        case "commandExecution":
            let id = try container.decode(String.self, forKey: .id)
            let command = try container.decode(String.self, forKey: .command)
            let cwd = try container.decode(String.self, forKey: .cwd)
            let exitCode = try? container.decode(Int.self, forKey: .exitCode)
            let status = try? container.decode(CommandExecutionItemStatus.self, forKey: .status)
            let aggregatedOutput = try? container.decodeIfPresent(String.self, forKey: .aggregatedOutput)
            self = .commandExecution(CommandExecutionItem(
                id: id,
                command: command,
                cwd: cwd,
                exitCode: exitCode,
                aggregatedOutput: aggregatedOutput,
                status: status
            ))
        case "fileChange":
            let id = try container.decode(String.self, forKey: .id)
            let changes = (try? container.decode([FileUpdateChange].self, forKey: .changes)) ?? []
            let status = (try? container.decode(PatchApplyStatus.self, forKey: .status)) ?? .completed
            self = .fileChange(FileChangeItem(id: id, changes: changes, status: status))
        default:
            self = .other
        }
    }
}

struct AgentMessageItem: Decodable {
    let id: String
    let text: String
}

struct UserMessageItem: Decodable {
    let id: String
    let content: [UserInputPayload]
}

struct PlanItem: Decodable {
    let id: String
    let text: String
}

struct ReasoningItem: Decodable {
    let id: String
    let summary: [String]
    let content: [String]
}

struct CommandExecutionItem: Decodable {
    let id: String
    let command: String
    let cwd: String
    let exitCode: Int?
    let aggregatedOutput: String?
    let status: CommandExecutionItemStatus?

    init(
        id: String,
        command: String,
        cwd: String,
        exitCode: Int?,
        aggregatedOutput: String?,
        status: CommandExecutionItemStatus?
    ) {
        self.id = id
        self.command = command
        self.cwd = cwd
        self.exitCode = exitCode
        self.aggregatedOutput = aggregatedOutput
        self.status = status
    }
}

enum CommandExecutionItemStatus: String, Decodable {
    case inProgress = "inProgress"
    case completed
    case failed
    case declined
}

struct FileChangeItem: Decodable, Hashable, Sendable {
    let id: String
    let changes: [FileUpdateChange]
    let status: PatchApplyStatus
}

struct FileUpdateChange: Decodable, Hashable, Sendable {
    let path: String
    let kind: PatchChangeKind
    let diff: String
}

enum PatchApplyStatus: String, Decodable, Hashable, Sendable {
    case inProgress = "inProgress"
    case completed
    case failed
    case declined
}

enum PatchChangeKind: Hashable, Sendable, Decodable {
    case add
    case delete
    case update(movePath: String?)

    private enum CodingKeys: String, CodingKey {
        case type
        case movePath = "move_path"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = (try? container.decode(String.self, forKey: .type)) ?? ""
        switch type {
        case "add":
            self = .add
        case "delete":
            self = .delete
        case "update":
            let movePath = try container.decodeIfPresent(String.self, forKey: .movePath)
            self = .update(movePath: movePath)
        default:
            self = .update(movePath: nil)
        }
    }
}
