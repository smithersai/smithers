import Foundation
import Darwin

public enum SmithersIPC {
    public static var socketPath: String {
        "/tmp/smithers-\(getuid()).sock"
    }

    public static var socketURL: URL {
        URL(fileURLWithPath: socketPath)
    }
}

public struct SmithersIPCOpenItem: Codable {
    public let path: String
    public let line: Int?
    public let column: Int?
    public let wait: Bool?

    public init(path: String, line: Int? = nil, column: Int? = nil, wait: Bool? = nil) {
        self.path = path
        self.line = line
        self.column = column
        self.wait = wait
    }
}

public struct SmithersIPCRequest: Codable {
    public let items: [SmithersIPCOpenItem]

    public init(items: [SmithersIPCOpenItem]) {
        self.items = items
    }
}

public struct SmithersIPCResponse: Codable {
    public enum Status: String, Codable {
        case ok
        case error
    }

    public let status: Status
    public let message: String?

    public init(status: Status, message: String? = nil) {
        self.status = status
        self.message = message
    }
}
