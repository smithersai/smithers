import AppKit
import CoreVideo
import QuartzCore
import os.lock

final class GhosttyFrameScheduler {
    private let drawHandler: () -> Void

    private var displayLink: CVDisplayLink?
    private var lock = os_unfair_lock_s()

    private var pendingRender: Bool = false
    private var drawScheduled: Bool = false
    private var isVisible: Bool = true
    private var isOccluded: Bool = false

    private var lastDrawTime: CFTimeInterval = 0
    private var lastTickTime: CFTimeInterval = 0
    private var lastPresentTime: CFTimeInterval = 0
    private var lastActivityTime: CFTimeInterval
    private var lastRenderRequestTime: CFTimeInterval = 0
    private var averageFrameInterval: Double = 1.0 / 60.0
    private var refreshHz: Double = 60.0

    private let idleFPS: Double = 10.0
    private let idleDelay: CFTimeInterval = 0.6
    private let renderBurstWindow: CFTimeInterval = 0.2
    private let slowFrameThreshold: CFTimeInterval = 1.0 / 30.0

    init(drawHandler: @escaping () -> Void) {
        self.drawHandler = drawHandler
        self.lastActivityTime = CACurrentMediaTime()
        setupDisplayLink()
    }

    deinit {
        stopDisplayLink()
        displayLink = nil
    }

    func requestRender() {
        let now = CACurrentMediaTime()
        os_unfair_lock_lock(&lock)
        pendingRender = true
        if lastRenderRequestTime > 0, now - lastRenderRequestTime <= renderBurstWindow {
            lastActivityTime = now
        }
        lastRenderRequestTime = now
        os_unfair_lock_unlock(&lock)
        updateDisplayLinkState()
    }

    func noteInputActivity() {
        let now = CACurrentMediaTime()
        os_unfair_lock_lock(&lock)
        lastActivityTime = now
        os_unfair_lock_unlock(&lock)
        updateDisplayLinkState()
    }

    func setVisible(_ visible: Bool) {
        os_unfair_lock_lock(&lock)
        isVisible = visible
        os_unfair_lock_unlock(&lock)
        updateDisplayLinkState()
    }

    func setOccluded(_ occluded: Bool) {
        os_unfair_lock_lock(&lock)
        isOccluded = occluded
        os_unfair_lock_unlock(&lock)
        updateDisplayLinkState()
    }

    func updateDisplay(_ screen: NSScreen?) {
        guard let screen,
              let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
        else { return }
        let displayID = CGDirectDisplayID(number.uint32Value)
        os_unfair_lock_lock(&lock)
        if let displayLink {
            _ = CVDisplayLinkSetCurrentCGDisplay(displayLink, displayID)
        }
        let maxFPS = Double(screen.maximumFramesPerSecond)
        if maxFPS > 0 {
            refreshHz = maxFPS
        }
        lastTickTime = 0
        lastPresentTime = 0
        averageFrameInterval = activeIntervalLocked()
        os_unfair_lock_unlock(&lock)
    }

    func repeatThrottleInterval(at timestamp: TimeInterval) -> TimeInterval {
        os_unfair_lock_lock(&lock)
        let idle = timestamp - lastActivityTime > idleDelay
        let idleInterval = 1.0 / idleFPS
        let activeInterval = activeIntervalLocked()
        let slow = averageFrameInterval >= slowFrameThreshold
        let interval: TimeInterval
        if idle {
            interval = max(idleInterval, slow ? averageFrameInterval : 0)
        } else if slow {
            interval = max(activeInterval, averageFrameInterval)
        } else {
            interval = 0
        }
        os_unfair_lock_unlock(&lock)
        return interval
    }

    // MARK: - Display Link

    private func setupDisplayLink() {
        var link: CVDisplayLink?
        CVDisplayLinkCreateWithActiveCGDisplays(&link)
        guard let link else { return }
        displayLink = link
        let callback: CVDisplayLinkOutputCallback = { _, _, _, _, _, context in
            guard let context else { return kCVReturnError }
            let scheduler = Unmanaged<GhosttyFrameScheduler>.fromOpaque(context).takeUnretainedValue()
            scheduler.displayLinkTick()
            return kCVReturnSuccess
        }
        CVDisplayLinkSetOutputCallback(link, callback, Unmanaged.passUnretained(self).toOpaque())
    }

    private func displayLinkTick() {
        let now = CACurrentMediaTime()
        os_unfair_lock_lock(&lock)
        updateRefreshRateLocked(now: now)

        if !isVisible || isOccluded {
            os_unfair_lock_unlock(&lock)
            return
        }

        let idle = now - lastActivityTime > idleDelay
        let targetInterval = idle ? (1.0 / idleFPS) : activeIntervalLocked()

        if pendingRender && now - lastDrawTime >= targetInterval && !drawScheduled {
            pendingRender = false
            drawScheduled = true
            lastDrawTime = now
            os_unfair_lock_unlock(&lock)

            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                let start = CACurrentMediaTime()
                self.drawHandler()
                let end = CACurrentMediaTime()
                self.finishDraw(duration: end - start)
            }
            return
        }

        os_unfair_lock_unlock(&lock)
    }

    private func finishDraw(duration: CFTimeInterval) {
        var shouldUpdate = false
        os_unfair_lock_lock(&lock)
        drawScheduled = false
        let now = CACurrentMediaTime()
        let frameInterval = lastPresentTime > 0 ? max(0, now - lastPresentTime) : duration
        if frameInterval > 0 {
            averageFrameInterval = (averageFrameInterval * 0.9) + (frameInterval * 0.1)
            lastPresentTime = now
        }
        if !pendingRender {
            shouldUpdate = true
        }
        os_unfair_lock_unlock(&lock)
        if shouldUpdate {
            updateDisplayLinkState()
        }
    }

    private func activeIntervalLocked() -> CFTimeInterval {
        let hz = max(refreshHz, 1.0)
        return 1.0 / hz
    }

    private func updateRefreshRateLocked(now: CFTimeInterval) {
        guard lastTickTime > 0 else {
            lastTickTime = now
            return
        }
        let delta = now - lastTickTime
        lastTickTime = now
        guard delta > 0 else { return }
        let hz = 1.0 / delta
        guard hz.isFinite else { return }
        let clamped = min(max(hz, 24.0), 240.0)
        refreshHz = refreshHz == 0 ? clamped : (refreshHz * 0.9 + clamped * 0.1)
    }

    private func startDisplayLink() {
        guard let displayLink, !CVDisplayLinkIsRunning(displayLink) else { return }
        os_unfair_lock_lock(&lock)
        let shouldStart = isVisible && !isOccluded
        os_unfair_lock_unlock(&lock)
        guard shouldStart else { return }
        CVDisplayLinkStart(displayLink)
    }

    private func stopDisplayLink() {
        if let displayLink, CVDisplayLinkIsRunning(displayLink) {
            CVDisplayLinkStop(displayLink)
        }
    }

    private func updateDisplayLinkState() {
        var shouldStart = false
        var shouldStop = false

        os_unfair_lock_lock(&lock)
        if isVisible && !isOccluded && (pendingRender || drawScheduled) {
            shouldStart = true
        } else {
            shouldStop = true
            resetTimingLocked()
        }
        os_unfair_lock_unlock(&lock)

        if shouldStart {
            startDisplayLink()
        } else if shouldStop {
            stopDisplayLink()
        }
    }

    private func resetTimingLocked() {
        lastTickTime = 0
        lastPresentTime = 0
        averageFrameInterval = activeIntervalLocked()
    }
}
