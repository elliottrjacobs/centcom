import XCTest
@testable import CENTCOM

final class DemoModeTests: XCTestCase {
    func testKeysMatchTheRecordedFixture() throws {
        XCTAssertEqual(DemoURLProtocol.key(for: URL(string: "https://demo.centcom.invalid/api/tickets")!), "tickets")
        XCTAssertEqual(DemoURLProtocol.key(for: URL(string: "https://demo.centcom.invalid/api/doc?path=Projects/Website%20relaunch/project.md")!), "doc?path=Projects/Website relaunch/project.md")
        XCTAssertTrue(DemoURLProtocol.isDemo(URL(string: DemoURLProtocol.address)))
        XCTAssertFalse(DemoURLProtocol.isDemo(URL(string: "https://centcom.example.com")))
    }

    func testDemoAnswersReadsAndRefusesWrites() async throws {
        let client = APIClient(connection: try Connection(address: DemoURLProtocol.address, token: DemoURLProtocol.token))
        URLProtocol.registerClass(DemoURLProtocol.self)
        let info: ServerInfo = try await client.request("info")
        XCTAssertEqual(info.name, "centcom")
        let tickets: [Ticket] = try await client.request("tickets")
        XCTAssertFalse(tickets.isEmpty)
        do {
            let _: Ticket = try await client.request("tickets", method: "POST", body: ["title": "Nope"])
            XCTFail("demo writes must be refused")
        } catch {
            XCTAssertEqual(error.localizedDescription, DemoURLProtocol.readOnlyMessage)
        }
    }
}
