import Foundation

struct JSONValue: Codable, Sendable {
    enum Storage {
        case object([String: JSONValue])
        case array([JSONValue])
        case string(String)
        case number(Double)
        case bool(Bool)
        case null
    }

    let storage: Storage

    init(_ storage: Storage) {
        self.storage = storage
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self.storage = .null
        } else if let bool = try? container.decode(Bool.self) {
            self.storage = .bool(bool)
        } else if let int = try? container.decode(Int.self) {
            self.storage = .number(Double(int))
        } else if let double = try? container.decode(Double.self) {
            self.storage = .number(double)
        } else if let string = try? container.decode(String.self) {
            self.storage = .string(string)
        } else if let array = try? container.decode([JSONValue].self) {
            self.storage = .array(array)
        } else if let object = try? container.decode([String: JSONValue].self) {
            self.storage = .object(object)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch storage {
        case .null:
            try container.encodeNil()
        case .bool(let value):
            try container.encode(value)
        case .number(let value):
            try container.encode(value)
        case .string(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .object(let value):
            try container.encode(value)
        }
    }

    func decode<T: Decodable>(_ type: T.Type, decoder: JSONDecoder = JSONDecoder()) throws -> T {
        let data = try JSONEncoder().encode(self)
        return try decoder.decode(T.self, from: data)
    }
}

enum RPCID: Hashable, Codable, Sendable {
    case string(String)
    case int(Int)

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let int = try? container.decode(Int.self) {
            self = .int(int)
        } else if let string = try? container.decode(String.self) {
            self = .string(string)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid RPC id")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value):
            try container.encode(value)
        case .int(let value):
            try container.encode(value)
        }
    }
}

struct RPCError: Decodable, Error, Sendable {
    struct Payload: Decodable, Sendable {
        let code: Int
        let message: String
        let data: JSONValue?
    }

    let error: Payload
    let id: RPCID
}

struct RPCMessage: Decodable, Sendable {
    let id: RPCID?
    let method: String?
    let params: JSONValue?
    let result: JSONValue?
    let error: RPCError.Payload?
}

struct RPCRequest<Params: Encodable>: Encodable {
    let id: RPCID
    let method: String
    let params: Params?

    enum CodingKeys: String, CodingKey {
        case id
        case method
        case params
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(method, forKey: .method)
        try container.encodeIfPresent(params, forKey: .params)
    }
}

struct RPCNotification<Params: Encodable>: Encodable {
    let method: String
    let params: Params?

    enum CodingKeys: String, CodingKey {
        case method
        case params
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(method, forKey: .method)
        try container.encodeIfPresent(params, forKey: .params)
    }
}

struct RPCResponse<Result: Encodable>: Encodable {
    let id: RPCID
    let result: Result
}

struct RPCErrorResponse: Encodable {
    struct Payload: Encodable {
        let code: Int
        let message: String
        let data: JSONValue?
    }

    let id: RPCID
    let error: Payload
}

final class JSONRPCTransport {
    enum Incoming: Sendable {
        case notification(method: String, params: JSONValue?)
        case request(id: RPCID, method: String, params: JSONValue?)
    }

    enum TransportError: Error, LocalizedError {
        case processNotRunning
        case missingResponse
        case rpcError(code: Int, message: String)

        var errorDescription: String? {
            switch self {
            case .processNotRunning:
                return "Codex process is not running"
            case .missingResponse:
                return "Missing response from codex"
            case .rpcError(let code, let message):
                return "Codex error (\(code)): \(message)"
            }
        }
    }

    private let process: Process
    private let inputHandle: FileHandle
    private let outputHandle: FileHandle
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private let writeLock = NSLock()
    private let pendingLock = NSLock()
    private var nextId: Int = 1
    private var pending: [RPCID: (Result<JSONValue, Error>) -> Void] = [:]
    private var readTask: Task<Void, Never>?

    let incoming: AsyncStream<Incoming>
    private let incomingContinuation: AsyncStream<Incoming>.Continuation

    init(executableURL: URL, arguments: [String], currentDirectoryURL: URL?) throws {
        let inputPipe = Pipe()
        let outputPipe = Pipe()
        process = Process()
        process.executableURL = executableURL
        process.arguments = arguments
        process.standardInput = inputPipe
        process.standardOutput = outputPipe
        process.standardError = FileHandle.nullDevice
        process.currentDirectoryURL = currentDirectoryURL

        inputHandle = inputPipe.fileHandleForWriting
        outputHandle = outputPipe.fileHandleForReading

        encoder = JSONEncoder()
        decoder = JSONDecoder()

        var streamContinuation: AsyncStream<Incoming>.Continuation?
        let stream = AsyncStream<Incoming> { continuation in
            continuation.onTermination = { _ in
                // no-op
            }
            streamContinuation = continuation
        }
        incoming = stream
        incomingContinuation = streamContinuation!
    }

    func start() throws {
        if process.isRunning {
            return
        }
        try process.run()
        readTask = Task.detached { [weak self] in
            await self?.readLoop()
        }
    }

    func stop() {
        readTask?.cancel()
        readTask = nil
        if process.isRunning {
            process.terminate()
        }
        incomingContinuation.finish()
        failAllPending(error: TransportError.processNotRunning)
    }

    func sendRequest<Params: Encodable, Result: Decodable>(method: String, params: Params?, responseType: Result.Type) async throws -> Result {
        guard process.isRunning else { throw TransportError.processNotRunning }
        let id = nextRequestId()
        let request = RPCRequest(id: id, method: method, params: params)

        let resultValue: JSONValue = try await withCheckedThrowingContinuation { continuation in
            registerPending(id: id) { result in
                continuation.resume(with: result)
            }
            do {
                try writeMessage(request)
            } catch {
                removePending(id: id)
                continuation.resume(throwing: error)
            }
        }

        return try resultValue.decode(Result.self, decoder: decoder)
    }

    func sendNotification<Params: Encodable>(method: String, params: Params?) throws {
        guard process.isRunning else { throw TransportError.processNotRunning }
        let notification = RPCNotification(method: method, params: params)
        try writeMessage(notification)
    }

    func sendResponse<Result: Encodable>(id: RPCID, result: Result) throws {
        guard process.isRunning else { throw TransportError.processNotRunning }
        let response = RPCResponse(id: id, result: result)
        try writeMessage(response)
    }

    func sendError(id: RPCID, code: Int, message: String) throws {
        guard process.isRunning else { throw TransportError.processNotRunning }
        let response = RPCErrorResponse(id: id, error: RPCErrorResponse.Payload(code: code, message: message, data: nil))
        try writeMessage(response)
    }

    private func nextRequestId() -> RPCID {
        pendingLock.lock()
        let id = nextId
        nextId += 1
        pendingLock.unlock()
        return .int(id)
    }

    private func registerPending(id: RPCID, resolver: @escaping (Result<JSONValue, Error>) -> Void) {
        pendingLock.lock()
        pending[id] = resolver
        pendingLock.unlock()
    }

    private func removePending(id: RPCID) {
        pendingLock.lock()
        pending.removeValue(forKey: id)
        pendingLock.unlock()
    }

    private func resolvePending(id: RPCID, result: JSONValue?, error: RPCError.Payload?) {
        pendingLock.lock()
        let resolver = pending.removeValue(forKey: id)
        pendingLock.unlock()
        guard let resolver else { return }

        if let error {
            resolver(.failure(TransportError.rpcError(code: error.code, message: error.message)))
            return
        }

        if let result {
            resolver(.success(result))
        } else {
            resolver(.failure(TransportError.missingResponse))
        }
    }

    private func failAllPending(error: Error) {
        pendingLock.lock()
        let pendingResolvers = pending
        pending.removeAll()
        pendingLock.unlock()
        for resolver in pendingResolvers.values {
            resolver(.failure(error))
        }
    }

    private func writeMessage<T: Encodable>(_ message: T) throws {
        let data = try encoder.encode(message)
        var line = data
        line.append(0x0A)
        writeLock.lock()
        defer { writeLock.unlock() }
        try inputHandle.write(contentsOf: line)
    }

    private func readLoop() async {
        do {
            for try await line in outputHandle.bytes.lines {
                if Task.isCancelled { break }
                guard !line.isEmpty else { continue }
                guard let data = line.data(using: .utf8) else { continue }
                do {
                    let message = try decoder.decode(RPCMessage.self, from: data)
                    handleMessage(message)
                } catch {
                    continue
                }
            }
        } catch {
            // ignore read errors
        }
        incomingContinuation.finish()
        failAllPending(error: TransportError.processNotRunning)
    }

    private func handleMessage(_ message: RPCMessage) {
        if let method = message.method {
            if let id = message.id {
                incomingContinuation.yield(.request(id: id, method: method, params: message.params))
            } else {
                incomingContinuation.yield(.notification(method: method, params: message.params))
            }
            return
        }

        if let id = message.id {
            resolvePending(id: id, result: message.result, error: message.error)
        }
    }
}
