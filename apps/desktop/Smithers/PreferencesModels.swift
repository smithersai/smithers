import Foundation

enum OptionAsMeta: String, CaseIterable, Identifiable, Codable {
    case none
    case left
    case right
    case both

    var id: String { rawValue }

    var label: String {
        switch self {
        case .none:
            return "Off"
        case .left:
            return "Left"
        case .right:
            return "Right"
        case .both:
            return "Both"
        }
    }

    var allowsLeft: Bool {
        switch self {
        case .left, .both:
            return true
        case .none, .right:
            return false
        }
    }

    var allowsRight: Bool {
        switch self {
        case .right, .both:
            return true
        case .none, .left:
            return false
        }
    }
}

enum ScrollbarVisibilityMode: String, CaseIterable, Identifiable, Codable {
    case automatic
    case whenScrolling
    case always

    var id: String { rawValue }

    var label: String {
        switch self {
        case .automatic:
            return "Automatic"
        case .whenScrolling:
            return "When Scrolling"
        case .always:
            return "Always"
        }
    }
}
