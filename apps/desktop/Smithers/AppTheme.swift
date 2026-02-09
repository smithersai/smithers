import SwiftUI
import AppKit
import Foundation

struct NvimHighlightColors {
    var fg: NSColor?
    var bg: NSColor?
    var sp: NSColor?
}

struct AppTheme: Equatable {
    var background: NSColor
    var foreground: NSColor
    var mutedForeground: NSColor
    var secondaryBackground: NSColor
    var panelBackground: NSColor
    var panelBorder: NSColor
    var divider: NSColor
    var tabBarBackground: NSColor
    var tabSelectedBackground: NSColor
    var tabSelectedForeground: NSColor
    var tabForeground: NSColor
    var tabBorder: NSColor
    var selectionBackground: NSColor
    var matchingBracket: NSColor
    var accent: NSColor
    var lineNumberForeground: NSColor
    var lineNumberSelectedForeground: NSColor
    var lineNumberBackground: NSColor
    var lineHighlight: NSColor
    var chatAssistantBubble: NSColor
    var chatUserBubble: NSColor
    var chatCommandBubble: NSColor
    var chatStatusBubble: NSColor
    var chatDiffBubble: NSColor
    var inputFieldBackground: NSColor

    var isLight: Bool {
        background.luminance > 0.55
    }

    var colorScheme: ColorScheme {
        isLight ? .light : .dark
    }

    static let `default` = AppTheme(
        background: NSColor(red: 0.11, green: 0.12, blue: 0.14, alpha: 1),
        foreground: .white,
        mutedForeground: NSColor.white.withAlphaComponent(0.7),
        secondaryBackground: NSColor(red: 0.10, green: 0.11, blue: 0.13, alpha: 1),
        panelBackground: NSColor(red: 0.12, green: 0.13, blue: 0.15, alpha: 1),
        panelBorder: NSColor.white.withAlphaComponent(0.15),
        divider: NSColor.white.withAlphaComponent(0.12),
        tabBarBackground: NSColor(red: 0.10, green: 0.11, blue: 0.13, alpha: 1),
        tabSelectedBackground: NSColor.white.withAlphaComponent(0.10),
        tabSelectedForeground: .white,
        tabForeground: NSColor.white.withAlphaComponent(0.60),
        tabBorder: NSColor.white.withAlphaComponent(0.12),
        selectionBackground: NSColor.white.withAlphaComponent(0.12),
        matchingBracket: NSColor.white.withAlphaComponent(0.18),
        accent: .systemBlue,
        lineNumberForeground: NSColor(white: 0.55, alpha: 1),
        lineNumberSelectedForeground: NSColor(white: 0.55, alpha: 1),
        lineNumberBackground: NSColor(red: 0.11, green: 0.12, blue: 0.14, alpha: 1),
        lineHighlight: NSColor(white: 0.20, alpha: 1),
        chatAssistantBubble: NSColor.white.withAlphaComponent(0.08),
        chatUserBubble: NSColor.systemBlue.withAlphaComponent(0.45),
        chatCommandBubble: NSColor.black.withAlphaComponent(0.35),
        chatStatusBubble: NSColor.white.withAlphaComponent(0.12),
        chatDiffBubble: NSColor.white.withAlphaComponent(0.07),
        inputFieldBackground: NSColor.white.withAlphaComponent(0.10)
    )

    static func fromNvimHighlights(_ highlights: [String: NvimHighlightColors]) -> AppTheme {
        let fallback = AppTheme.default
        let normal = highlights["Normal"]
        let background = normal?.bg ?? fallback.background
        let foreground = normal?.fg ?? fallback.foreground
        let isLight = background.luminance > 0.55
        let muted = foreground.withAlphaComponent(isLight ? 0.7 : 0.6)
        let separator = highlights["WinSeparator"]?.fg ?? highlights["VertSplit"]?.fg
        let selection = highlights["Visual"]?.bg ?? highlights["CursorLine"]?.bg
        let tabFill = highlights["TabLineFill"]?.bg
        let tabLine = highlights["TabLine"]
        let tabSelected = highlights["TabLineSel"]
        let statusLine = highlights["StatusLine"]
        let menu = highlights["Pmenu"]
        let menuSelected = highlights["PmenuSel"]
        let normalFloat = highlights["NormalFloat"]
        let floatBorder = highlights["FloatBorder"]?.fg
        let lineNr = highlights["LineNr"]
        let cursorLineNr = highlights["CursorLineNr"]

        let secondaryBackground = statusLine?.bg
            ?? tabFill
            ?? tabLine?.bg
            ?? background.blended(with: foreground, fraction: isLight ? 0.06 : 0.10)

        let tabBarBackground = tabFill
            ?? tabLine?.bg
            ?? secondaryBackground

        let tabSelectedBackground = tabSelected?.bg
            ?? background.blended(with: foreground, fraction: isLight ? 0.10 : 0.18)

        let tabForeground = tabLine?.fg ?? muted
        let tabSelectedForeground = tabSelected?.fg ?? foreground

        let panelBackground = menu?.bg
            ?? normalFloat?.bg
            ?? background.blended(with: foreground, fraction: isLight ? 0.04 : 0.08)

        let panelBorder = floatBorder
            ?? separator
            ?? foreground.withAlphaComponent(isLight ? 0.18 : 0.12)

        let divider = separator ?? foreground.withAlphaComponent(isLight ? 0.20 : 0.12)

        let selectionBackground = selection
            ?? tabSelectedBackground.withAlphaComponent(isLight ? 0.20 : 0.30)
        let matchingBracket = selectionBackground.withAlphaComponent(isLight ? 0.35 : 0.45)

        let accent = menuSelected?.bg
            ?? tabSelected?.bg
            ?? fallback.accent

        let lineNumberForeground = lineNr?.fg ?? muted
        let lineNumberSelectedForeground = cursorLineNr?.fg ?? foreground
        let lineNumberBackground = lineNr?.bg ?? background
        let lineHighlight = highlights["CursorLine"]?.bg
            ?? selectionBackground.withAlphaComponent(isLight ? 0.14 : 0.20)

        let assistantBubble = foreground.withAlphaComponent(isLight ? 0.08 : 0.12)
        let userBubble = accent.withAlphaComponent(isLight ? 0.20 : 0.35)
        let commandBubble = foreground.withAlphaComponent(isLight ? 0.10 : 0.18)
        let statusBubble = foreground.withAlphaComponent(isLight ? 0.06 : 0.10)
        let diffBubble = foreground.withAlphaComponent(isLight ? 0.08 : 0.12)
        let inputFieldBackground = background.blended(with: foreground, fraction: isLight ? 0.06 : 0.12)

        return AppTheme(
            background: background,
            foreground: foreground,
            mutedForeground: muted,
            secondaryBackground: secondaryBackground,
            panelBackground: panelBackground,
            panelBorder: panelBorder,
            divider: divider,
            tabBarBackground: tabBarBackground,
            tabSelectedBackground: tabSelectedBackground,
            tabSelectedForeground: tabSelectedForeground,
            tabForeground: tabForeground,
            tabBorder: panelBorder,
            selectionBackground: selectionBackground,
            matchingBracket: matchingBracket,
            accent: accent,
            lineNumberForeground: lineNumberForeground,
            lineNumberSelectedForeground: lineNumberSelectedForeground,
            lineNumberBackground: lineNumberBackground,
            lineHighlight: lineHighlight,
            chatAssistantBubble: assistantBubble,
            chatUserBubble: userBubble,
            chatCommandBubble: commandBubble,
            chatStatusBubble: statusBubble,
            chatDiffBubble: diffBubble,
            inputFieldBackground: inputFieldBackground
        )
    }

    private var comparisonColors: [NSColor] {
        [
            background,
            foreground,
            mutedForeground,
            secondaryBackground,
            panelBackground,
            panelBorder,
            divider,
            tabBarBackground,
            tabSelectedBackground,
            tabSelectedForeground,
            tabForeground,
            tabBorder,
            selectionBackground,
            matchingBracket,
            accent,
            lineNumberForeground,
            lineNumberSelectedForeground,
            lineNumberBackground,
            lineHighlight,
            chatAssistantBubble,
            chatUserBubble,
            chatCommandBubble,
            chatStatusBubble,
            chatDiffBubble,
            inputFieldBackground,
        ]
    }

    static func == (lhs: AppTheme, rhs: AppTheme) -> Bool {
        zip(lhs.comparisonColors, rhs.comparisonColors).allSatisfy { $0.isApproximatelyEqual(to: $1) }
    }
}

extension AppTheme {
    var backgroundColor: Color { Color(nsColor: background) }
    var foregroundColor: Color { Color(nsColor: foreground) }
    var mutedForegroundColor: Color { Color(nsColor: mutedForeground) }
    var secondaryBackgroundColor: Color { Color(nsColor: secondaryBackground) }
    var panelBackgroundColor: Color { Color(nsColor: panelBackground) }
    var panelBorderColor: Color { Color(nsColor: panelBorder) }
    var dividerColor: Color { Color(nsColor: divider) }
    var tabBarBackgroundColor: Color { Color(nsColor: tabBarBackground) }
    var tabSelectedBackgroundColor: Color { Color(nsColor: tabSelectedBackground) }
    var tabSelectedForegroundColor: Color { Color(nsColor: tabSelectedForeground) }
    var tabForegroundColor: Color { Color(nsColor: tabForeground) }
    var tabBorderColor: Color { Color(nsColor: tabBorder) }
    var selectionBackgroundColor: Color { Color(nsColor: selectionBackground) }
    var matchingBracketColor: Color { Color(nsColor: matchingBracket) }
    var accentColor: Color { Color(nsColor: accent) }
    var lineNumberBackgroundColor: Color { Color(nsColor: lineNumberBackground) }
    var lineNumberForegroundColor: Color { Color(nsColor: lineNumberForeground) }
    var lineNumberSelectedForegroundColor: Color { Color(nsColor: lineNumberSelectedForeground) }
    var lineHighlightColor: Color { Color(nsColor: lineHighlight) }
    var chatAssistantBubbleColor: Color { Color(nsColor: chatAssistantBubble) }
    var chatUserBubbleColor: Color { Color(nsColor: chatUserBubble) }
    var chatCommandBubbleColor: Color { Color(nsColor: chatCommandBubble) }
    var chatStatusBubbleColor: Color { Color(nsColor: chatStatusBubble) }
    var chatDiffBubbleColor: Color { Color(nsColor: chatDiffBubble) }
    var inputFieldBackgroundColor: Color { Color(nsColor: inputFieldBackground) }
}

extension NSColor {
    static func fromHex(_ hex: String) -> NSColor? {
        var cleaned = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.hasPrefix("#") { cleaned.removeFirst() }
        if cleaned.hasPrefix("0x") || cleaned.hasPrefix("0X") {
            cleaned = String(cleaned.dropFirst(2))
        }
        guard cleaned.count == 6 || cleaned.count == 8 else { return nil }
        let scanner = Scanner(string: cleaned)
        var value: UInt64 = 0
        guard scanner.scanHexInt64(&value) else { return nil }
        let hasAlpha = cleaned.count == 8
        let r = CGFloat((value >> (hasAlpha ? 24 : 16)) & 0xFF) / 255.0
        let g = CGFloat((value >> (hasAlpha ? 16 : 8)) & 0xFF) / 255.0
        let b = CGFloat((value >> (hasAlpha ? 8 : 0)) & 0xFF) / 255.0
        let a = hasAlpha ? CGFloat(value & 0xFF) / 255.0 : 1
        return NSColor(srgbRed: r, green: g, blue: b, alpha: a)
    }

    func toHexString(includeAlpha: Bool = true) -> String? {
        guard let rgb = usingColorSpace(.sRGB) else { return nil }
        let r = Int(round(rgb.redComponent * 255))
        let g = Int(round(rgb.greenComponent * 255))
        let b = Int(round(rgb.blueComponent * 255))
        if includeAlpha {
            let a = Int(round(rgb.alphaComponent * 255))
            return String(format: "%02X%02X%02X%02X", r, g, b, a)
        }
        return String(format: "%02X%02X%02X", r, g, b)
    }

    var luminance: CGFloat {
        guard let rgb = usingColorSpace(.sRGB) else { return 0 }
        return 0.2126 * rgb.redComponent + 0.7152 * rgb.greenComponent + 0.0722 * rgb.blueComponent
    }

    func blended(with color: NSColor, fraction: CGFloat) -> NSColor {
        let base = usingColorSpace(.sRGB) ?? self
        let other = color.usingColorSpace(.sRGB) ?? color
        return base.blended(withFraction: fraction, of: other) ?? base
    }

    func isApproximatelyEqual(to other: NSColor, tolerance: CGFloat = 0.001) -> Bool {
        guard let lhs = usingColorSpace(.sRGB), let rhs = other.usingColorSpace(.sRGB) else {
            return isEqual(other)
        }
        return abs(lhs.redComponent - rhs.redComponent) <= tolerance
            && abs(lhs.greenComponent - rhs.greenComponent) <= tolerance
            && abs(lhs.blueComponent - rhs.blueComponent) <= tolerance
            && abs(lhs.alphaComponent - rhs.alphaComponent) <= tolerance
    }
}
