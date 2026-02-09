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
        case invalidNvimPath(String)

        var errorDescription: String? {
            switch self {
            case .connectTimeout:
                return "Timed out connecting to Neovim"
            case .invalidResponse:
                return "Invalid response from Neovim"
            case .missingNvim:
                return "Neovim (nvim) not found on PATH."
            case .invalidNvimPath(let path):
                return "Neovim not executable at path: \(path)"
            }
        }
    }

    private struct GridSize: Equatable {
        let width: Int
        let height: Int
    }

    private struct GridPosition: Equatable {
        let row: Double
        let col: Double
    }

    private enum WindowAnchor: String {
        case northWest = "NW"
        case northEast = "NE"
        case southWest = "SW"
        case southEast = "SE"
    }

    private struct FloatingAnchorInfo: Equatable {
        let anchor: WindowAnchor
        let anchorGrid: Int64
        let anchorRow: Double
        let anchorCol: Double
        let zIndex: Int
        let screenRow: Double?
        let screenCol: Double?
    }

    private struct FloatingWindowState: Equatable {
        let gridId: Int64
        var size: GridSize?
        var anchor: FloatingAnchorInfo?
        var position: GridPosition?
        var visible: Bool
    }

    private let rpc = NvimRPC()
    private weak var workspace: WorkspaceState?
    private let socketPath: String
    private let logFilePath: String?
    private(set) var terminalView: GhosttyTerminalView
    private var notificationsTask: Task<Void, Never>?
    private var isRunning = false
    private var isReady = false
    private var bufferByURL: [URL: Int64] = [:]
    private var urlByBuffer: [Int64: URL] = [:]
    private var uiAttached = false
    private var uiAttachInFlight = false
    private var lastUiSize: (columns: Int, rows: Int)?
    private var gridMetricsObserver: UUID?
    private var gridSizes: [Int64: GridSize] = [:]
    private var gridPositions: [Int64: GridPosition] = [1: GridPosition(row: 0, col: 0)]
    private var floatingWindows: [Int64: FloatingWindowState] = [:]
    private var lastPublishedFloatingWindows: [NvimFloatingWindow] = []
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

    init(
        workspace: WorkspaceState,
        ghosttyApp: GhosttyApp,
        workingDirectory: String,
        nvimPath: String,
        optionAsMeta: OptionAsMeta,
        logFilePath: String? = nil
    ) {
        self.workspace = workspace
        let socketURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("smithers-nvim-\(UUID().uuidString).sock")
        socketPath = socketURL.path
        self.logFilePath = logFilePath
        let command = Self.buildCommand(
            nvimPath: nvimPath,
            socketPath: socketPath,
            logFilePath: logFilePath
        )
        terminalView = GhosttyTerminalView(
            app: ghosttyApp,
            workingDirectory: workingDirectory,
            command: command,
            optionAsMeta: optionAsMeta
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
        startGridMetricsObservation()
        try await attachUiIfNeeded()
        isRunning = true
        scheduleInitialSync()
    }

    func stop() {
        notificationsTask?.cancel()
        notificationsTask = nil
        stopGridMetricsObservation()
        detachUiIfNeeded()
        rpc.disconnect()
        bufferByURL.removeAll()
        urlByBuffer.removeAll()
        clearFloatingWindowState()
        isRunning = false
        isReady = false
        terminalView.shutdown()
        try? FileManager.default.removeItem(atPath: socketPath)
    }

    private func startGridMetricsObservation() {
        guard gridMetricsObserver == nil else { return }
        gridMetricsObserver = terminalView.addGridMetricsObserver { [weak self] metrics in
            self?.handleGridMetricsChange(metrics)
        }
    }

    private func stopGridMetricsObservation() {
        guard let token = gridMetricsObserver else { return }
        terminalView.removeGridMetricsObserver(token)
        gridMetricsObserver = nil
    }

    private func handleGridMetricsChange(_ metrics: GhosttyGridMetrics) {
        workspace?.handleNvimGridMetrics(metrics)
        let size = (columns: metrics.columns, rows: metrics.rows)
        if uiAttached {
            if lastUiSize?.columns != size.columns || lastUiSize?.rows != size.rows {
                lastUiSize = size
                Task { [weak self] in
                    guard let self else { return }
                    _ = try? await self.rpc.request(
                        "nvim_ui_try_resize",
                        params: [.int(Int64(size.columns)), .int(Int64(size.rows))]
                    )
                }
            }
            return
        }

        Task { [weak self] in
            try? await self?.attachUiIfNeeded()
        }
    }

    private func attachUiIfNeeded() async throws {
        guard !uiAttached, !uiAttachInFlight else { return }
        guard let metrics = terminalView.gridMetrics() else { return }
        uiAttachInFlight = true
        defer { uiAttachInFlight = false }
        let options: [String: MsgPackValue] = [
            "rgb": .bool(true),
            "ext_multigrid": .bool(true),
            "ext_linegrid": .bool(true),
            "ext_hlstate": .bool(true),
            "ext_cmdline": .bool(true),
            "ext_popupmenu": .bool(true),
            "ext_messages": .bool(true),
        ]
        _ = try await rpc.request(
            "nvim_ui_attach",
            params: [
                .int(Int64(metrics.columns)),
                .int(Int64(metrics.rows)),
                .map(options),
            ]
        )
        uiAttached = true
        lastUiSize = (columns: metrics.columns, rows: metrics.rows)
    }

    private func detachUiIfNeeded() {
        guard uiAttached else { return }
        uiAttached = false
        uiAttachInFlight = false
        lastUiSize = nil
        Task { [weak self] in
            guard let self else { return }
            _ = try? await self.rpc.request("nvim_ui_detach", params: [])
        }
    }

    private func clearFloatingWindowState() {
        gridSizes.removeAll()
        gridPositions = [1: GridPosition(row: 0, col: 0)]
        floatingWindows.removeAll()
        lastPublishedFloatingWindows = []
        workspace?.setNvimFloatingWindows([])
    }

    func setGlobalVariables(_ variables: [String: MsgPackValue]) async {
        guard !variables.isEmpty else { return }
        await waitUntilReady()
        let script = """
        local vars = ...
        for key, value in pairs(vars) do
          vim.g[key] = value
        end
        """
        _ = try? await rpc.request("nvim_exec_lua", params: [.string(script), .array([.map(variables)])])
    }

    func setOptions(_ options: [String: MsgPackValue]) async {
        guard !options.isEmpty else { return }
        await waitUntilReady()
        let script = """
        local opts = ...
        for key, value in pairs(opts) do
          vim.o[key] = value
        end
        """
        _ = try? await rpc.request("nvim_exec_lua", params: [.string(script), .array([.map(options)])])
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

    func listModifiedBuffersInTab(containing url: URL) async throws -> [NvimModifiedBuffer] {
        await waitUntilReady()
        let normalizedURL = url.standardizedFileURL
        let path = normalizedURL.path
        let buf = bufferByURL[normalizedURL] ?? 0
        let script = """
        local path, buf = ...
        if buf == 0 then
          buf = vim.fn.bufnr(path)
        end
        if buf == 0 then
          return {}
        end

        local function maybe_add(out, seen, target)
          if seen[target] then
            return
          end
          seen[target] = true
          if vim.api.nvim_buf_is_loaded(target) and vim.bo[target].modified then
            local name = vim.api.nvim_buf_get_name(target)
            local listed = vim.bo[target].buflisted
            table.insert(out, { buf = target, name = name, listed = listed })
          end
        end

        local tab_to_close = nil
        for _, tab in ipairs(vim.api.nvim_list_tabpages()) do
          for _, win in ipairs(vim.api.nvim_tabpage_list_wins(tab)) do
            if vim.api.nvim_win_get_buf(win) == buf then
              tab_to_close = tab
              break
            end
          end
          if tab_to_close then break end
        end

        local out = {}
        local seen = {}
        if tab_to_close == nil then
          maybe_add(out, seen, buf)
          return out
        end

        for _, win in ipairs(vim.api.nvim_tabpage_list_wins(tab_to_close)) do
          local wbuf = vim.api.nvim_win_get_buf(win)
          maybe_add(out, seen, wbuf)
        end
        return out
        """
        let params: [MsgPackValue] = [
            .string(path),
            .int(buf),
        ]
        let response = try await rpc.request("nvim_exec_lua", params: [.string(script), .array(params)])
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

    func scrollToTopLine(_ topLine: Int) async {
        await waitUntilReady()
        let script = """
        local top = ...
        local win = vim.api.nvim_get_current_win()
        local buf = vim.api.nvim_win_get_buf(win)
        local total = vim.api.nvim_buf_line_count(buf)
        local height = vim.api.nvim_win_get_height(win)
        local max_top = math.max(1, total - height + 1)
        top = math.min(max_top, math.max(1, math.floor(top)))
        local view = vim.fn.winsaveview()
        view.topline = top
        vim.fn.winrestview(view)
        """
        let params: [MsgPackValue] = [.int(Int64(topLine))]
        _ = try? await rpc.request("nvim_exec_lua", params: [.string(script), .array(params)])
    }

    func scrollByLines(_ delta: Int) async {
        await waitUntilReady()
        let script = """
        local delta = ...
        local win = vim.api.nvim_get_current_win()
        local buf = vim.api.nvim_win_get_buf(win)
        local total = vim.api.nvim_buf_line_count(buf)
        local height = vim.api.nvim_win_get_height(win)
        local view = vim.fn.winsaveview()
        local max_top = math.max(1, total - height + 1)
        local target = math.min(max_top, math.max(1, view.topline + delta))
        view.topline = target
        vim.fn.winrestview(view)
        """
        let params: [MsgPackValue] = [.int(Int64(delta))]
        _ = try? await rpc.request("nvim_exec_lua", params: [.string(script), .array(params)])
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
            self.workspace?.handleNvimReady()
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

        local function emit_mode()
          local mode = vim.api.nvim_get_mode().mode
          vim.rpcnotify(chan, "smithers/mode", { mode = mode })
        end

        local function emit_viewport()
          local win = vim.api.nvim_get_current_win()
          if win == nil or win == 0 then
            return
          end
          local buf = vim.api.nvim_win_get_buf(win)
          if buf == nil or buf == 0 then
            return
          end
          local topline = 1
          local botline = 1
          vim.api.nvim_win_call(win, function()
            topline = vim.fn.line("w0")
            botline = vim.fn.line("w$")
          end)
          local linecount = vim.api.nvim_buf_line_count(buf)
          vim.rpcnotify(chan, "smithers/viewport", {
            win = win,
            buf = buf,
            topline = topline,
            botline = botline,
            linecount = linecount,
          })
        end

        vim.api.nvim_create_autocmd({ "BufEnter", "BufAdd" }, {
          group = group,
          callback = function(args)
            emit("enter", args.buf)
            emit_viewport()
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
            emit_viewport()
          end,
        })

        vim.api.nvim_create_autocmd({ "BufModifiedSet" }, {
          group = group,
          callback = function(args)
            local name = vim.api.nvim_buf_get_name(args.buf)
            local listed = vim.bo[args.buf].buflisted
            local modified = vim.bo[args.buf].modified
            vim.rpcnotify(chan, "smithers/buf", { event = "modified", buf = args.buf, name = name, listed = listed, modified = modified })
            emit_viewport()
          end,
        })

        vim.api.nvim_create_autocmd({ "ModeChanged" }, {
          group = group,
          callback = function()
            emit_mode()
          end,
        })

        vim.api.nvim_create_autocmd({ "WinEnter", "BufWinEnter", "WinScrolled", "CursorMoved", "CursorMovedI", "VimResized" }, {
          group = group,
          callback = function()
            emit_viewport()
          end,
        })

        vim.api.nvim_create_autocmd({ "ColorScheme" }, {
          group = group,
          callback = function()
            local name = vim.g.colors_name or ""
            vim.rpcnotify(chan, "smithers/colorscheme", { name = name })
          end,
        })

        emit_mode()
        emit_viewport()
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
        if method == "redraw" {
            handleRedraw(params: params)
            return
        }
        if method == "smithers/colorscheme" {
            await refreshColorscheme(reason: "colorscheme")
            return
        }
        if method == "smithers/mode" {
            guard let payload = params.first?.mapValue,
                  let mode = payload["mode"]?.stringValue else { return }
            workspace?.handleNvimModeChange(rawMode: mode)
            return
        }
        if method == "smithers/viewport" {
            guard let payload = params.first?.mapValue else { return }
            let topLine = parseInt(payload["topline"]) ?? 1
            let bottomLine = parseInt(payload["botline"]) ?? topLine
            let lineCount = parseInt(payload["linecount"]) ?? bottomLine
            workspace?.handleNvimViewport(
                topLine: Int(topLine),
                bottomLine: Int(bottomLine),
                lineCount: Int(lineCount)
            )
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

    private func handleRedraw(params: [MsgPackValue]) {
        var needsFloatingUpdate = false

        for event in params {
            guard case let .array(values) = event else { continue }
            guard let name = values.first?.stringValue else { continue }
            let tuples = values.dropFirst()

            switch name {
            case "grid_resize":
                for tuple in tuples {
                    guard case let .array(items) = tuple, items.count >= 3 else { continue }
                    guard let gridId = parseInt(items[0]),
                          let width = parseInt(items[1]),
                          let height = parseInt(items[2]) else { continue }
                    let size = GridSize(width: Int(width), height: Int(height))
                    gridSizes[gridId] = size
                    if var state = floatingWindows[gridId] {
                        state.size = size
                        floatingWindows[gridId] = state
                        needsFloatingUpdate = true
                    }
                }
            case "grid_destroy":
                for tuple in tuples {
                    guard case let .array(items) = tuple, items.count >= 1 else { continue }
                    guard let gridId = parseInt(items[0]) else { continue }
                    gridSizes.removeValue(forKey: gridId)
                    gridPositions.removeValue(forKey: gridId)
                    if floatingWindows.removeValue(forKey: gridId) != nil {
                        needsFloatingUpdate = true
                    }
                }
            case "win_pos":
                for tuple in tuples {
                    guard case let .array(items) = tuple, items.count >= 4 else { continue }
                    guard let gridId = parseInt(items[0]),
                          let startRow = parseDouble(items[2]),
                          let startCol = parseDouble(items[3]) else { continue }
                    gridPositions[gridId] = GridPosition(row: startRow, col: startCol)
                    needsFloatingUpdate = true
                }
            case "win_float_pos":
                for tuple in tuples {
                    guard case let .array(items) = tuple, items.count >= 8 else { continue }
                    guard let gridId = parseInt(items[0]) else { continue }
                    guard let anchorString = items[2].stringValue,
                          let anchor = WindowAnchor(rawValue: anchorString) else { continue }
                    let anchorGrid = parseInt(items[3]) ?? 1
                    let anchorRow = parseDouble(items[4]) ?? 0
                    let anchorCol = parseDouble(items[5]) ?? 0
                    let zIndex = Int(parseInt(items[7]) ?? 0)

                    var screenRow: Double?
                    var screenCol: Double?
                    if items.count >= 11,
                       let row = parseDouble(items[9]),
                       let col = parseDouble(items[10]),
                       row >= 0, col >= 0 {
                        screenRow = row
                        screenCol = col
                    }

                    let anchorInfo = FloatingAnchorInfo(
                        anchor: anchor,
                        anchorGrid: anchorGrid,
                        anchorRow: anchorRow,
                        anchorCol: anchorCol,
                        zIndex: zIndex,
                        screenRow: screenRow,
                        screenCol: screenCol
                    )

                    var state = floatingWindows[gridId] ?? FloatingWindowState(
                        gridId: gridId,
                        size: gridSizes[gridId],
                        anchor: nil,
                        position: nil,
                        visible: true
                    )
                    state.anchor = anchorInfo
                    state.visible = true
                    if let size = gridSizes[gridId] {
                        state.size = size
                    }
                    floatingWindows[gridId] = state
                    needsFloatingUpdate = true
                }
            case "win_hide", "win_close":
                for tuple in tuples {
                    guard case let .array(items) = tuple, items.count >= 1 else { continue }
                    guard let gridId = parseInt(items[0]) else { continue }
                    gridPositions.removeValue(forKey: gridId)
                    if floatingWindows.removeValue(forKey: gridId) != nil {
                        needsFloatingUpdate = true
                    }
                }
            case "cmdline_show":
                for tuple in tuples {
                    guard case let .array(items) = tuple else { continue }
                    let chunks = parseTextChunks(items.first)
                    let pos = Int(max(0, parseInt(items.count > 1 ? items[1] : nil) ?? 0))
                    let firstc = parseFirstc(items.count > 2 ? items[2] : nil)
                    let prompt = items.count > 3 ? (items[3].stringValue ?? "") : ""
                    let indent = Int(max(0, parseInt(items.count > 4 ? items[4] : nil) ?? 0))
                    let level = Int(max(0, parseInt(items.count > 5 ? items[5] : nil) ?? 0))
                    let state = NvimCmdlineState(
                        isVisible: true,
                        level: level,
                        prompt: prompt,
                        firstc: firstc,
                        indent: indent,
                        cursorPos: pos,
                        chunks: chunks
                    )
                    workspace?.handleNvimCmdlineShow(state)
                }
            case "cmdline_pos":
                for tuple in tuples {
                    guard case let .array(items) = tuple else { continue }
                    guard let pos = parseInt(items.first) else { continue }
                    let level = Int(max(0, parseInt(items.count > 1 ? items[1] : nil) ?? 0))
                    workspace?.handleNvimCmdlinePos(Int(pos), level: level)
                }
            case "cmdline_hide":
                workspace?.handleNvimCmdlineHide()
            case "popupmenu_show":
                for tuple in tuples {
                    guard case let .array(items) = tuple, items.count >= 5 else { continue }
                    let menuItems = parsePopupmenuItems(items[0])
                    let selected = Int(parseInt(items[1]) ?? -1)
                    let row = Int(parseInt(items[2]) ?? 0)
                    let col = Int(parseInt(items[3]) ?? 0)
                    let grid = Int(parseInt(items[4]) ?? 0)
                    let state = NvimPopupMenuState(
                        isVisible: true,
                        items: menuItems,
                        selected: selected,
                        row: row,
                        col: col,
                        grid: grid
                    )
                    workspace?.handleNvimPopupmenuShow(state)
                }
            case "popupmenu_select":
                for tuple in tuples {
                    guard case let .array(items) = tuple, let selected = parseInt(items.first) else { continue }
                    workspace?.handleNvimPopupmenuSelect(Int(selected))
                }
            case "popupmenu_hide":
                workspace?.handleNvimPopupmenuHide()
            case "msg_show":
                for tuple in tuples {
                    guard case let .array(items) = tuple else { continue }
                    let kind = items.first?.stringValue ?? ""
                    let chunks = parseTextChunks(items.count > 1 ? items[1] : nil)
                    let replaceLast = parseBool(items.count > 2 ? items[2] : nil) ?? false
                    workspace?.handleNvimMessageShow(kind: kind, chunks: chunks, replaceLast: replaceLast)
                }
            case "msg_clear":
                workspace?.handleNvimMessageClear()
            case "msg_showmode":
                for tuple in tuples {
                    guard case let .array(items) = tuple else { continue }
                    let chunks = parseTextChunks(items.first)
                    workspace?.handleNvimMessageShowMode(chunks)
                }
            case "msg_showcmd":
                for tuple in tuples {
                    guard case let .array(items) = tuple else { continue }
                    let chunks = parseTextChunks(items.first)
                    workspace?.handleNvimMessageShowCmd(chunks)
                }
            case "msg_ruler":
                for tuple in tuples {
                    guard case let .array(items) = tuple else { continue }
                    let chunks = parseTextChunks(items.first)
                    workspace?.handleNvimMessageRuler(chunks)
                }
            case "flush":
                if needsFloatingUpdate {
                    publishFloatingWindowsIfNeeded()
                    needsFloatingUpdate = false
                }
            default:
                continue
            }
        }

        if needsFloatingUpdate {
            publishFloatingWindowsIfNeeded()
        }
    }

    private func publishFloatingWindowsIfNeeded() {
        var windows: [NvimFloatingWindow] = []
        windows.reserveCapacity(floatingWindows.count)

        for state in floatingWindows.values where state.visible {
            guard let size = state.size,
                  size.width > 0, size.height > 0,
                  let anchor = state.anchor,
                  let position = computeFloatingPosition(anchor: anchor, size: size) else {
                continue
            }
            windows.append(NvimFloatingWindow(
                id: state.gridId,
                row: position.row,
                col: position.col,
                width: size.width,
                height: size.height,
                zIndex: anchor.zIndex
            ))
        }

        windows.sort {
            if $0.zIndex == $1.zIndex { return $0.id < $1.id }
            return $0.zIndex < $1.zIndex
        }

        if windows != lastPublishedFloatingWindows {
            lastPublishedFloatingWindows = windows
            workspace?.setNvimFloatingWindows(windows)
        }
    }

    private func computeFloatingPosition(anchor: FloatingAnchorInfo, size: GridSize) -> GridPosition? {
        if let screenRow = anchor.screenRow, let screenCol = anchor.screenCol {
            return GridPosition(row: max(0, screenRow), col: max(0, screenCol))
        }

        let base = gridPositions[anchor.anchorGrid] ?? GridPosition(row: 0, col: 0)
        var row = base.row + anchor.anchorRow
        var col = base.col + anchor.anchorCol

        switch anchor.anchor {
        case .northWest:
            break
        case .northEast:
            col -= Double(size.width)
        case .southWest:
            row -= Double(size.height)
        case .southEast:
            row -= Double(size.height)
            col -= Double(size.width)
        }

        if row < 0 { row = 0 }
        if col < 0 { col = 0 }
        return GridPosition(row: row, col: col)
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

    private func parseInt(_ value: MsgPackValue?) -> Int64? {
        if let intValue = value?.intValue {
            return intValue
        }
        if let doubleValue = value?.doubleValue {
            return Int64(doubleValue)
        }
        if let stringValue = value?.stringValue, let parsed = Int64(stringValue) {
            return parsed
        }
        return nil
    }

    private func parseDouble(_ value: MsgPackValue?) -> Double? {
        if let doubleValue = value?.doubleValue {
            return doubleValue
        }
        if let intValue = value?.intValue {
            return Double(intValue)
        }
        if let stringValue = value?.stringValue, let parsed = Double(stringValue) {
            return parsed
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

    private static func buildCommand(nvimPath: String, socketPath: String, logFilePath: String?) -> String {
        var parts: [String] = []
        if let logFilePath, !logFilePath.isEmpty {
            parts.append("env")
            parts.append("NVIM_LOG_FILE=\(shellEscape(logFilePath))")
            parts.append("NVIM_LOG_LEVEL=INFO")
        }
        parts.append(shellEscape(nvimPath))
        parts.append("--listen")
        parts.append(shellEscape(socketPath))
        return parts.joined(separator: " ")
    }

    private static func shellEscape(_ value: String) -> String {
        if value.isEmpty { return "''" }
        let escaped = value.replacingOccurrences(of: "'", with: "'\\''")
        return "'\(escaped)'"
    }
}
