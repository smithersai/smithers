import Foundation
import Network

enum MsgPackValue {
    case int(Int64)
    case string(String)
    case array([MsgPackValue])
    case null
    case bool(Bool)
    case bin(Data)
}

extension MsgPackValue {
    var stringValue: String? {
        if case let .string(value) = self {
            return value
        }
        return nil
    }

    var intValue: Int64? {
        if case let .int(value) = self {
            return value
        }
        return nil
    }

    var arrayValue: [MsgPackValue]? {
        if case let .array(value) = self {
            return value
        }
        return nil
    }

    var isNil: Bool {
        if case .null = self {
            return true
        }
        return false
    }
}

extension MsgPackValue: CustomStringConvertible {
    var description: String {
        switch self {
        case let .int(value):
            return "\(value)"
        case let .string(value):
            return value
        case let .array(values):
            return "[\(values.map(\.description).joined(separator: ", "))]"
        case .null:
            return "nil"
        case let .bool(value):
            return value ? "true" : "false"
        case let .bin(data):
            return "bin(\(data.count) bytes)"
        }
    }
}

private struct MsgPackEncoder {
    static func encode(_ value: MsgPackValue) -> Data {
        var data = Data()
        encode(value, into: &data)
        return data
    }

    private static func encode(_ value: MsgPackValue, into data: inout Data) {
        switch value {
        case .null:
            data.append(0xc0)
        case let .bool(flag):
            data.append(flag ? 0xc3 : 0xc2)
        case let .int(value):
            encodeInt(value, into: &data)
        case let .string(value):
            encodeString(value, into: &data)
        case let .array(values):
            encodeArray(values, into: &data)
        case let .bin(bytes):
            encodeBin(bytes, into: &data)
        }
    }

    private static func encodeInt(_ value: Int64, into data: inout Data) {
        if value >= 0 && value <= 0x7f {
            data.append(UInt8(value))
            return
        }
        if value >= -32 && value < 0 {
            let byte = UInt8(bitPattern: Int8(value))
            data.append(byte)
            return
        }
        if value >= Int8.min && value <= Int8.max {
            data.append(0xd0)
            data.append(UInt8(bitPattern: Int8(value)))
            return
        }
        if value >= Int16.min && value <= Int16.max {
            data.append(0xd1)
            appendUInt(UInt64(UInt16(bitPattern: Int16(value))), bytes: 2, into: &data)
            return
        }
        if value >= Int32.min && value <= Int32.max {
            data.append(0xd2)
            appendUInt(UInt64(UInt32(bitPattern: Int32(value))), bytes: 4, into: &data)
            return
        }
        data.append(0xd3)
        appendUInt(UInt64(bitPattern: value), bytes: 8, into: &data)
    }

    private static func encodeString(_ value: String, into data: inout Data) {
        let bytes = Data(value.utf8)
        let length = bytes.count
        if length <= 31 {
            data.append(0xa0 | UInt8(length))
        } else if length <= UInt8.max {
            data.append(0xd9)
            data.append(UInt8(length))
        } else if length <= UInt16.max {
            data.append(0xda)
            appendUInt(UInt64(length), bytes: 2, into: &data)
        } else {
            data.append(0xdb)
            appendUInt(UInt64(length), bytes: 4, into: &data)
        }
        data.append(bytes)
    }

    private static func encodeArray(_ values: [MsgPackValue], into data: inout Data) {
        let length = values.count
        if length <= 15 {
            data.append(0x90 | UInt8(length))
        } else if length <= UInt16.max {
            data.append(0xdc)
            appendUInt(UInt64(length), bytes: 2, into: &data)
        } else {
            data.append(0xdd)
            appendUInt(UInt64(length), bytes: 4, into: &data)
        }
        for value in values {
            encode(value, into: &data)
        }
    }

    private static func encodeBin(_ value: Data, into data: inout Data) {
        let length = value.count
        if length <= UInt8.max {
            data.append(0xc4)
            data.append(UInt8(length))
        } else if length <= UInt16.max {
            data.append(0xc5)
            appendUInt(UInt64(length), bytes: 2, into: &data)
        } else {
            data.append(0xc6)
            appendUInt(UInt64(length), bytes: 4, into: &data)
        }
        data.append(value)
    }

    private static func appendUInt(_ value: UInt64, bytes: Int, into data: inout Data) {
        for shift in stride(from: (bytes - 1) * 8, through: 0, by: -8) {
            data.append(UInt8((value >> UInt64(shift)) & 0xff))
        }
    }
}

private struct MsgPackDecoder {
    enum DecodeError: Error {
        case insufficientData
        case invalidData
    }

    mutating func decodeNext(from data: inout Data) -> MsgPackValue? {
        var index = 0
        do {
            let value = try decodeValue(data, index: &index)
            data.removeFirst(index)
            return value
        } catch DecodeError.insufficientData {
            return nil
        } catch {
            data.removeAll()
            return nil
        }
    }

    private mutating func decodeValue(_ data: Data, index: inout Int) throws -> MsgPackValue {
        let byte = try readUInt8(data, index: &index)
        if byte <= 0x7f {
            return .int(Int64(byte))
        }
        if byte >= 0xe0 {
            return .int(Int64(Int8(bitPattern: byte)))
        }
        if byte >= 0xa0 && byte <= 0xbf {
            let length = Int(byte & 0x1f)
            let bytes = try readBytes(data, index: &index, count: length)
            return .string(String(decoding: bytes, as: UTF8.self))
        }
        if byte >= 0x90 && byte <= 0x9f {
            let length = Int(byte & 0x0f)
            return .array(try decodeArray(data, index: &index, length: length))
        }

        switch byte {
        case 0xc0:
            return .null
        case 0xc2:
            return .bool(false)
        case 0xc3:
            return .bool(true)
        case 0xcc:
            return .int(Int64(try readUInt(data, index: &index, bytes: 1)))
        case 0xcd:
            return .int(Int64(try readUInt(data, index: &index, bytes: 2)))
        case 0xce:
            return .int(Int64(try readUInt(data, index: &index, bytes: 4)))
        case 0xcf:
            return .int(Int64(try readUInt(data, index: &index, bytes: 8)))
        case 0xd0:
            return .int(Int64(Int8(bitPattern: try readUInt8(data, index: &index))))
        case 0xd1:
            return .int(Int64(Int16(bitPattern: UInt16(try readUInt(data, index: &index, bytes: 2)))))
        case 0xd2:
            return .int(Int64(Int32(bitPattern: UInt32(try readUInt(data, index: &index, bytes: 4)))))
        case 0xd3:
            return .int(Int64(bitPattern: UInt64(try readUInt(data, index: &index, bytes: 8))))
        case 0xd9:
            let length = Int(try readUInt(data, index: &index, bytes: 1))
            let bytes = try readBytes(data, index: &index, count: length)
            return .string(String(decoding: bytes, as: UTF8.self))
        case 0xda:
            let length = Int(try readUInt(data, index: &index, bytes: 2))
            let bytes = try readBytes(data, index: &index, count: length)
            return .string(String(decoding: bytes, as: UTF8.self))
        case 0xdb:
            let length = Int(try readUInt(data, index: &index, bytes: 4))
            let bytes = try readBytes(data, index: &index, count: length)
            return .string(String(decoding: bytes, as: UTF8.self))
        case 0xdc:
            let length = Int(try readUInt(data, index: &index, bytes: 2))
            return .array(try decodeArray(data, index: &index, length: length))
        case 0xdd:
            let length = Int(try readUInt(data, index: &index, bytes: 4))
            return .array(try decodeArray(data, index: &index, length: length))
        case 0xc4:
            let length = Int(try readUInt(data, index: &index, bytes: 1))
            let bytes = try readBytes(data, index: &index, count: length)
            return .bin(bytes)
        case 0xc5:
            let length = Int(try readUInt(data, index: &index, bytes: 2))
            let bytes = try readBytes(data, index: &index, count: length)
            return .bin(bytes)
        case 0xc6:
            let length = Int(try readUInt(data, index: &index, bytes: 4))
            let bytes = try readBytes(data, index: &index, count: length)
            return .bin(bytes)
        default:
            throw DecodeError.invalidData
        }
    }

    private mutating func decodeArray(_ data: Data, index: inout Int, length: Int) throws -> [MsgPackValue] {
        var values: [MsgPackValue] = []
        values.reserveCapacity(length)
        for _ in 0..<length {
            let value = try decodeValue(data, index: &index)
            values.append(value)
        }
        return values
    }

    private func readUInt8(_ data: Data, index: inout Int) throws -> UInt8 {
        guard index < data.count else { throw DecodeError.insufficientData }
        let value = data[index]
        index += 1
        return value
    }

    private func readUInt(_ data: Data, index: inout Int, bytes: Int) throws -> UInt64 {
        guard index + bytes <= data.count else { throw DecodeError.insufficientData }
        var value: UInt64 = 0
        for _ in 0..<bytes {
            value = (value << 8) | UInt64(data[index])
            index += 1
        }
        return value
    }

    private func readBytes(_ data: Data, index: inout Int, count: Int) throws -> Data {
        guard index + count <= data.count else { throw DecodeError.insufficientData }
        let subdata = data.subdata(in: index..<(index + count))
        index += count
        return subdata
    }
}

enum NvimRPCError: Error {
    case disconnected
    case invalidResponse
    case remoteError(String)
}

final class NvimRPC: @unchecked Sendable {
    private let queue = DispatchQueue(label: "smithers.nvimrpc")
    private var connection: NWConnection?
    private var buffer = Data()
    private var decoder = MsgPackDecoder()
    private var nextMsgId: Int64 = 0
    private var pending: [Int64: CheckedContinuation<MsgPackValue, Error>] = [:]

    private let notificationsStream: AsyncStream<(String, [MsgPackValue])>
    private let notificationsContinuation: AsyncStream<(String, [MsgPackValue])>.Continuation

    var notifications: AsyncStream<(String, [MsgPackValue])> {
        notificationsStream
    }

    init() {
        var continuation: AsyncStream<(String, [MsgPackValue])>.Continuation!
        notificationsStream = AsyncStream { streamContinuation in
            continuation = streamContinuation
        }
        notificationsContinuation = continuation
    }

    func connect(to socketPath: String) async throws {
        let endpoint = NWEndpoint.unix(path: socketPath)
        let parameters = NWParameters.tcp
        let connection = NWConnection(to: endpoint, using: parameters)
        self.connection = connection
        try await withCheckedThrowingContinuation { continuation in
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    connection.stateUpdateHandler = nil
                    continuation.resume()
                case .failed(let error):
                    connection.stateUpdateHandler = nil
                    continuation.resume(throwing: error)
                case .cancelled:
                    connection.stateUpdateHandler = nil
                    continuation.resume(throwing: NvimRPCError.disconnected)
                default:
                    break
                }
            }
            connection.start(queue: self.queue)
        }
        queue.async { [weak self] in
            self?.receiveNext()
        }
    }

    func request(_ method: String, params: [MsgPackValue]) async throws -> MsgPackValue {
        try await withCheckedThrowingContinuation { continuation in
            queue.async { [weak self] in
                guard let self, let connection = self.connection else {
                    continuation.resume(throwing: NvimRPCError.disconnected)
                    return
                }
                let msgid = self.nextMsgId
                self.nextMsgId += 1
                self.pending[msgid] = continuation
                let message: MsgPackValue = .array([
                    .int(0),
                    .int(msgid),
                    .string(method),
                    .array(params),
                ])
                let data = MsgPackEncoder.encode(message)
                connection.send(content: data, completion: .contentProcessed { error in
                    if let error {
                        self.pending.removeValue(forKey: msgid)
                        continuation.resume(throwing: error)
                    }
                })
            }
        }
    }

    func notify(_ method: String, params: [MsgPackValue]) throws {
        guard let connection else {
            throw NvimRPCError.disconnected
        }
        let message: MsgPackValue = .array([
            .int(2),
            .string(method),
            .array(params),
        ])
        let data = MsgPackEncoder.encode(message)
        queue.async {
            connection.send(content: data, completion: .contentProcessed { _ in })
        }
    }

    private func receiveNext() {
        connection?.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                self.buffer.append(data)
                while let message = self.decoder.decodeNext(from: &self.buffer) {
                    self.handleMessage(message)
                }
            }
            if let error {
                self.failAllPending(error)
                return
            }
            if isComplete {
                self.failAllPending(NvimRPCError.disconnected)
                return
            }
            self.receiveNext()
        }
    }

    private func handleMessage(_ message: MsgPackValue) {
        guard case let .array(values) = message, values.count >= 3 else { return }
        guard case let .int(type) = values[0] else { return }
        switch type {
        case 1:
            guard values.count >= 4 else { return }
            guard let msgid = values[1].intValue else { return }
            let errorValue = values[2]
            let resultValue = values[3]
            if let continuation = pending.removeValue(forKey: msgid) {
                if errorValue.isNil {
                    continuation.resume(returning: resultValue)
                } else {
                    continuation.resume(throwing: NvimRPCError.remoteError(errorValue.description))
                }
            }
        case 2:
            guard let method = values[1].stringValue else { return }
            let params = values[2].arrayValue ?? []
            notificationsContinuation.yield((method, params))
        default:
            return
        }
    }

    private func failAllPending(_ error: Error) {
        let pendingContinuations = pending
        pending.removeAll()
        for (_, continuation) in pendingContinuations {
            continuation.resume(throwing: error)
        }
    }
}
