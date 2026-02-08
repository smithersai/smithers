import Foundation

enum CodexEvent: Sendable {
    case turnStarted
    case agentMessageDelta(text: String)
    case agentMessageCompleted(text: String)
    case commandStarted(itemId: String, command: String, cwd: String)
    case commandOutput(itemId: String, text: String)
    case commandCompleted(itemId: String, exitCode: Int?)
    case turnCompleted(status: String)
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

    init() {
        var continuation: AsyncStream<CodexEvent>.Continuation?
        events = AsyncStream<CodexEvent> { streamContinuation in
            streamContinuation.onTermination = { _ in }
            continuation = streamContinuation
        }
        eventContinuation = continuation!
    }

    func start(cwd: String) async throws {
        if isRunning {
            return
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
        try await startThread(cwd: cwd)
    }

    func stop() {
        incomingTask?.cancel()
        incomingTask = nil
        transport?.stop()
        transport = nil
        threadId = nil
        activeTurnId = nil
        isRunning = false
    }

    func sendMessage(_ text: String) async throws {
        guard let transport, isRunning else { throw ServiceError.notRunning }
        guard let threadId else { throw ServiceError.threadUnavailable }

        let params = TurnStartParams(threadId: threadId, input: [UserInput.text(text)])
        let response: TurnStartResponse = try await transport.sendRequest(
            method: "turn/start",
            params: params,
            responseType: TurnStartResponse.self
        )
        activeTurnId = response.turn.id
        eventContinuation.yield(.turnStarted)
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
                eventContinuation.yield(.agentMessageDelta(text: decoded.delta))
            }
        case "item/commandExecution/outputDelta":
            if let params, let decoded = try? params.decode(CommandExecutionOutputDeltaParams.self) {
                eventContinuation.yield(.commandOutput(itemId: decoded.itemId, text: decoded.delta))
            }
        case "item/started":
            if let params, let decoded = try? params.decode(ItemNotificationParams.self) {
                switch decoded.item {
                case .commandExecution(let item):
                    eventContinuation.yield(.commandStarted(itemId: item.id, command: item.command, cwd: item.cwd))
                default:
                    break
                }
            }
        case "item/completed":
            if let params, let decoded = try? params.decode(ItemNotificationParams.self) {
                switch decoded.item {
                case .agentMessage(let item):
                    eventContinuation.yield(.agentMessageCompleted(text: item.text))
                case .commandExecution(let item):
                    eventContinuation.yield(.commandCompleted(itemId: item.id, exitCode: item.exitCode))
                default:
                    break
                }
            }
        case "turn/completed":
            if let params, let decoded = try? params.decode(TurnCompletedParams.self) {
                eventContinuation.yield(.turnCompleted(status: decoded.turn.status))
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
            let response = CommandExecutionRequestApprovalResponse(decision: "approve")
            try? transport?.sendResponse(id: id, result: response)
        case "item/fileChange/requestApproval":
            let response = FileChangeRequestApprovalResponse(decision: "approve")
            try? transport?.sendResponse(id: id, result: response)
        default:
            try? transport?.sendError(id: id, code: -32601, message: "Method not implemented")
        }
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

struct ThreadInfo: Decodable {
    let id: String
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
}

struct CommandExecutionOutputDeltaParams: Decodable {
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
    let text: String

    static func text(_ text: String) -> UserInput {
        UserInput(type: "text", text: text)
    }
}

enum ThreadItem: Decodable {
    case agentMessage(AgentMessageItem)
    case commandExecution(CommandExecutionItem)
    case other

    enum CodingKeys: String, CodingKey {
        case type
        case id
        case text
        case command
        case cwd
        case exitCode
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = (try? container.decode(String.self, forKey: .type)) ?? ""
        switch type {
        case "agentMessage":
            let id = try container.decode(String.self, forKey: .id)
            let text = (try? container.decode(String.self, forKey: .text)) ?? ""
            self = .agentMessage(AgentMessageItem(id: id, text: text))
        case "commandExecution":
            let id = try container.decode(String.self, forKey: .id)
            let command = try container.decode(String.self, forKey: .command)
            let cwd = try container.decode(String.self, forKey: .cwd)
            let exitCode = try? container.decode(Int.self, forKey: .exitCode)
            self = .commandExecution(CommandExecutionItem(id: id, command: command, cwd: cwd, exitCode: exitCode))
        default:
            self = .other
        }
    }
}

struct AgentMessageItem: Decodable {
    let id: String
    let text: String
}

struct CommandExecutionItem: Decodable {
    let id: String
    let command: String
    let cwd: String
    let exitCode: Int?
}
