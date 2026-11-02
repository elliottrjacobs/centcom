import Foundation

extension APIClient {
    /// Auth stays in a header; QuickLook receives only a local temporary file.
    func download(_ path: String) async throws -> URL {
        var request = URLRequest(url: connection.url.appending(path: "api/raw").appending(path: path))
        request.timeoutInterval = 60
        if !connection.token.isEmpty { request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization") }
        let (temporary, response) = try await session.download(for: request)
        defer { try? FileManager.default.removeItem(at: temporary) }
        guard let response = response as? HTTPURLResponse, response.statusCode == 200 else {
            throw ClientError.message("Could not open this file. Check your connection and try again.")
        }
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let local = folder.appending(path: URL(fileURLWithPath: path).lastPathComponent, directoryHint: .notDirectory)
        try FileManager.default.moveItem(at: temporary, to: local)
        return local
    }

    func upload(_ file: URL, directory: String, agent: String) async throws -> WikiNode {
        let access = file.startAccessingSecurityScopedResource()
        defer { if access { file.stopAccessingSecurityScopedResource() } }
        let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= 50 * 1024 * 1024 else { throw ClientError.message("Upload exceeds the 50 MB limit.") }
        var parts = URLComponents(url: connection.url.appending(path: "api/upload"), resolvingAgainstBaseURL: false)!
        parts.queryItems = [URLQueryItem(name: "dir", value: directory), URLQueryItem(name: "name", value: file.lastPathComponent), URLQueryItem(name: "agent", value: agent)]
        var request = URLRequest(url: parts.url!)
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        if !connection.token.isEmpty { request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await session.upload(for: request, fromFile: file)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            throw ClientError.message((try? JSONDecoder().decode(APIError.self, from: data).error) ?? "Could not upload this file.")
        }
        return try JSONDecoder().decode(WikiNode.self, from: data)
    }
}
