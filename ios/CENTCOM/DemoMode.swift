import Foundation

/// Demo mode answers the app's API requests to a reserved, unresolvable host from a bundled
/// snapshot of a fictional workspace (`Resources/Demo/demo.json`, recorded from a real server by
/// `pnpm build:ios-demo`). Nothing leaves the phone, and changes are refused with an explanation.
/// It lets anyone, App Review included, try the app without running a server.
final class DemoURLProtocol: URLProtocol {
    static let host = "demo.centcom.invalid"
    static let address = "https://demo.centcom.invalid"
    static let token = "demo"
    static let readOnlyMessage = "This is a demo workspace, so changes are not saved. Connect to your own CENTCOM server to make changes."

    private static let responses: [String: Data] = {
        guard let url = Bundle.main.url(forResource: "demo", withExtension: "json", subdirectory: "Demo"),
              let data = try? Data(contentsOf: url),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return object.compactMapValues { try? JSONSerialization.data(withJSONObject: $0, options: [.fragmentsAllowed]) }
    }()

    static func isDemo(_ url: URL?) -> Bool { url?.host == host }

    /// `<path after /api/>[?name=value&…]`, query items sorted and decoded: the fixture's keys.
    static func key(for url: URL) -> String {
        let parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
        var path = parts?.path ?? url.path
        if path.hasPrefix("/api/") { path.removeFirst("/api/".count) }
        let query = (parts?.queryItems ?? []).sorted { $0.name < $1.name }.map { "\($0.name)=\($0.value ?? "")" }.joined(separator: "&")
        return query.isEmpty ? path : "\(path)?\(query)"
    }

    override class func canInit(with request: URLRequest) -> Bool { isDemo(request.url) }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else { return }
        let (status, body): (Int, Data)
        if (request.httpMethod ?? "GET") != "GET" {
            (status, body) = (403, Self.error(Self.readOnlyMessage))
        } else if let data = Self.responses[Self.key(for: url)] {
            (status, body) = (200, data)
        } else {
            (status, body) = (404, Self.error("That is not part of the demo workspace."))
        }
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func error(_ message: String) -> Data {
        (try? JSONSerialization.data(withJSONObject: ["error": message])) ?? Data()
    }
}
