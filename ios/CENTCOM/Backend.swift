import Foundation
import UIKit
import Observation
import Security

struct Connection: Equatable {
    let url: URL
    let token: String

    init(address: String, token: String) throws {
        guard let url = URL(string: address.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = url.host, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil,
              url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(host)) else {
            throw ClientError.message("Use an HTTPS server address. HTTP is allowed only for the local simulator.")
        }
        self.url = url
        self.token = token.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

enum ClientError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case let .message(text) = self { return text }; return nil }
}

/// The token belongs only in the device Keychain, never in defaults, source, or logs.
enum TokenStore {
    /// Named after the app's bundle identifier, so a fork's build keeps its own item.
    static let key: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                   kSecAttrService as String: Bundle.main.bundleIdentifier ?? "centcom",
                                   kSecAttrAccount as String: "backend-token"]
    static func read() -> String {
        var query = key
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }
    static func save(_ token: String) throws {
        let update = [kSecValueData as String: Data(token.utf8)]
        let status = SecItemUpdate(key as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var item = key
            item[kSecValueData as String] = Data(token.utf8)
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            let added = SecItemAdd(item as CFDictionary, nil)
            guard added == errSecSuccess else { throw ClientError.message("Could not save the connection securely (\(added)).") }
        } else if status != errSecSuccess {
            throw ClientError.message("Could not save the connection securely (\(status)).")
        }
    }
}

struct APIClient {
    let connection: Connection
    var session: URLSession = .shared

    func request<T: Decodable>(_ path: String, method: String = "GET", body: [String: Any]? = nil, query: [URLQueryItem] = []) async throws -> T {
        let base = connection.url.appending(path: "api").appending(path: path)
        var parts = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        if !query.isEmpty { parts.queryItems = query }
        let url = parts.url!
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 20
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if !connection.token.isEmpty { request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization") }
        if var body {
            if method != "GET", path == "tickets" || path.hasPrefix("tickets/"), body["device"] == nil {
                let name = await MainActor.run { UserDefaults.standard.string(forKey: "deviceName") ?? UIDevice.current.name }.trimmingCharacters(in: .whitespacesAndNewlines)
                if !name.isEmpty { body["device"] = name }
            }
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw ClientError.message("The server returned an invalid response.") }
        guard (200..<300).contains(response.statusCode) else {
            if response.statusCode == 401 { throw ClientError.message("The server token is missing or incorrect. Update it in Connection.") }
            throw ClientError.message((try? JSONDecoder().decode(APIError.self, from: data).error) ?? "Server error \(response.statusCode).")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

@MainActor @Observable
final class Workspace {
    var tickets: [Ticket] = []
    var labels: [ProjectLabel] = []
    var projects: [Project] = []
    var agents: [Agent] = []
    var activity: [ActivityEvent] = []
    var userID = "me"
    var connection: Connection?
    var online = false
    var loading = false
    var error: String?
    var lastSynced: Date?
    private var revision = 0

    init() {
        // `-CENTCOMDemo` opens straight into the demo workspace (UI tests, review builds).
        if ProcessInfo.processInfo.arguments.contains("-CENTCOMDemo") {
            connection = try? Connection(address: DemoURLProtocol.address, token: DemoURLProtocol.token)
            return
        }
        let address = UserDefaults.standard.string(forKey: "serverAddress") ?? ""
        connection = try? Connection(address: address, token: TokenStore.read())
    }
    var client: APIClient? { connection.map { APIClient(connection: $0) } }
    var isConfigured: Bool { connection != nil }
    var isDemo: Bool { DemoURLProtocol.isDemo(connection?.url) }

    func connect(address: String, token: String) async throws {
        let candidate = try Connection(address: address, token: token)
        let api = APIClient(connection: candidate)
        let info: ServerInfo = try await api.request("info")
        guard info.name == "centcom" else { throw ClientError.message("That address does not point to a CENTCOM server.") }
        // Validate the entire workspace before replacing a working connection.
        async let tasks: [Ticket] = api.request("tickets")
        async let groups: [Project] = api.request("projects")
        async let people: [Agent] = api.request("agents")
        async let events: [ActivityEvent] = api.request("activity")
        let snapshot = try await (tasks, groups, people, events)
        // The demo is never remembered: the next launch is back at your own server (or none).
        if !DemoURLProtocol.isDemo(candidate.url) {
            try TokenStore.save(candidate.token)
            UserDefaults.standard.set(candidate.url.absoluteString, forKey: "serverAddress")
        }
        revision += 1
        connection = candidate
        userID = info.user.id
        (tickets, projects, agents, activity) = snapshot
        online = true
        error = nil
        lastSynced = Date()
    }

    func refresh() async {
        guard let client, !loading else { return }
        loading = true
        let started = revision
        defer { loading = false }
        do {
            async let info: ServerInfo = client.request("info")
            async let tasks: [Ticket] = client.request("tickets")
            async let groups: [Project] = client.request("projects")
            async let people: [Agent] = client.request("agents")
            async let events: [ActivityEvent] = client.request("activity")
            async let catalog: [ProjectLabel] = client.request("labels")
            let result = try await (info, tasks, groups, people, events, catalog)
            guard started == revision else { return }
            userID = result.0.user.id
            tickets = result.1; projects = result.2; agents = result.3; activity = result.4; labels = result.5
            online = true; error = nil; lastSynced = Date()
        } catch {
            guard started == revision, !Task.isCancelled else { return }
            online = false
            self.error = error.localizedDescription
        }
    }

    func update(_ ticket: Ticket, fields: [String: Any]) async throws {
        guard let client else { throw ClientError.message("Connect to your server first.") }
        var body = fields; body["by"] = userID
        let updated: Ticket = try await client.request("tickets/\(ticket.id)", method: "PATCH", body: body)
        revision += 1
        tickets.removeAll { $0.id == ticket.id }
        tickets.append(updated)
        // Next foreground poll reconciles project counts and activity too.
        await refresh()
    }
    func create(fields: [String: Any]) async throws -> Ticket {
        guard let client else { throw ClientError.message("Connect to your server first.") }
        var body = fields; body["createdBy"] = userID
        let ticket: Ticket = try await client.request("tickets", method: "POST", body: body)
        revision += 1
        tickets.append(ticket)
        await refresh()
        return ticket
    }
    func comment(on id: String, body: String) async throws {
        guard let client else { throw ClientError.message("Connect to your server first.") }
        let event: ActivityEvent = try await client.request("tickets/\(id)/comments", method: "POST", body: ["body": body, "agent": userID])
        revision += 1
        activity.insert(event, at: 0)
    }
    @discardableResult func saveLabel(project: String?, label: ProjectLabel? = nil, name: String, color: String, deleted: Bool = false) async throws -> ProjectLabel {
        guard let client else { throw ClientError.message("Connect to your server first.") }
        var body: [String: Any] = ["project": project as Any? ?? NSNull(), "name": name, "color": color, "agent": userID]
        if label != nil { body["deleted"] = deleted }
        let saved: ProjectLabel = try await client.request(label.map { "labels/\($0.id)" } ?? "labels", method: label == nil ? "POST" : "PATCH", body: body)
        await refresh()
        return saved
    }
    func project(for event: ActivityEvent) -> Project? {
        let slug = event.project ?? tickets.first { $0.id == event.ticket }?.project
        return projects.first { $0.slug == slug }
    }
    func projectName(for event: ActivityEvent) -> String {
        let slug = event.project ?? tickets.first { $0.id == event.ticket }?.project
        return projects.first { $0.slug == slug }?.name ?? slug ?? "Inbox"
    }
    func agentName(_ id: String?) -> String { agents.first { $0.id == id }?.name ?? id ?? "Unassigned" }
}
