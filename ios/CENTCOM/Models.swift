import Foundation
import SwiftUI

enum TaskStatus: String, Codable, CaseIterable, Identifiable {
    case backlog, todo, inProgress = "in_progress", inReview = "in_review", done, canceled
    var id: String { rawValue }
    var title: String {
        switch self {
        case .backlog: "Backlog"
        case .todo: "To do"
        case .inProgress: "In progress"
        case .inReview: "In review"
        case .done: "Done"
        case .canceled: "Canceled"
        }
    }
    var symbol: String {
        switch self {
        case .backlog: "circle.dashed"
        case .todo: "circle"
        case .inProgress: "circle.lefthalf.filled"
        case .inReview: "eye.circle"
        case .done: "checkmark.circle.fill"
        case .canceled: "xmark.circle"
        }
    }
    var color: Color {
        switch self {
        case .inProgress: .orange
        case .inReview: .green
        case .done: .secondary
        default: .secondary
        }
    }
    var isOpen: Bool { self != .done && self != .canceled }
}

struct Ticket: Codable, Identifiable, Hashable {
    let id: String
    var title: String
    var status: TaskStatus
    var priority: Int
    var agent: String?
    var project: String?
    var due: String?
    var labels: [String]
    var body: String
    var updated: Double
    var created: Double? = nil
}

struct Project: Codable, Identifiable, Hashable {
    let slug: String
    var id: String { slug }
    let name: String
    let key: String
    let summary: String
    let status: String
    let color: String
    var icon: String? = nil
    let lead: String?
    let body: String
    let counts: [String: Int]
    var total: Int { counts.filter { $0.key != "canceled" }.values.reduce(0, +) }
    var completed: Int { counts["done", default: 0] }
    var open: Int { total - completed }
    var progress: Double { total == 0 ? 0 : Double(completed) / Double(total) }
    var tint: Color { Color(hex: color) }
}

struct Agent: Codable, Identifiable {
    let id: String
    let name: String
    var kind: String? = nil
    var color: String? = nil
    var lastSeen: Double? = nil
    var showInDirectory: Bool? = nil
    var isInDirectory: Bool { showInDirectory == true }
}
struct ActivityEvent: Codable, Identifiable {
    var device: String? = nil
    let id: String
    let ts: Double
    let agent: String
    let type: String
    let ticket: String?
    let subject: String?
    let body: String?
    var project: String? = nil
    /// `agent.instructions_changed`: whose instructions changed.
    var target: String? = nil
    var date: Date { Date(timeIntervalSince1970: ts / 1000) }
    var isInstructionChange: Bool { type == "agent.instructions_changed" }
}
struct TicketDetail: Decodable {
    let ticket: Ticket
    let activity: [ActivityEvent]
    let children: [Ticket]
}
struct ServerInfo: Decodable {
    let name: String
    let user: User
    struct User: Decodable { let id: String; let name: String }
}
struct APIError: Decodable { let error: String }

let priorities = ["No priority", "Urgent", "High", "Medium", "Low"]

extension Color {
    init(hex: String) {
        var value = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        if value.count == 3 { value = value.map { "\($0)\($0)" }.joined() }
        let number = UInt64(value, radix: 16) ?? 0x5b5bd6
        self.init(red: Double((number >> 16) & 255) / 255, green: Double((number >> 8) & 255) / 255, blue: Double(number & 255) / 255)
    }
}

struct WikiNode: Decodable, Identifiable {
    let path: String
    let name: String
    let type: String
    let kind: String?
    let title: String?
    let children: [WikiNode]?
    var mtime: Double? = nil
    var id: String { path }
    /// Every file below this node, of any kind: docs and saved links, images, PDFs, media and other uploads.
    var documents: [WikiNode] {
        if type == "file" { return [self] }
        return (children ?? []).flatMap(\.documents)
    }
    /// Markdown (saved links are markdown too) opens as a doc; anything else is previewed as a file.
    var isDocument: Bool { kind == "markdown" || kind == "link" }
    var displayName: String { isDocument ? (title ?? name) : name }
    var symbol: String {
        switch kind {
        case "markdown": return "doc.text"
        case "link": return "link"
        case "image": return "photo"
        case "pdf": return "doc.richtext"
        case "video": return "film"
        case "audio": return "waveform"
        default: return "doc"
        }
    }
    func find(_ path: String) -> WikiNode? {
        if self.path == path { return self }
        return (children ?? []).lazy.compactMap { $0.find(path) }.first
    }
}
struct WikiDocument: Decodable, Identifiable {
    let path: String
    let title: String
    let body: String
    let mtime: Double
    var id: String { path }
}
extension Color {
    static let navy = Color("AccentColor")
}

struct ProjectLabel: Codable, Identifiable, Hashable {
    let id: String
    let project: String?
    let name: String
    let color: String
    let deleted: Bool
    var scopedID: String { "\(project ?? "__inbox")/\(id)" }
}
