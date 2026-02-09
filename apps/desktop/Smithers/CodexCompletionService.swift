import Foundation

@MainActor
final class CodexCompletionService {
    enum CompletionError: Error, LocalizedError {
        case notRunning
        case turnFailed(String)
        case serviceError(String)

        var errorDescription: String? {
            switch self {
            case .notRunning:
                return "Completion service is not running"
            case .turnFailed(let status):
                return "Completion turn failed: \(status)"
            case .serviceError(let message):
                return message
            }
        }
    }

    private final class CompletionRequest {
        let turnId: String
        var buffer: String
        let onDelta: @MainActor (String) -> Void
        var continuation: CheckedContinuation<String, Error>?
        var isCompleted = false

        init(turnId: String, onDelta: @escaping @MainActor (String) -> Void, continuation: CheckedContinuation<String, Error>) {
            self.turnId = turnId
            self.buffer = ""
            self.onDelta = onDelta
            self.continuation = continuation
        }

        func finish(_ result: Result<String, Error>) {
            guard !isCompleted else { return }
            isCompleted = true
            continuation?.resume(with: result)
            continuation = nil
        }
    }

    private let service = CodexService()
    private var eventsTask: Task<Void, Never>?
    private var activeRequest: CompletionRequest?

    func start(cwd: String) async throws {
        guard !service.isRunning else { return }
        _ = try await service.start(cwd: cwd, resumeThreadId: nil)
        eventsTask = Task { @MainActor [weak self] in
            guard let self else { return }
            for await event in service.events {
                self.handle(event)
            }
        }
    }

    func stop() {
        cancelActiveRequest()
        eventsTask?.cancel()
        eventsTask = nil
        service.stop()
    }

    func login(apiKey: String) async throws {
        try await service.login(apiKey: apiKey)
    }

    func requestCompletion(
        prompt: String,
        onDelta: @escaping @MainActor (String) -> Void
    ) async throws -> String {
        guard service.isRunning else { throw CompletionError.notRunning }
        cancelActiveRequest()
        let turnId = try await service.sendMessage(prompt)
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                activeRequest = CompletionRequest(turnId: turnId, onDelta: onDelta, continuation: continuation)
            }
        }, onCancel: {
            Task { @MainActor [weak self] in
                self?.cancelActiveRequest()
            }
        })
    }

    func cancelActiveRequest() {
        if let activeRequest {
            activeRequest.finish(.failure(CancellationError()))
        }
        activeRequest = nil
        Task { @MainActor [weak self] in
            try? await self?.service.interrupt()
        }
    }

    private func handle(_ event: CodexEvent) {
        guard let activeRequest else { return }
        switch event {
        case .agentMessageDelta(let turnId, let text):
            guard turnId == activeRequest.turnId else { return }
            activeRequest.buffer += text
            activeRequest.onDelta(activeRequest.buffer)
        case .agentMessageCompleted(let turnId, let text):
            guard turnId == activeRequest.turnId else { return }
            activeRequest.finish(.success(text))
            self.activeRequest = nil
        case .turnCompleted(let turnId, let status):
            guard turnId == activeRequest.turnId else { return }
            if status == "completed" {
                activeRequest.finish(.success(activeRequest.buffer))
                self.activeRequest = nil
                return
            }
            activeRequest.finish(.failure(CompletionError.turnFailed(status)))
            self.activeRequest = nil
        case .error(let message):
            activeRequest.finish(.failure(CompletionError.serviceError(message)))
            self.activeRequest = nil
        default:
            break
        }
    }
}
