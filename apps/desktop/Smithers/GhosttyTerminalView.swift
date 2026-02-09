import AppKit
import QuartzCore
import GhosttyKit

struct GhosttyGridMetrics: Equatable {
    let columns: Int
    let rows: Int
    let cellSize: CGSize
    let origin: CGPoint
}

final class GhosttyTerminalView: NSView, ObservableObject, NSTextInputClient {
    @Published var title: String = "Terminal"
    @Published var pwd: String?
    @Published var cellSize: NSSize = .zero {
        didSet {
            notifyGridMetricsChange()
            smoothScrollController?.updateCellSize(cellSize)
        }
    }
    @Published var isHealthy: Bool = true

    var onClose: (() -> Void)?
    var onScrollActivity: (() -> Void)?
    weak var smoothScrollController: SmoothScrollController? {
        didSet {
            smoothScrollController?.updateCellSize(cellSize)
            smoothScrollController?.setOverlayView(smoothScrollOverlayView)
        }
    }
    weak var smoothScrollOverlayView: NSView? {
        didSet {
            smoothScrollController?.setOverlayView(smoothScrollOverlayView)
        }
    }
    private(set) var command: String?
    var optionAsMeta: OptionAsMeta = .both

    var surface: ghostty_surface_t?

    private var markedTextStorage = NSMutableAttributedString()
    private var keyTextAccumulator: [String]?
    private var tracking: NSTrackingArea?
    private var currentCursor: NSCursor = .iBeam
    private var lastContentSize: NSSize?
    private var windowObservers: [NSObjectProtocol] = []
    private var gridMetricsObservers: [UUID: (GhosttyGridMetrics) -> Void] = [:]
    private var lastRepeatTimestamp: TimeInterval = 0

    private lazy var frameScheduler = GhosttyFrameScheduler(drawHandler: { [weak self] in
        self?.drawFrame()
    })

    override var acceptsFirstResponder: Bool { true }

    init(app: GhosttyApp, workingDirectory: String?, command: String? = nil, optionAsMeta: OptionAsMeta = .both) {
        super.init(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
        wantsLayer = true

        self.command = command
        self.optionAsMeta = optionAsMeta
        guard let appHandle = app.app else { return }
        surface = createSurface(app: appHandle, workingDirectory: workingDirectory, command: command)
        updateSurfaceSize(for: frame.size)
        updateTrackingAreas()
    }

    required init?(coder: NSCoder) {
        return nil
    }

    deinit {
        windowObservers.forEach { NotificationCenter.default.removeObserver($0) }
        windowObservers.removeAll()
        shutdown()
    }

    func shutdown() {
        if Thread.isMainThread {
            shutdownOnMain()
        } else {
            DispatchQueue.main.sync {
                self.shutdownOnMain()
            }
        }
    }

    private func shutdownOnMain() {
        assert(Thread.isMainThread)
        if let surface {
            ghostty_surface_free(surface)
            self.surface = nil
        }
        frameScheduler.setVisible(false)
    }

    static func from(surface: ghostty_surface_t) -> GhosttyTerminalView? {
        guard let ud = ghostty_surface_userdata(surface) else { return nil }
        return Unmanaged<GhosttyTerminalView>.fromOpaque(ud).takeUnretainedValue()
    }

    static func from(userdata: UnsafeMutableRawPointer?) -> GhosttyTerminalView? {
        guard let userdata else { return nil }
        return Unmanaged<GhosttyTerminalView>.fromOpaque(userdata).takeUnretainedValue()
    }

    func setCursorShape(_ shape: ghostty_action_mouse_shape_e) {
        currentCursor = cursor(for: shape)
        window?.invalidateCursorRects(for: self)
    }

    func setCursorVisibility(_ visible: Bool) {
        NSCursor.setHiddenUntilMouseMoves(!visible)
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: currentCursor)
    }

    func addGridMetricsObserver(_ handler: @escaping (GhosttyGridMetrics) -> Void) -> UUID {
        assert(Thread.isMainThread)
        let token = UUID()
        gridMetricsObservers[token] = handler
        if let metrics = gridMetrics() {
            handler(metrics)
        }
        return token
    }

    func removeGridMetricsObserver(_ token: UUID) {
        assert(Thread.isMainThread)
        gridMetricsObservers.removeValue(forKey: token)
    }

    func gridMetrics() -> GhosttyGridMetrics? {
        guard let surface else { return nil }
        let size = ghostty_surface_size(surface)
        let columns = Int(size.columns)
        let rows = Int(size.rows)
        guard columns > 0, rows > 0 else { return nil }

        let backingCell = NSSize(width: Double(size.cell_width_px), height: Double(size.cell_height_px))
        let cell = convertFromBacking(backingCell)
        guard cell.width > 0, cell.height > 0 else { return nil }

        let gridWidth = CGFloat(columns) * cell.width
        let gridHeight = CGFloat(rows) * cell.height
        let paddingX = max(0, bounds.width - gridWidth)
        let paddingY = max(0, bounds.height - gridHeight)
        let origin = CGPoint(x: paddingX / 2.0, y: paddingY / 2.0)

        return GhosttyGridMetrics(columns: columns, rows: rows, cellSize: cell, origin: origin)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        windowObservers.forEach { NotificationCenter.default.removeObserver($0) }
        windowObservers.removeAll()

        if let window {
            windowObservers.append(
                NotificationCenter.default.addObserver(
                    forName: NSWindow.didChangeScreenNotification,
                    object: window,
                    queue: .main
                ) { [weak self] _ in
                    self?.updateDisplayID()
                }
            )
            windowObservers.append(
                NotificationCenter.default.addObserver(
                    forName: NSWindow.didChangeOcclusionStateNotification,
                    object: window,
                    queue: .main
                ) { [weak self] _ in
                    self?.updateOcclusionState()
                }
            )
        }

        frameScheduler.setVisible(window != nil)
        updateDisplayID()
        updateContentScale()
        updateOcclusionState()
        notifyGridMetricsChange()
        if let surface, window != nil {
            ghostty_surface_refresh(surface)
        }
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        updateContentScale()
        notifyGridMetricsChange()
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        updateSurfaceSize(for: newSize)
        notifyGridMetricsChange()
    }

    override func updateTrackingAreas() {
        if let tracking {
            removeTrackingArea(tracking)
        }
        let options: NSTrackingArea.Options = [.activeInKeyWindow, .mouseMoved, .mouseEnteredAndExited, .inVisibleRect]
        tracking = NSTrackingArea(rect: bounds, options: options, owner: self, userInfo: nil)
        if let tracking {
            addTrackingArea(tracking)
        }
        super.updateTrackingAreas()
    }

    override func becomeFirstResponder() -> Bool {
        let became = super.becomeFirstResponder()
        if became {
            setFocus(true)
        }
        return became
    }

    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned {
            setFocus(false)
        }
        return resigned
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        frameScheduler.noteInputActivity()
        guard let surface else { return }
        let mods = GhosttyInput.ghosttyMods(event.modifierFlags)
        ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_LEFT, mods)
    }

    override func mouseUp(with event: NSEvent) {
        frameScheduler.noteInputActivity()
        guard let surface else { return }
        let mods = GhosttyInput.ghosttyMods(event.modifierFlags)
        ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_LEFT, mods)
    }

    override func rightMouseDown(with event: NSEvent) {
        frameScheduler.noteInputActivity()
        guard let surface else { return super.rightMouseDown(with: event) }
        let mods = GhosttyInput.ghosttyMods(event.modifierFlags)
        if ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_RIGHT, mods) {
            return
        }
        super.rightMouseDown(with: event)
    }

    override func rightMouseUp(with event: NSEvent) {
        frameScheduler.noteInputActivity()
        guard let surface else { return super.rightMouseUp(with: event) }
        let mods = GhosttyInput.ghosttyMods(event.modifierFlags)
        if ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_RIGHT, mods) {
            return
        }
        super.rightMouseUp(with: event)
    }

    override func otherMouseDown(with event: NSEvent) {
        frameScheduler.noteInputActivity()
        guard let surface else { return }
        let mods = GhosttyInput.ghosttyMods(event.modifierFlags)
        ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_PRESS, mouseButton(from: event.buttonNumber), mods)
    }

    override func otherMouseUp(with event: NSEvent) {
        frameScheduler.noteInputActivity()
        guard let surface else { return }
        let mods = GhosttyInput.ghosttyMods(event.modifierFlags)
        ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_RELEASE, mouseButton(from: event.buttonNumber), mods)
    }

    override func mouseMoved(with event: NSEvent) {
        guard let surface else { return }
        let pos = convert(event.locationInWindow, from: nil)
        ghostty_surface_mouse_pos(surface, pos.x, bounds.height - pos.y, GhosttyInput.ghosttyMods(event.modifierFlags))
    }

    override func mouseEntered(with event: NSEvent) {
        guard let surface else { return }
        let pos = convert(event.locationInWindow, from: nil)
        ghostty_surface_mouse_pos(surface, pos.x, bounds.height - pos.y, GhosttyInput.ghosttyMods(event.modifierFlags))
    }

    override func mouseExited(with event: NSEvent) {
        guard let surface else { return }
        ghostty_surface_mouse_pos(surface, -1, -1, GhosttyInput.ghosttyMods(event.modifierFlags))
    }

    override func mouseDragged(with event: NSEvent) {
        frameScheduler.noteInputActivity()
        mouseMoved(with: event)
    }

    override func rightMouseDragged(with event: NSEvent) {
        frameScheduler.noteInputActivity()
        mouseMoved(with: event)
    }

    override func otherMouseDragged(with event: NSEvent) {
        frameScheduler.noteInputActivity()
        mouseMoved(with: event)
    }

    override func scrollWheel(with event: NSEvent) {
        frameScheduler.noteInputActivity()
        if let smoothScrollController, smoothScrollController.handleScrollWheel(event) {
            return
        }
        guard let surface else { return }
        var x = event.scrollingDeltaX
        var y = event.scrollingDeltaY
        let precision = event.hasPreciseScrollingDeltas
        if precision {
            x *= 2
            y *= 2
        }
        let mods: UInt8 = precision ? 0b0000_0001 : 0
        let scrollMods: ghostty_input_scroll_mods_t = ghostty_input_scroll_mods_t(Int32(mods))
        ghostty_surface_mouse_scroll(surface, x, y, scrollMods)
        onScrollActivity?()
    }

    override func keyDown(with event: NSEvent) {
        frameScheduler.noteInputActivity()
        if menuHandlesKeyEquivalent(event) {
            return
        }
        guard let surface else {
            interpretKeyEvents([event])
            return
        }

        let translationModsGhostty = GhosttyInput.eventModifierFlags(
            mods: ghostty_surface_key_translation_mods(
                surface,
                GhosttyInput.ghosttyMods(event.modifierFlags)
            )
        )

        var translationMods = event.modifierFlags
        for flag in [NSEvent.ModifierFlags.shift, .control, .option, .command] {
            if translationModsGhostty.contains(flag) {
                translationMods.insert(flag)
            } else {
                translationMods.remove(flag)
            }
        }
        if shouldTreatOptionAsMeta(event) {
            translationMods.remove(.option)
        }

        let translationEvent: NSEvent
        if translationMods == event.modifierFlags {
            translationEvent = event
        } else {
            translationEvent = NSEvent.keyEvent(
                with: event.type,
                location: event.locationInWindow,
                modifierFlags: translationMods,
                timestamp: event.timestamp,
                windowNumber: event.windowNumber,
                context: nil,
                characters: event.characters(byApplyingModifiers: translationMods) ?? "",
                charactersIgnoringModifiers: event.charactersIgnoringModifiers ?? "",
                isARepeat: event.isARepeat,
                keyCode: event.keyCode
            ) ?? event
        }

        let action = event.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS

        keyTextAccumulator = []
        defer { keyTextAccumulator = nil }

        let effectiveMods = effectiveModifierFlags(for: event)
        let hadMarked = markedTextStorage.length > 0
        interpretKeyEvents([translationEvent])
        syncPreedit(clearIfNeeded: hadMarked)

        if let list = keyTextAccumulator, !list.isEmpty {
            for text in list {
                _ = keyAction(
                    action,
                    event: event,
                    translationEvent: translationEvent,
                    text: text,
                    composing: false,
                    modifierFlagsOverride: effectiveMods
                )
            }
        } else {
            let composing = markedTextStorage.length > 0 || hadMarked
            let text = composing ? nil : translationEvent.ghosttyCharacters
            _ = keyAction(
                action,
                event: event,
                translationEvent: translationEvent,
                text: text,
                composing: composing,
                modifierFlagsOverride: effectiveMods
            )
        }
    }

    override func keyUp(with event: NSEvent) {
        frameScheduler.noteInputActivity()
        let effectiveMods = effectiveModifierFlags(for: event)
        _ = keyAction(GHOSTTY_ACTION_RELEASE, event: event, modifierFlagsOverride: effectiveMods)
    }

    override func flagsChanged(with event: NSEvent) {
        frameScheduler.noteInputActivity()
        let mod: UInt32
        switch event.keyCode {
        case 0x39: mod = GHOSTTY_MODS_CAPS.rawValue
        case 0x38, 0x3C: mod = GHOSTTY_MODS_SHIFT.rawValue
        case 0x3B, 0x3E: mod = GHOSTTY_MODS_CTRL.rawValue
        case 0x3A:
            guard optionAsMeta.allowsLeft else { return }
            mod = GHOSTTY_MODS_ALT.rawValue
        case 0x3D:
            guard optionAsMeta.allowsRight else { return }
            mod = GHOSTTY_MODS_ALT.rawValue
        case 0x37, 0x36: mod = GHOSTTY_MODS_SUPER.rawValue
        default:
            return
        }

        if hasMarkedText() { return }

        let mods = GhosttyInput.ghosttyMods(event.modifierFlags)
        var action = GHOSTTY_ACTION_RELEASE
        if (mods.rawValue & mod != 0) {
            action = GHOSTTY_ACTION_PRESS
        }

        let effectiveMods = effectiveModifierFlags(for: event)
        _ = keyAction(action, event: event, modifierFlagsOverride: effectiveMods)
    }

    override func doCommand(by selector: Selector) {
        // Prevents NSBeep for unhandled selectors.
    }

    private func menuHandlesKeyEquivalent(_ event: NSEvent) -> Bool {
        let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard mods.contains(.command) else { return false }
        guard let menu = NSApp.mainMenu else { return false }
        return menu.performKeyEquivalent(with: event)
    }

    private func optionSideFlags(from flags: NSEvent.ModifierFlags) -> (left: Bool, right: Bool) {
        let raw = flags.rawValue
        let left = (raw & UInt(NX_DEVICELALTKEYMASK)) != 0
        let right = (raw & UInt(NX_DEVICERALTKEYMASK)) != 0
        return (left: left, right: right)
    }

    private func shouldTreatOptionAsMeta(_ event: NSEvent) -> Bool {
        guard event.modifierFlags.contains(.option) else { return false }
        let sides = optionSideFlags(from: event.modifierFlags)
        if sides.left || sides.right {
            if sides.left && optionAsMeta.allowsLeft { return true }
            if sides.right && optionAsMeta.allowsRight { return true }
            return false
        }
        return optionAsMeta == .both
    }

    private func effectiveModifierFlags(for event: NSEvent) -> NSEvent.ModifierFlags {
        var flags = event.modifierFlags
        if flags.contains(.option), !shouldTreatOptionAsMeta(event) {
            flags.remove(.option)
        }
        return flags
    }

    // MARK: - NSTextInputClient

    func hasMarkedText() -> Bool {
        markedTextStorage.length > 0
    }

    func markedRange() -> NSRange {
        guard markedTextStorage.length > 0 else {
            return NSRange(location: NSNotFound, length: 0)
        }
        return NSRange(location: 0, length: markedTextStorage.length)
    }

    func selectedRange() -> NSRange {
        guard let surface else {
            return NSRange(location: NSNotFound, length: 0)
        }
        var text = ghostty_text_s()
        guard ghostty_surface_read_selection(surface, &text) else {
            return NSRange(location: NSNotFound, length: 0)
        }
        defer { ghostty_surface_free_text(surface, &text) }
        return NSRange(location: Int(text.offset_start), length: Int(text.offset_len))
    }

    func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        switch string {
        case let v as NSAttributedString:
            markedTextStorage = NSMutableAttributedString(attributedString: v)
        case let v as String:
            markedTextStorage = NSMutableAttributedString(string: v)
        default:
            markedTextStorage = NSMutableAttributedString(string: "")
        }

        if keyTextAccumulator == nil {
            syncPreedit()
        }
    }

    func unmarkText() {
        if markedTextStorage.length > 0 {
            markedTextStorage.mutableString.setString("")
            if keyTextAccumulator == nil {
                syncPreedit()
            }
        }
    }

    func validAttributesForMarkedText() -> [NSAttributedString.Key] {
        []
    }

    func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?) -> NSAttributedString? {
        actualRange?.pointee = NSRange(location: NSNotFound, length: 0)
        return nil
    }

    func characterIndex(for point: NSPoint) -> Int {
        0
    }

    func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect {
        guard let surface else {
            return NSRect(origin: frame.origin, size: .zero)
        }

        var x: Double = 0
        var y: Double = 0
        var width: Double = Double(cellSize.width)
        var height: Double = Double(cellSize.height)
        ghostty_surface_ime_point(surface, &x, &y, &width, &height)

        let viewRect = NSRect(
            x: x,
            y: bounds.height - y,
            width: max(width, Double(cellSize.width)),
            height: max(height, Double(cellSize.height))
        )

        let windowRect = convert(viewRect, to: nil)
        if let window {
            return window.convertToScreen(windowRect)
        }
        return windowRect
    }

    func insertText(_ string: Any, replacementRange: NSRange) {
        frameScheduler.noteInputActivity()
        guard let surface else { return }

        var chars = ""
        switch string {
        case let v as NSAttributedString:
            chars = v.string
        case let v as String:
            chars = v
        default:
            return
        }

        unmarkText()

        if var acc = keyTextAccumulator {
            acc.append(chars)
            keyTextAccumulator = acc
            return
        }

        sendText(chars, surface: surface)
    }

    // MARK: - Screen Buffer Reading

    /// Read the currently visible viewport text from this terminal.
    func readViewportText() -> String? {
        guard let surface else { return nil }
        let sel = ghostty_selection_s(
            top_left: ghostty_point_s(
                tag: GHOSTTY_POINT_VIEWPORT,
                coord: GHOSTTY_POINT_COORD_TOP_LEFT,
                x: 0, y: 0),
            bottom_right: ghostty_point_s(
                tag: GHOSTTY_POINT_VIEWPORT,
                coord: GHOSTTY_POINT_COORD_BOTTOM_RIGHT,
                x: 0, y: 0),
            rectangle: false)
        var text = ghostty_text_s()
        guard ghostty_surface_read_text(surface, sel, &text) else { return nil }
        defer { ghostty_surface_free_text(surface, &text) }
        return String(cString: text.text)
    }

    /// Read the entire scrollback buffer from this terminal.
    func readScreenText() -> String? {
        guard let surface else { return nil }
        let sel = ghostty_selection_s(
            top_left: ghostty_point_s(
                tag: GHOSTTY_POINT_SCREEN,
                coord: GHOSTTY_POINT_COORD_TOP_LEFT,
                x: 0, y: 0),
            bottom_right: ghostty_point_s(
                tag: GHOSTTY_POINT_SCREEN,
                coord: GHOSTTY_POINT_COORD_BOTTOM_RIGHT,
                x: 0, y: 0),
            rectangle: false)
        var text = ghostty_text_s()
        guard ghostty_surface_read_text(surface, sel, &text) else { return nil }
        defer { ghostty_surface_free_text(surface, &text) }
        return String(cString: text.text)
    }

    // MARK: - Helpers

    private func createSurface(app: ghostty_app_t, workingDirectory: String?, command: String?) -> ghostty_surface_t? {
        var config = ghostty_surface_config_new()
        config.userdata = Unmanaged.passUnretained(self).toOpaque()
        config.platform_tag = GHOSTTY_PLATFORM_MACOS
        config.platform = ghostty_platform_u(macos: ghostty_platform_macos_s(
            nsview: Unmanaged.passUnretained(self).toOpaque()
        ))
        let scale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 1.0
        config.scale_factor = Double(scale)
        config.font_size = 0
        config.wait_after_command = false
        config.context = GHOSTTY_SURFACE_CONTEXT_TAB

        return workingDirectory.withCString { cWorkingDir in
            return command.withCString { cCommand in
                config.working_directory = cWorkingDir
                config.command = cCommand
                return ghostty_surface_new(app, &config)
            }
        }
    }

    private func updateSurfaceSize(for size: NSSize) {
        guard let surface else { return }
        if size.width <= 0 || size.height <= 0 { return }
        if let lastContentSize, lastContentSize == size { return }
        lastContentSize = size
        let scaled = convertToBacking(size)
        let width = max(1, UInt32(scaled.width))
        let height = max(1, UInt32(scaled.height))
        ghostty_surface_set_size(surface, width, height)
    }

    private func updateContentScale() {
        guard let surface else { return }
        if let window {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            layer?.contentsScale = window.backingScaleFactor
            CATransaction.commit()
        }

        let fbFrame = convertToBacking(bounds)
        guard bounds.width > 0, bounds.height > 0 else { return }
        let xScale = fbFrame.size.width / bounds.size.width
        let yScale = fbFrame.size.height / bounds.size.height
        ghostty_surface_set_content_scale(surface, xScale, yScale)
    }

    private func updateDisplayID() {
        guard let surface else { return }
        guard let screen = window?.screen ?? NSScreen.main else { return }
        guard let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return }
        ghostty_surface_set_display_id(surface, id.uint32Value)
        frameScheduler.updateDisplay(screen)
    }

    private func updateOcclusionState() {
        guard let surface, let window else { return }
        // Treat unknown occlusion state as visible; only disable rendering when explicitly occluded.
        let state = window.occlusionState
        let visible = state.contains(.visible) || state.isEmpty
        ghostty_surface_set_occlusion(surface, visible)
        frameScheduler.setOccluded(!visible)
    }

    private func setFocus(_ focused: Bool) {
        guard let surface else { return }
        ghostty_surface_set_focus(surface, focused)
    }

    private func notifyGridMetricsChange() {
        assert(Thread.isMainThread)
        guard !gridMetricsObservers.isEmpty, let metrics = gridMetrics() else { return }
        let handlers = Array(gridMetricsObservers.values)
        for handler in handlers {
            handler(metrics)
        }
    }

    private func keyAction(
        _ action: ghostty_input_action_e,
        event: NSEvent,
        translationEvent: NSEvent? = nil,
        text: String? = nil,
        composing: Bool = false,
        modifierFlagsOverride: NSEvent.ModifierFlags? = nil
    ) -> Bool {
        guard let surface else { return false }
        if action == GHOSTTY_ACTION_REPEAT, !composing, shouldThrottleRepeat(event) {
            return false
        }
        var keyEvent = event.ghosttyKeyEvent(
            action,
            translationMods: translationEvent?.modifierFlags,
            modifierFlagsOverride: modifierFlagsOverride
        )
        keyEvent.composing = composing

        if let text, text.count > 0,
           let codepoint = text.utf8.first, codepoint >= 0x20 {
            return text.withCString { ptr in
                keyEvent.text = ptr
                return ghostty_surface_key(surface, keyEvent)
            }
        } else {
            return ghostty_surface_key(surface, keyEvent)
        }
    }

    func sendText(_ text: String) {
        guard let surface else { return }
        sendText(text, surface: surface)
    }

    private func sendText(_ text: String, surface: ghostty_surface_t) {
        let len = text.utf8CString.count
        if len == 0 { return }
        text.withCString { ptr in
            ghostty_surface_text(surface, ptr, UInt(len - 1))
        }
    }

    func scheduleRender() {
        frameScheduler.requestRender()
    }

    private func drawFrame() {
        guard let surface else { return }
        let start = CACurrentMediaTime()
        ghostty_surface_draw(surface)
        PerformanceMonitor.shared.recordRender(duration: CACurrentMediaTime() - start)
        PerformanceMonitor.shared.recordFrame(timestamp: ProcessInfo.processInfo.systemUptime)
    }

    private func shouldThrottleRepeat(_ event: NSEvent) -> Bool {
        let interval = frameScheduler.repeatThrottleInterval(at: event.timestamp)
        guard interval > 0 else { return false }
        if event.timestamp - lastRepeatTimestamp < interval {
            return true
        }
        lastRepeatTimestamp = event.timestamp
        return false
    }

    private func syncPreedit(clearIfNeeded: Bool = true) {
        guard let surface else { return }
        if markedTextStorage.length > 0 {
            let str = markedTextStorage.string
            let len = str.utf8CString.count
            if len > 0 {
                str.withCString { ptr in
                    ghostty_surface_preedit(surface, ptr, UInt(len - 1))
                }
            }
        } else if clearIfNeeded {
            ghostty_surface_preedit(surface, nil, 0)
        }
    }

    private func mouseButton(from buttonNumber: Int) -> ghostty_input_mouse_button_e {
        switch buttonNumber {
        case 0: return GHOSTTY_MOUSE_LEFT
        case 1: return GHOSTTY_MOUSE_RIGHT
        case 2: return GHOSTTY_MOUSE_MIDDLE
        case 3: return GHOSTTY_MOUSE_FOUR
        case 4: return GHOSTTY_MOUSE_FIVE
        default: return GHOSTTY_MOUSE_UNKNOWN
        }
    }

    private func cursor(for shape: ghostty_action_mouse_shape_e) -> NSCursor {
        switch shape {
        case GHOSTTY_MOUSE_SHAPE_TEXT:
            return .iBeam
        case GHOSTTY_MOUSE_SHAPE_VERTICAL_TEXT:
            if #available(macOS 10.15, *) {
                return .iBeamCursorForVerticalLayout
            }
            return .iBeam
        case GHOSTTY_MOUSE_SHAPE_POINTER:
            return .pointingHand
        case GHOSTTY_MOUSE_SHAPE_CONTEXT_MENU:
            return .contextualMenu
        case GHOSTTY_MOUSE_SHAPE_CROSSHAIR:
            return .crosshair
        case GHOSTTY_MOUSE_SHAPE_GRAB:
            return .openHand
        case GHOSTTY_MOUSE_SHAPE_GRABBING:
            return .closedHand
        case GHOSTTY_MOUSE_SHAPE_NOT_ALLOWED:
            return .operationNotAllowed
        case GHOSTTY_MOUSE_SHAPE_E_RESIZE:
            return .resizeRight
        case GHOSTTY_MOUSE_SHAPE_W_RESIZE:
            return .resizeLeft
        case GHOSTTY_MOUSE_SHAPE_N_RESIZE:
            return .resizeUp
        case GHOSTTY_MOUSE_SHAPE_S_RESIZE:
            return .resizeDown
        case GHOSTTY_MOUSE_SHAPE_EW_RESIZE:
            return .resizeLeftRight
        case GHOSTTY_MOUSE_SHAPE_NS_RESIZE:
            return .resizeUpDown
        case GHOSTTY_MOUSE_SHAPE_ZOOM_IN:
            if #available(macOS 15.0, *) {
                return .zoomIn
            }
            return .arrow
        case GHOSTTY_MOUSE_SHAPE_ZOOM_OUT:
            if #available(macOS 15.0, *) {
                return .zoomOut
            }
            return .arrow
        case GHOSTTY_MOUSE_SHAPE_CELL:
            return .crosshair
        default:
            return .arrow
        }
    }
}

private extension Optional where Wrapped == String {
    func withCString<T>(_ body: (UnsafePointer<Int8>?) throws -> T) rethrows -> T {
        if let string = self {
            return try string.withCString(body)
        }
        return try body(nil)
    }
}
