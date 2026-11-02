import XCTest
import SwiftUI
import WebKit
@testable import CENTCOM

final class AgentHomeTests: XCTestCase {
    private static let homeData = Data(##"{"agent":{"id":"grokbot-stan","name":"Stan","kind":"agent","color":"#abc","lastSeen":1000},"profile":{"id":"grokbot-stan","name":"Stan","source":"grokbot-sync","description":"# Description","instructions":"Follow the rules","skills":[{"name":"Research","description":"Find sources"}],"deliverables":[],"updated":2000,"updatedBy":"grokbot-stan","path":"Agents/grokbot-stan.md"},"deliverables":[{"id":"out","title":"Report","url":"Projects/CENTCOM/Wiki/Report.md","kind":"doc","date":"2026-10-22","addedBy":"grokbot-stan"}],"activity":[{"id":"event","ts":1000,"agent":"grokbot-stan","type":"doc.updated","device":"Grok host"}]}"##.utf8)
    func testDirectoryUsesServerMembershipRatherThanToolNamesOrActivity() throws {
        let agents = try JSONDecoder().decode([Agent].self, from: Data(#"[{"id":"codex-mini","name":"Codex Mini","showInDirectory":false},{"id":"grokbot-stan","name":"Stan","showInDirectory":true},{"id":"travel-planner","name":"Travel Planner","showInDirectory":true},{"id":"legacy","name":"Legacy"}]"#.utf8))
        XCTAssertEqual(agents.filter(\.isInDirectory).map(\.id), ["grokbot-stan", "travel-planner"])
        XCTAssertEqual(agents.count, 4, "Keep all authors for historical attribution")
    }
    func testAgentsAvailableAfterUpgradingSavedNavigation() {
        let pages = AppPage.visible("tasks,inbox,projects,activity,skills,instructions,settings", hidden: "skills")
        XCTAssertTrue(pages.contains(.agents))
        XCTAssertEqual(AppPage.opening("agents"), .agents)
        XCTAssertEqual(Array(pages.prefix(3)), [.tasks, .inbox, .projects])
    }
    func testProfileAndOutputsUseSharedServerContract() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockProtocol.self]
        let client = APIClient(connection: try Connection(address: "https://centcom.example", token: "test"), session: URLSession(configuration: configuration))
        defer { MockProtocol.handler = nil }
        MockProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/agents/grokbot-stan/home")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test")
            return (200, Self.homeData)
        }
        let home: AgentHome = try await client.request("agents/grokbot-stan/home")
        XCTAssertEqual(home.profile?.sourceLabel, "Synced from Grok Bot")
        XCTAssertEqual(home.profile?.skills.first?.name, "Research")
        XCTAssertEqual(home.profile?.instructions, "Follow the rules")
        XCTAssertEqual(home.deliverables.first?.title, "Report")
        XCTAssertEqual(home.activity.first?.device, "Grok host")
    }
    func testRegisteredBotWithoutProfileStillHasHome() throws {
        let home = try JSONDecoder().decode(AgentHome.self, from: Data(##"{"agent":{"id":"grokbot-stan","name":"Stan"},"profile":null,"deliverables":[],"activity":[]}"##.utf8))
        XCTAssertEqual(home.agent.id, "grokbot-stan")
        XCTAssertNil(home.profile)
    }
    func testOutputsOpenDocsLegacyWikiFilesAndExternalLinks() {
        XCTAssertEqual(AgentOutputTarget("Projects/Test/Wiki/Old.md"), .document("Projects/Test/Wiki/Old.md"))
        XCTAssertEqual(AgentOutputTarget("Projects/Test/Library/New.md"), .document("Projects/Test/Library/New.md"))
        XCTAssertEqual(AgentOutputTarget("Projects/Test/Library/File.pdf"), .file("Projects/Test/Library/File.pdf"))
        XCTAssertEqual(AgentOutputTarget("https://github.com/example/repo/pull/1"), .external(URL(string: "https://github.com/example/repo/pull/1")!))
        for unsafe in ["javascript:alert(1)", "file:///etc/passwd", "../private", "/private", ""] {
            XCTAssertEqual(AgentOutputTarget(unsafe), .unavailable)
        }
    }
    func testLibraryUploadUsesSharedEndpointAndHeaderAuthentication() async throws {
        let file = FileManager.default.temporaryDirectory.appending(path: "centcom-upload-test.txt")
        try Data("Shared file".utf8).write(to: file)
        defer { try? FileManager.default.removeItem(at: file); MockProtocol.handler = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockProtocol.self]
        let client = APIClient(connection: try Connection(address: "https://centcom.example", token: "test"), session: URLSession(configuration: configuration))
        MockProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/upload")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test")
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
            XCTAssertEqual(query?.first { $0.name == "dir" }?.value, "Projects/Test/Library")
            XCTAssertEqual(query?.first { $0.name == "agent" }?.value, "owner")
            XCTAssertFalse(request.url!.absoluteString.contains("token"))
            return (201, Data(##"{"path":"Projects/Test/Library/centcom-upload-test.txt","name":"centcom-upload-test.txt","type":"file","kind":"file"}"##.utf8))
        }
        let node = try await client.upload(file, directory: "Projects/Test/Library", agent: "owner")
        XCTAssertEqual(node.name, file.lastPathComponent)
    }

    @MainActor func testAgentHomeRendersAllFourSections() async throws {
        URLProtocol.registerClass(MockProtocol.self)
        defer { URLProtocol.unregisterClass(MockProtocol.self); MockProtocol.handler = nil }
        MockProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/agents/grokbot-stan/home")
            return (200, Self.homeData)
        }
        let workspace = Workspace()
        workspace.connection = try Connection(address: "https://centcom.example", token: "test")
        let host = UIHostingController(rootView: NavigationStack { AgentHomeView(id: "grokbot-stan") }.environment(workspace))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 1400)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        host.view.layoutIfNeeded()
        try await Task.sleep(for: .seconds(2))
        host.view.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
        let attachment = XCTAttachment(image: image)
        attachment.name = "agent-home-four-sections"
        attachment.lifetime = .keepAlways
        add(attachment)
        let output = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appending(path: "agent-home-four-sections.png")
        try image.pngData()?.write(to: output)
        XCTAssertTrue(hasWebView(host.view), "Description and instructions should render using the shared Markdown component")
    }
    @MainActor private func hasWebView(_ view: UIView) -> Bool {
        view is WKWebView || view.subviews.contains(where: hasWebView)
    }
}
