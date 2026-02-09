import Foundation

@MainActor
class AgentOrchestrator: ObservableObject {
    let mainWorkspace: URL
    let jjService: JJService
    let snapshotStore: JJSnapshotStore

    @Published var activeAgents: [AgentWorkspace] = []
    @Published var mergeQueue: MergeQueue = MergeQueue()
    @Published var isProcessingQueue: Bool = false

    private var pollingTask: Task<Void, Never>?
    private var queueProcessingTask: Task<Void, Never>?
    private var agentCodexServices: [String: CodexService] = [:]
    private var agentEventTasks: [String: Task<Void, Never>] = [:]
    private var agentActiveTurnIds: [String: String] = [:]
    private var mergeWorkspaceService: JJService?
    private var preferences: VCSPreferences

    init(mainWorkspace: URL, jjService: JJService, snapshotStore: JJSnapshotStore, preferences: VCSPreferences) {
        self.mainWorkspace = mainWorkspace
        self.jjService = jjService
        self.snapshotStore = snapshotStore
        self.preferences = preferences
    }

    // MARK: - Agent Lifecycle

    func spawnAgent(task: String, baseRevision: String = "trunk()") async throws -> AgentWorkspace {
        guard activeAgents.count < preferences.maxConcurrentAgents else {
            throw JJError.commandFailed("Maximum concurrent agents (\(preferences.maxConcurrentAgents)) reached")
        }

        let slug = makeSlug(from: task)
        let basePath = preferences.agentWorkspaceBasePath.map { URL(fileURLWithPath: $0) }
            ?? mainWorkspace.deletingLastPathComponent()
        let workspacePath = basePath.appendingPathComponent(slug)

        // Create jj workspace
        let wsInfo = try await jjService.workspaceAdd(
            path: workspacePath.path,
            revision: baseRevision,
            description: "agent: \(task)"
        )

        // Run setup commands
        for cmd in preferences.agentSetupCommands {
            try await runSetupCommand(cmd, in: workspacePath)
        }

        // Create a CodexService for this agent
        let codexService = CodexService()
        let chatSessionId = UUID().uuidString

        let agent = AgentWorkspace(
            id: slug,
            directory: workspacePath,
            changeId: wsInfo.workingCopyChangeId,
            task: task,
            chatSessionId: chatSessionId,
            status: .running,
            createdAt: Date(),
            filesChanged: []
        )

        activeAgents.append(agent)
        agentCodexServices[slug] = codexService

        // Record in SQLite
        try await snapshotStore.recordAgentWorkspace(AgentWorkspaceRecord(
            id: slug,
            workspacePath: workspacePath.path,
            mainWorkspacePath: mainWorkspace.path,
            changeId: wsInfo.workingCopyChangeId,
            task: task,
            chatSessionId: chatSessionId,
            status: AgentStatus.running.rawValue,
            priority: MergeQueuePriority.normal.rawValue,
            createdAt: Date()
        ))

        try await snapshotStore.logMergeQueueAction(agentId: slug, action: "spawned", details: task)

        // Start the codex service
        let threadResult = try await codexService.start(cwd: workspacePath.path)
        _ = threadResult

        startAgentEventListener(agentId: slug, codexService: codexService)

        // Send the task
        let turnId = try await codexService.sendMessage(task, images: [])
        agentActiveTurnIds[slug] = turnId

        // Start polling if not already
        startPollingIfNeeded()

        return agent
    }

    func cancelAgent(_ agent: AgentWorkspace) async throws {
        guard let idx = activeAgents.firstIndex(where: { $0.id == agent.id }) else { return }

        stopAgentService(agentId: agent.id)

        // Update status
        activeAgents[idx].status = .cancelled

        // Clean up workspace
        try await jjService.workspaceForget(name: agent.id)

        // Clean up directory
        try? FileManager.default.removeItem(at: agent.directory)

        // Update SQLite
        try? await snapshotStore.updateAgentStatus(id: agent.id, status: .cancelled)
        try? await snapshotStore.logMergeQueueAction(agentId: agent.id, action: "cancelled")

        // Remove from merge queue
        mergeQueue.remove(agentId: agent.id)

        // Remove from active list
        activeAgents.removeAll { $0.id == agent.id }
    }

    func agentCompleted(_ agent: AgentWorkspace) async {
        guard let idx = activeAgents.firstIndex(where: { $0.id == agent.id }) else { return }

        activeAgents[idx].status = .completed

        // Seal the agent's changes
        let agentJJ = JJService(workingDirectory: agent.directory)
        let _ = agentJJ.detectVCS()
        do {
            try await agentJJ.describe(message: "agent(\(agent.id)): \(agent.task)")
            _ = try await agentJJ.newChange()
        } catch {
            // Non-fatal
        }

        // Enqueue for merge
        let entry = MergeQueueEntry(
            id: agent.id,
            agentId: agent.id,
            changeId: agent.changeId,
            task: agent.task,
            priority: .normal,
            status: .waiting,
            enqueuedAt: Date()
        )
        mergeQueue.enqueue(entry)
        activeAgents[idx].status = .inQueue

        try? await snapshotStore.updateAgentStatus(id: agent.id, status: .inQueue)
        try? await snapshotStore.logMergeQueueAction(agentId: agent.id, action: "enqueued")

        stopAgentService(agentId: agent.id)

        // Auto-process queue if enabled
        if preferences.mergeQueueAutoRun {
            processQueue()
        }
    }

    // MARK: - Merge Queue Processing

    func processQueue() {
        guard !isProcessingQueue else { return }

        queueProcessingTask = Task {
            isProcessingQueue = true
            defer { isProcessingQueue = false }

            while let entry = mergeQueue.dequeue() {
                await processMergeEntry(entry)
            }
        }
    }

    private func processMergeEntry(_ entry: MergeQueueEntry) async {
        let agentId = entry.agentId

        // Step 1: Create merge revision
        try? await snapshotStore.logMergeQueueAction(agentId: agentId, action: "merge_started")

        do {
            let mergeJJ = try await ensureMergeWorkspace()

            // Create a merge commit: jj new trunk() <change>
            _ = try await mergeJJ.runMerge(
                trunk: "trunk()",
                changeId: entry.changeId
            )

            // Step 2: Check for conflicts
            let status = try await mergeJJ.status()
            if !status.conflicts.isEmpty {
                mergeQueue.updateStatus(agentId: agentId, status: .conflicted)
                try? await snapshotStore.logMergeQueueAction(
                    agentId: agentId,
                    action: "conflicted",
                    details: status.conflicts.joined(separator: ", ")
                )

                if let idx = activeAgents.firstIndex(where: { $0.id == agentId }) {
                    activeAgents[idx].status = .conflicted
                }
                try? await snapshotStore.updateAgentStatus(id: agentId, status: .conflicted)

                // Undo the failed merge
                try? await mergeJJ.undo()
                return
            }

            // Step 3: Run tests if configured
            if let testCommand = preferences.mergeQueueTestCommand ?? mergeQueue.testCommand {
                mergeQueue.updateStatus(agentId: agentId, status: .testing)
                try? await snapshotStore.logMergeQueueAction(agentId: agentId, action: "test_started")

                let testResult = await runTestCommand(testCommand, in: mergeJJ.workingDirectory)

                if testResult.passed {
                    try? await snapshotStore.logMergeQueueAction(agentId: agentId, action: "test_passed")
                } else {
                    mergeQueue.updateStatus(agentId: agentId, status: .testFailed)
                    try? await snapshotStore.logMergeQueueAction(
                        agentId: agentId,
                        action: "test_failed",
                        details: testResult.output
                    )

                    if let idx = activeAgents.firstIndex(where: { $0.id == agentId }) {
                        activeAgents[idx].status = .failed
                    }
                    try? await snapshotStore.updateAgentStatus(id: agentId, status: .failed, testOutput: testResult.output)

                    // Undo the failed merge
                    try? await mergeJJ.undo()
                    return
                }
            }

            // Step 4: Land the change
            mergeQueue.updateStatus(agentId: agentId, status: .landed)
            try? await snapshotStore.logMergeQueueAction(agentId: agentId, action: "landed")

            if let idx = activeAgents.firstIndex(where: { $0.id == agentId }) {
                activeAgents[idx].status = .merged
            }
            try? await snapshotStore.updateAgentStatus(id: agentId, status: .merged)

            // Clean up workspace
            try? await jjService.workspaceForget(name: agentId)
            if let agent = activeAgents.first(where: { $0.id == agentId }) {
                try? FileManager.default.removeItem(at: agent.directory)
            }

            // Stop codex service
            stopAgentService(agentId: agentId)

        } catch {
            mergeQueue.updateStatus(agentId: agentId, status: .testFailed)
            try? await snapshotStore.logMergeQueueAction(
                agentId: agentId,
                action: "merge_failed",
                details: error.localizedDescription
            )
            if let idx = activeAgents.firstIndex(where: { $0.id == agentId }) {
                activeAgents[idx].status = .failed
            }
            try? await snapshotStore.updateAgentStatus(id: agentId, status: .failed)
        }
    }

    // MARK: - Polling

    func startPollingIfNeeded() {
        guard pollingTask == nil else { return }
        pollingTask = Task {
            while !Task.isCancelled {
                await pollAgentStatus()
                try? await Task.sleep(nanoseconds: 5_000_000_000) // 5 seconds
            }
        }
    }

    func stopPolling() {
        pollingTask?.cancel()
        pollingTask = nil
    }

    func pollAgentStatus() async {
        let snapshot = activeAgents
        for agent in snapshot where agent.status == .running {
            let agentId = agent.id

            let agentJJ = JJService(workingDirectory: agent.directory)
            let _ = agentJJ.detectVCS()

            do {
                let files = try await agentJJ.diffSummary()
                if let idx = activeAgents.firstIndex(where: { $0.id == agentId }) {
                    activeAgents[idx].filesChanged = files
                }
            } catch {
                // Agent workspace may not be ready yet
            }
        }

        // Stop polling if no running agents
        if !activeAgents.contains(where: { $0.status == .running }) {
            stopPolling()
        }
    }

    // MARK: - Helpers

    private func makeSlug(from task: String) -> String {
        let words = task.lowercased()
            .components(separatedBy: .alphanumerics.inverted)
            .filter { !$0.isEmpty }
            .prefix(4)
        let slug = "agent-" + words.joined(separator: "-")
        // Ensure uniqueness
        if activeAgents.contains(where: { $0.id == slug }) {
            return slug + "-\(Int.random(in: 100...999))"
        }
        return slug
    }

    private func runSetupCommand(_ command: String, in directory: URL) async throws {
        try await Task.detached {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/sh")
            process.arguments = ["-c", command]
            process.currentDirectoryURL = directory
            process.environment = ProcessInfo.processInfo.environment

            let stdout = Pipe()
            let stderr = Pipe()
            process.standardOutput = stdout
            process.standardError = stderr

            try process.run()
            let stdoutTask = Task<Data, Never> {
                stdout.fileHandleForReading.readDataToEndOfFile()
            }
            let stderrTask = Task<Data, Never> {
                stderr.fileHandleForReading.readDataToEndOfFile()
            }

            process.waitUntilExit()

            let _ = await stdoutTask.value
            let stderrData = await stderrTask.value

            if process.terminationStatus != 0 {
                let errorOutput = String(data: stderrData, encoding: .utf8) ?? ""
                throw JJError.commandFailed("Setup command failed: \(command)\n\(errorOutput)")
            }
        }.value
    }

    private func runTestCommand(_ command: String, in directory: URL) async -> TestResult {
        let start = Date()
        let wd = directory

        return await Task.detached {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/sh")
            process.arguments = ["-c", command]
            process.currentDirectoryURL = wd
            process.environment = ProcessInfo.processInfo.environment

            let stdout = Pipe()
            let stderr = Pipe()
            process.standardOutput = stdout
            process.standardError = stderr

            do {
                try process.run()
                let stdoutTask = Task<Data, Never> {
                    stdout.fileHandleForReading.readDataToEndOfFile()
                }
                let stderrTask = Task<Data, Never> {
                    stderr.fileHandleForReading.readDataToEndOfFile()
                }

                process.waitUntilExit()

                let stdoutData = await stdoutTask.value
                let stderrData = await stderrTask.value
                let output = (String(data: stdoutData, encoding: .utf8) ?? "") +
                             (String(data: stderrData, encoding: .utf8) ?? "")
                let duration = Date().timeIntervalSince(start)

                return TestResult(
                    passed: process.terminationStatus == 0,
                    output: output,
                    duration: duration,
                    command: command
                )
            } catch {
                let duration = Date().timeIntervalSince(start)
                return TestResult(
                    passed: false,
                    output: error.localizedDescription,
                    duration: duration,
                    command: command
                )
            }
        }.value
    }

    private func ensureMergeWorkspace() async throws -> JJService {
        if let mergeWorkspaceService {
            return mergeWorkspaceService
        }
        let basePath = preferences.agentWorkspaceBasePath.map { URL(fileURLWithPath: $0) }
            ?? mainWorkspace.deletingLastPathComponent()
        let mergePath = basePath.appendingPathComponent("smithers-merge")
        let mergeJJ = JJService(workingDirectory: mergePath)
        if mergeJJ.detectVCS() == .none {
            _ = try await jjService.workspaceAdd(
                path: mergePath.path,
                revision: "trunk()",
                description: "smithers: merge workspace"
            )
            _ = mergeJJ.detectVCS()
        }
        mergeWorkspaceService = mergeJJ
        return mergeJJ
    }

    private func startAgentEventListener(agentId: String, codexService: CodexService) {
        agentEventTasks[agentId]?.cancel()
        agentEventTasks[agentId] = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                self.agentEventTasks[agentId] = nil
            }
            for await event in codexService.events {
                await self.handleAgentEvent(event, agentId: agentId)
            }
        }
    }

    private func handleAgentEvent(_ event: CodexEvent, agentId: String) async {
        func matchesTurn(_ turnId: String) -> Bool {
            if agentActiveTurnIds[agentId] == nil {
                agentActiveTurnIds[agentId] = turnId
                return true
            }
            return agentActiveTurnIds[agentId] == turnId
        }

        switch event {
        case .turnStarted(let turnId):
            _ = matchesTurn(turnId)
        case .turnCompleted(let turnId, let status):
            guard matchesTurn(turnId) else { return }
            agentActiveTurnIds[agentId] = nil
            if status == "completed" {
                if let agent = activeAgents.first(where: { $0.id == agentId }) {
                    await agentCompleted(agent)
                }
            } else {
                await markAgentFailed(agentId: agentId, reason: status)
            }
        case .error(let message):
            await markAgentFailed(agentId: agentId, reason: message)
        default:
            break
        }
    }

    private func markAgentFailed(agentId: String, reason: String?) async {
        guard let idx = activeAgents.firstIndex(where: { $0.id == agentId }) else { return }
        activeAgents[idx].status = .failed
        try? await snapshotStore.updateAgentStatus(id: agentId, status: .failed, testOutput: reason)
        try? await snapshotStore.logMergeQueueAction(agentId: agentId, action: "failed", details: reason)
        stopAgentService(agentId: agentId)
    }

    private func stopAgentService(agentId: String) {
        if let codex = agentCodexServices[agentId] {
            codex.stop()
            agentCodexServices.removeValue(forKey: agentId)
        }
        agentEventTasks[agentId]?.cancel()
        agentEventTasks.removeValue(forKey: agentId)
        agentActiveTurnIds.removeValue(forKey: agentId)
    }
}

// MARK: - JJService Extension for Merge

extension JJService {
    func runMerge(trunk: String, changeId: String) async throws -> JJChange {
        _ = try await runJJ(["new", trunk, changeId])
        let output = try await runJJ([
            "log", "--no-graph", "-r", "@",
            "-T", Self.changeTemplate
        ])
        return try parseChange(output)
    }
}
