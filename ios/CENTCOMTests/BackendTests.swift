import XCTest
@testable import CENTCOM

final class MockProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, data) = try Self.handler!(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

final class BackendTests: XCTestCase {
    func testConnectionRejectsInsecureOrCredentialURLs() throws {
        for address in ["http://example.com", "ftp://example.com", "https://user:pass@example.com", "https://example.com?token=secret", "https://example.com#fragment", ""] {
            XCTAssertThrowsError(try Connection(address: address, token: ""), address)
        }
        XCTAssertNoThrow(try Connection(address: "https://mac.tailnet.ts.net:8443", token: "abc"))
        XCTAssertNoThrow(try Connection(address: "http://127.0.0.1:4747", token: ""))
    }
    func testBearerAuthAndSharedAPIContract() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockProtocol.self]
        let client = APIClient(connection: try Connection(address: "https://centcom.example", token: " test-token "), session: URLSession(configuration: configuration))
        MockProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/tickets/INB-1")
            XCTAssertEqual(request.httpMethod, "PATCH")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
            return (200, Data(#"{"id":"INB-1","title":"A shared task","status":"in_review","priority":2,"labels":[],"body":"Ready","updated":123}"#.utf8))
        }
        let ticket: Ticket = try await client.request("tickets/INB-1", method: "PATCH", body: ["status": "in_review", "by": "owner"])
        XCTAssertEqual(ticket.status, .inReview)
        XCTAssertEqual(ticket.priority, 2)
        XCTAssertNil(ticket.project)
    }
    @MainActor func testTicketWritesReportDeviceSeparatelyFromActor() async throws {
        let previous = UserDefaults.standard.object(forKey: "deviceName")
        defer { UserDefaults.standard.set(previous, forKey: "deviceName"); MockProtocol.handler = nil }
        UserDefaults.standard.set("Test iPhone", forKey: "deviceName")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockProtocol.self]
        let client = APIClient(connection: try Connection(address: "https://centcom.example", token: "test"), session: URLSession(configuration: configuration))
        MockProtocol.handler = { request in
            var data = request.httpBody ?? Data()
            if let stream = request.httpBodyStream {
                stream.open(); defer { stream.close() }
                var buffer = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable {
                    let count = stream.read(&buffer, maxLength: buffer.count)
                    if count <= 0 { break }; data.append(buffer, count: count)
                }
            }
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
            XCTAssertEqual(body["device"], "Test iPhone")
            XCTAssertEqual(body["agent"], "grokbot-stan")
            return (200, Data(#"{"id":"a","ts":1,"agent":"grokbot-stan","device":"Test iPhone","type":"ticket.comment"}"#.utf8))
        }
        let event: ActivityEvent = try await client.request("tickets/INB-1/comments", method: "POST", body: ["agent":"grokbot-stan", "body":"Checked"])
        XCTAssertEqual(event.agent, "grokbot-stan")
        XCTAssertEqual(event.device, "Test iPhone")
        let legacy = try JSONDecoder().decode(ActivityEvent.self, from: Data(#"{"id":"old","ts":0,"agent":"codex-mini","type":"ticket.created"}"#.utf8))
        XCTAssertNil(legacy.device, "Never infer device from an agent's old name")
    }
    func testAuthenticationFailureIsActionable() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockProtocol.self]
        let client = APIClient(connection: try Connection(address: "https://centcom.example", token: "wrong"), session: URLSession(configuration: configuration))
        MockProtocol.handler = { _ in (401, Data(#"{"error":"Invalid token"}"#.utf8)) }
        do {
            let _: [Ticket] = try await client.request("tickets")
            XCTFail("Unauthorized response should throw")
        } catch { XCTAssertTrue(error.localizedDescription.contains("Connection")) }
    }
    func testProjectProgressExcludesCanceledTasks() throws {
        let project = try JSONDecoder().decode(Project.self, from: Data(##"{"slug":"Example","name":"Example","key":"EX","summary":"","status":"active","color":"#fff","body":"","counts":{"todo":2,"done":2,"canceled":4}}"##.utf8))
        XCTAssertEqual(project.total, 4)
        XCTAssertEqual(project.open, 2)
        XCTAssertEqual(project.progress, 0.5)
    }
}
