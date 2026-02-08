import Foundation
import AppKit

struct NvimModifiedBuffer: Hashable {
    let buffer: Int64
    let name: String
    let listed: Bool
    let url: URL?
}

@MainActor
final class NvimController {
    enum ControllerError: Error, LocalizedError {
        case connectTimeout
        case invalidResponse
        case missingNvim

        var errorDescription: String? {
            switch self {
            case .connectTimeout:
                return "Timed out connecting to Neovim"
            case .invalidResponse:
                return "Invalid response from Neovim"
            case .missingNvim:
                return "Neovim (nvim) not found on PATH."
            }
        }
    }

    private let rpc = NvimRPC()
    private weak var workspace: WorkspaceState?
    private let socketPath: String
    private(set) var terminalView: GhosttyTerminalView
    private var notificationsTask: Task<Void, Never>?
    private var isRunning = false
    private var isReady = false
    private var bufferByURL: [URL: Int64] = [:]
    private var urlByBuffer: [Int64: URL] = [:]
    private static let highlightGroups: [String] = [
        "Normal",
        "TabLine",
        "TabLineSel",
        "TabLineFill",
        "StatusLine",
        "StatusLineNC",
        "WinSeparator",
        "VertSplit",
        "NormalFloat",
        "FloatBorder",
        "Pmenu",
        "PmenuSel",
        "Visual",
        "CursorLine",
        "LineNr",
        "CursorLineNr",
    ]

    init(workspace: WorkspaceState, ghosttyApp: GhosttyApp, workingDirectory: String, nvimPath: String) {
        self.workspace = workspace
        let socketURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("smithers-nvim-\(UUID().uuidString).sock")
        socketPath = socketURL.path
        let command = "\(Self.shellEscape(nvimPath)) --listen \(Self.shellEscape(socketPath))"
        terminalView = GhosttyTerminalView(
            app: ghosttyApp,
            workingDirectory: workingDirectory,
            command: command
        )
    }

    deinit {
        notificationsTask?.cancel()
        rpc.disconnect()
        try? FileManager.default.removeItem(atPath: socketPath)
    }

    func start() async throws {
        guard !isRunning else { return }
        try await connectWithRetry()
        let channelId = try await fetchChannelId()
        try await installAutocmds(channelId: channelId)
        startNotificationLoop()
        isRunning = true
        scheduleInitialSync()
    }

    func stop() {
        notificationsTask?.cancel()
        notificationsTask = nil
        rpc.disconnect()
        bufferByURL.removeAll()
        urlByBuffer.removeAll()
        isRunning = false
        isReady = false
        terminalView.shutdown()
        try? FileManager.default.removeItem(atPath: socketPath)
    }

    // FIX 3: The Lua script's nil check used `line ~= nil`, but MsgPack null
    // arrives in Lua as vim.NIL (userdata), not Lua nil. So the check passed
    // and math.max(1, <userdata>) crashed. Fixed to use type(line) == "number".
    func openFile(_ url: URL, line: Int? = nil, column: Int? = nil) async throws {
        WorkspaceState.debugLog("[NvimController] openFile: \(url.lastPathComponent), isReady=\(isReady)")
        await waitUntilReady()
        WorkspaceState.debugLog("[NvimController] openFile: waitUntilReady done, isReady=\(isReady)")
        let normalizedURL = url.standardizedFileURL
        let path = normalizedURL.path
        let script = """
        local path, line, col = ...
        local esc = vim.fn.fnameescape(path)

        -- Check if the file is already open in some window/tab.
        local buf = vim.fn.bufnr(path, false)
        local found = false
        if buf > 0 then
          for _, tab in ipairs(vim.api.nvim_list_tabpages()) do
            for _, win in ipairs(vim.api.nvim_tabpage_list_wins(tab)) do
              if vim.api.nvim_win_get_buf(win) == buf then
                vim.api.nvim_set_current_tabpage(tab)
                vim.api.nvim_set_current_win(win)
                found = true
                break
              end
            end
            if found then break end
          end
        end

        if not found then
          -- If the current buffer is unlisted/unmodified (e.g. dashboard), replace it;
          -- otherwise open a new tab.
          local cur = vim.api.nvim_get_current_buf()
          local cur_listed = vim.bo[cur].buflisted
          local cur_modified = vim.bo[cur].modified
          if not cur_listed and not cur_modified then
            vim.cmd("edit " .. esc)
          else
            vim.cmd("tabedit " .. esc)
          end
        end

        if type(line) == "number" then
          local l = math.max(1, line)
          local c = math.max(1, type(col) == "number" and col or 1) - 1
          pcall(vim.api.nvim_win_set_cursor, 0, { l, c })
        end
        """
        let params: [MsgPackValue] = [
            .string(path),
            line.map { .int(Int64($0)) } ?? .null,
            column.map { .int(Int64($0)) } ?? .null,
        ]
        _ = try await rpc.request("nvim_exec_lua", params: [.string(script), .array(params)])
    }

    func closeFile(_ url: URL, force: Bool = false) async {
        let normalizedURL = url.standardizedFileURL
        let path = normalizedURL.path
        let buf = bufferByURL[normalizedURL] ?? 0
        let script = """
        local path, buf, force = ...
        if buf == 0 then
          buf = vim.fn.bufnr(path)
        end
        if buf == 0 then
          return
        end

        local tabs = vim.api.nvim_list_tabpages()
        local tab_to_close = nil
        for _, tab in ipairs(tabs) do
          for _, win in ipairs(vim.api.nvim_tabpage_list_wins(tab)) do
            if vim.api.nvim_win_get_buf(win) == buf then
              tab_to_close = tab
              break
            end
          end
          if tab_to_close then
            break
          end
        end

        if tab_to_close ~= nil and #tabs > 1 then
          local current = vim.api.nvim_get_current_tabpage()
          vim.api.nvim_set_current_tabpage(tab_to_close)
          local cmd = force and "tabclose!" or "tabclose"
          pcall(vim.cmd, cmd)
          if current ~= tab_to_close and vim.api.nvim_tabpage_is_valid(current) then
            pcall(vim.api.nvim_set_current_tabpage, current)
          end
        end

        pcall(vim.api.nvim_buf_delete, buf, { force = force })
        """
        let params: [MsgPackValue] = [
            .string(path),
            .int(buf),
            .bool(force),
        ]
        _ = try? await rpc.request("nvim_exec_lua", params: [.string(script), .array(params)])
    }

    func listModifiedBuffers() async throws -> [NvimModifiedBuffer] {
        await waitUntilReady()
        let script = """
        local out = {}
        for _, buf in ipairs(vim.api.nvim_list_bufs()) do
          if vim.api.nvim_buf_is_loaded(buf) and vim.bo[buf].modified then
            local name = vim.api.nvim_buf_get_name(buf)
            local listed = vim.bo[buf].buflisted
            table.insert(out, { buf = buf, name = name, listed = listed })
          end
        end
        return out
        """
        let response = try await rpc.request("nvim_exec_lua", params: [.string(script), .array([])])
        return parseModifiedBuffers(response)
    }

    func saveCurrent() async throws {
        await waitUntilReady()
        _ = try await rpc.request("nvim_command", params: [.string("write")])
    }

    func saveAll() async throws {
        await waitUntilReady()
        _ = try await rpc.request("nvim_command", params: [.string("wall")])
    }

    private func connectWithRetry() async throws {
        var lastError: Error?
        for _ in 0..<200 {
            do {
                try await rpc.connect(to: socketPath)
                return
            } catch {
                lastError = error
                try await Task.sleep(nanoseconds: 100_000_000)
            }
        }
        throw lastError ?? ControllerError.connectTimeout
    }

    private func waitForVimEnter() async throws {
        if isReady { return }
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            if let didEnter = try? await getVimDidEnter(), didEnter {
                return
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    private func waitUntilReady(timeout: TimeInterval = 20) async {
        if isReady { return }
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if isReady { return }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
    }

    private func getVimDidEnter() async throws -> Bool {
        let value = try await rpc.request("nvim_get_vvar", params: [.string("vim_did_enter")])
        if let intValue = value.intValue {
            return intValue != 0
        }
        if let boolValue = value.boolValue {
            return boolValue
        }
        return false
    }

    private func scheduleInitialSync() {
        if isReady { return }
        Task { [weak self] in
            guard let self else { return }
            _ = try? await self.waitForVimEnter()
            WorkspaceState.debugLog("[NvimController] VimEnter done, sleeping 1.5s for plugins")
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            do {
                try await self.syncInitialBuffers()
                WorkspaceState.debugLog("[NvimController] syncInitialBuffers completed OK")
            } catch {
                WorkspaceState.debugLog("[NvimController] syncInitialBuffers error: \(error)")
            }
            await self.refreshColorscheme(reason: "initial")
            WorkspaceState.debugLog("[NvimController] setting isReady = true")
            self.isReady = true
            await self.syncModifiedBuffers()
        }
    }

    private func fetchChannelId() async throws -> Int64 {
        let info = try await rpc.request("nvim_get_api_info", params: [])
        guard case let .array(values) = info,
              let channelId = values.first?.intValue else {
            throw ControllerError.invalidResponse
        }
        return channelId
    }

    private func installAutocmds(channelId: Int64) async throws {
        let script = """
        local chan = ...
        local group = vim.api.nvim_create_augroup("Smithers", { clear = true })

        local function emit(event, buf)
          local name = vim.api.nvim_buf_get_name(buf)
          local listed = vim.bo[buf].buflisted
          vim.rpcnotify(chan, "smithers/buf", { event = event, buf = buf, name = name, listed = listed })
        end

        vim.api.nvim_create_autocmd({ "BufEnter", "BufAdd" }, {
          group = group,
          callback = function(args)
            emit("enter", args.buf)
          end,
        })

        vim.api.nvim_create_autocmd({ "BufDelete" }, {
          group = group,
          callback = function(args)
            vim.rpcnotify(chan, "smithers/buf", { event = "delete", buf = args.buf })
          end,
        })

        vim.api.nvim_create_autocmd({ "BufWritePost" }, {
          group = group,
          callback = function(args)
            emit("write", args.buf)
          end,
        })

        vim.api.nvim_create_autocmd({ "BufModifiedSet" }, {
          group = group,
          callback = function(args)
            local name = vim.api.nvim_buf_get_name(args.buf)
            local listed = vim.bo[args.buf].buflisted
            local modified = vim.bo[args.buf].modified
            vim.rpcnotify(chan, "smithers/buf", { event = "modified", buf = args.buf, name = name, listed = listed, modified = modified })
          end,
        })

        vim.api.nvim_create_autocmd({ "ColorScheme" }, {
          group = group,
          callback = function()
            local name = vim.g.colors_name or ""
            vim.rpcnotify(chan, "smithers/colorscheme", { name = name })
          end,
        })
        """

        _ = try await rpc.request(
            "nvim_exec_lua",
            params: [.string(script), .array([.int(channelId)])]
        )
    }

    private func startNotificationLoop() {
        notificationsTask?.cancel()
        notificationsTask = Task { [weak self] in
            guard let self else { return }
            for await (method, params) in self.rpc.notifications {
                if Task.isCancelled { break }
                await self.handleNotification(method: method, params: params)
            }
        }
    }

    private func handleNotification(method: String, params: [MsgPackValue]) async {
        if method == "smithers/colorscheme" {
            await refreshColorscheme(reason: "colorscheme")
            return
        }
        guard method == "smithers/buf" else { return }
        guard let payload = params.first?.mapValue else {
            WorkspaceState.debugLog("[NvimController] notification \(method): no map payload, raw: \(params)")
            return
        }
        guard let event = payload["event"]?.stringValue else { return }
        let buf = payload["buf"]?.intValue
        WorkspaceState.debugLog("[NvimController] notification: event=\(event) buf=\(buf ?? -1)")

        switch event {
        case "delete":
            handleBufferDelete(buf: buf)
        case "modified":
            guard let name = payload["name"]?.stringValue else { return }
            let listed = parseBool(payload["listed"]) ?? false
            let modified = parseBool(payload["modified"]) ?? false
            handleBufferModified(buf: buf, name: name, listed: listed, modified: modified)
        case "write":
            guard let name = payload["name"]?.stringValue else { return }
            if let url = urlFromBufferName(name) {
                workspace?.refreshFileTreeForNewFile(url)
            }
        default:
            let listedValue = payload["listed"]
            let listed: Bool
            if let b = listedValue?.boolValue {
                listed = b
            } else if let i = listedValue?.intValue {
                listed = i != 0
            } else {
                listed = false
            }
            guard listed else { return }
            guard let name = payload["name"]?.stringValue else { return }
            handleBufferEnter(buf: buf, name: name, select: true)
        }
    }

    private func handleBufferEnter(buf: Int64?, name: String, select: Bool) {
        guard let buf else { return }
        guard let url = urlFromBufferName(name) else { return }
        bufferByURL[url] = buf
        urlByBuffer[buf] = url
        workspace?.handleNvimBufferEnter(url: url, select: select)
    }

    private func handleBufferDelete(buf: Int64?) {
        guard let buf else { return }
        workspace?.handleNvimBufferDeleted(buffer: buf)
        guard let url = urlByBuffer.removeValue(forKey: buf) else { return }
        bufferByURL.removeValue(forKey: url)
        workspace?.handleNvimBufferDelete(url: url)
    }

    private func handleBufferModified(buf: Int64?, name: String, listed: Bool, modified: Bool) {
        guard let buf else { return }
        let url = urlFromBufferName(name)
        if let url {
            bufferByURL[url] = buf
            urlByBuffer[buf] = url
        }
        workspace?.handleNvimBufferModified(
            buffer: buf,
            name: name,
            listed: listed,
            url: url,
            modified: modified
        )
    }

    private func syncInitialBuffers() async throws {
        let buffers = try await rpc.request("nvim_list_bufs", params: [])
        guard case let .array(values) = buffers else { return }

        for value in values {
            guard let buf = value.intValue else { continue }
            let nameValue = try await rpc.request("nvim_buf_get_name", params: [.int(buf)])
            guard let name = nameValue.stringValue, !name.isEmpty else { continue }
            let listedValue = try await rpc.request(
                "nvim_buf_get_option",
                params: [.int(buf), .string("buflisted")]
            )
            let listed: Bool
            if let b = listedValue.boolValue {
                listed = b
            } else if let i = listedValue.intValue {
                listed = i != 0
            } else {
                continue
            }
            guard listed else { continue }
            handleBufferEnter(buf: buf, name: name, select: false)
        }

        let currentValue = try await rpc.request("nvim_get_current_buf", params: [])
        if let currentBuf = currentValue.intValue,
           let url = urlByBuffer[currentBuf] {
            workspace?.handleNvimBufferEnter(url: url, select: true)
        }
    }

    private func urlFromBufferName(_ name: String) -> URL? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard !trimmed.contains("://") else { return nil }
        let expanded = (trimmed as NSString).expandingTildeInPath
        if expanded.hasPrefix("/") {
            return URL(fileURLWithPath: expanded).standardizedFileURL
        }
        if let root = workspace?.rootDirectory {
            return URL(fileURLWithPath: expanded, relativeTo: root).standardizedFileURL
        }
        return URL(fileURLWithPath: expanded).standardizedFileURL
    }

    private func refreshColorscheme(reason: String) async {
        guard isRunning else { return }
        do {
            let highlights = try await fetchHighlightGroups()
            guard !highlights.isEmpty else { return }
            workspace?.applyNvimHighlights(highlights)
            WorkspaceState.debugLog("[NvimController] applied colorscheme (\(reason))")
        } catch {
            WorkspaceState.debugLog("[NvimController] refreshColorscheme error: \(error)")
        }
    }

    private func fetchHighlightGroups() async throws -> [String: NvimHighlightColors] {
        let script = """
        local names = ...
        local function to_hex(value)
          if value == nil or value == vim.NIL then
            return nil
          end
          return string.format("#%06x", value)
        end

        local function get_hl(name)
          local ok, hl
          if vim.api.nvim_get_hl then
            ok, hl = pcall(vim.api.nvim_get_hl, 0, { name = name, link = false })
            if ok and hl then
              return { fg = to_hex(hl.fg), bg = to_hex(hl.bg), sp = to_hex(hl.sp) }
            end
          end
          ok, hl = pcall(vim.api.nvim_get_hl_by_name, name, true)
          if ok and hl then
            return { fg = to_hex(hl.foreground), bg = to_hex(hl.background), sp = to_hex(hl.special) }
          end
          return {}
        end

        local out = {}
        if type(names) ~= "table" then
          return out
        end
        for _, name in ipairs(names) do
          out[name] = get_hl(name)
        end
        return out
        """
        let namesParam = MsgPackValue.array(Self.highlightGroups.map { .string($0) })
        let params: [MsgPackValue] = [namesParam]
        let response = try await rpc.request(
            "nvim_exec_lua",
            params: [.string(script), .array(params)]
        )
        return parseHighlightMap(response)
    }

    private func syncModifiedBuffers() async {
        do {
            let buffers = try await listModifiedBuffers()
            workspace?.setNvimModifiedBuffers(buffers)
        } catch {
            WorkspaceState.debugLog("[NvimController] syncModifiedBuffers error: \(error)")
        }
    }

    private func parseModifiedBuffers(_ value: MsgPackValue) -> [NvimModifiedBuffer] {
        guard case let .array(values) = value else { return [] }
        var buffers: [NvimModifiedBuffer] = []
        buffers.reserveCapacity(values.count)
        for entry in values {
            guard case let .map(map) = entry else { continue }
            let buf = map["buf"]?.intValue ?? 0
            let name = map["name"]?.stringValue ?? ""
            let listed = parseBool(map["listed"]) ?? false
            let url = urlFromBufferName(name)
            buffers.append(NvimModifiedBuffer(buffer: buf, name: name, listed: listed, url: url))
        }
        return buffers
    }

    private func parseBool(_ value: MsgPackValue?) -> Bool? {
        if let boolValue = value?.boolValue {
            return boolValue
        }
        if let intValue = value?.intValue {
            return intValue != 0
        }
        return nil
    }

    private func parseHighlightMap(_ value: MsgPackValue) -> [String: NvimHighlightColors] {
        guard case let .map(map) = value else { return [:] }
        var result: [String: NvimHighlightColors] = [:]
        result.reserveCapacity(map.count)
        for (name, entry) in map {
            guard case let .map(colorMap) = entry else { continue }
            let fg = colorMap["fg"]?.stringValue.flatMap(NSColor.fromHex)
            let bg = colorMap["bg"]?.stringValue.flatMap(NSColor.fromHex)
            let sp = colorMap["sp"]?.stringValue.flatMap(NSColor.fromHex)
            result[name] = NvimHighlightColors(fg: fg, bg: bg, sp: sp)
        }
        return result
    }

    static func locateNvimPath() -> String? {
        let fm = FileManager.default
        if let pathEnv = ProcessInfo.processInfo.environment["PATH"] {
            for part in pathEnv.split(separator: ":") {
                let candidate = URL(fileURLWithPath: String(part)).appendingPathComponent("nvim").path
                if fm.isExecutableFile(atPath: candidate) {
                    return candidate
                }
            }
        }

        let candidates = [
            "/opt/homebrew/bin/nvim",
            "/usr/local/bin/nvim",
            "/usr/bin/nvim"
        ]
        for candidate in candidates where fm.isExecutableFile(atPath: candidate) {
            return candidate
        }
        return nil
    }

    private static func shellEscape(_ value: String) -> String {
        if value.isEmpty { return "''" }
        let escaped = value.replacingOccurrences(of: "'", with: "'\\''")
        return "'\(escaped)'"
    }
}
