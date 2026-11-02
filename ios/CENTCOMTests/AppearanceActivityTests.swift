import XCTest
import SwiftUI
import WebKit
@testable import CENTCOM

final class AppearanceActivityTests: XCTestCase {
    func testPreviewRetainsReadableMarkdownContent() {
        let preview = activityPreview("A **bold** update with [release notes](https://example.com) and `code`.\n\nNext paragraph.")
        XCTAssertTrue(preview.contains("bold"))
        XCTAssertTrue(preview.contains("release notes"))
        XCTAssertTrue(preview.contains("Next paragraph."))
        XCTAssertFalse(preview.contains("**"))
        XCTAssertFalse(preview.contains("https://"))
    }

    @MainActor func testActivityUsesEventProjectEvenWhenTicketIsNotLoaded() throws {
        let workspace = Workspace()
        workspace.projects = [Project(slug: "centcom", name: "CENTCOM", key: "CEN", summary: "", status: "active", color: "#fff", lead: nil, body: "", counts: [:])]
        let data = Data(#"{"id":"event","ts":0,"agent":"codex-mini","type":"ticket.comment","ticket":"CEN-1","project":"centcom"}"#.utf8)
        var event = try JSONDecoder().decode(ActivityEvent.self, from: data)
        XCTAssertEqual(workspace.projectName(for: event), "CENTCOM")
        event.project = "Archived project"
        XCTAssertEqual(workspace.projectName(for: event), "Archived project")
        event.project = nil
        XCTAssertEqual(workspace.projectName(for: event), "Inbox")
        workspace.tickets = [Ticket(id: "CEN-1", title: "Legacy event", status: .todo, priority: 0, project: "centcom", labels: [], body: "", updated: 0)]
        XCTAssertEqual(workspace.projectName(for: event), "CENTCOM")
    }

    @MainActor func testPropertyStripKeepsIntrinsicHeightUnderTallProposals() {
        for size in [DynamicTypeSize.large, .accessibility3] {
            let host = UIHostingController(rootView: TaskPropertyStrip {
                Label("In progress", systemImage: "circle").taskProperty()
                Label("A long assignee name", systemImage: "person").taskProperty()
                Label("Priority", systemImage: "chart.bar").taskProperty()
            }.environment(\.dynamicTypeSize, size))
            let compact = host.sizeThatFits(in: CGSize(width: 320, height: 100))
            let tall = host.sizeThatFits(in: CGSize(width: 320, height: 800))
            XCTAssertEqual(compact.height, tall.height, accuracy: 1)
            XCTAssertLessThan(tall.height, 160, "The horizontal row must not expand to fill the editor")
            XCTAssertGreaterThan(tall.height, 20)
        }
    }

    @MainActor func testHorizontalBarRejectsVerticalOffsetsAndInsets() {
        let controller = HorizontalBarController(content: AnyView(HStack {
            ForEach(0..<15) { index in Text("Action \(index)").frame(width: 80, height: 44) }
        }.fixedSize()))
        controller.loadViewIfNeeded()
        controller.view.frame = CGRect(x: 0, y: 0, width: 320, height: 44)
        controller.view.layoutIfNeeded()
        let scroll = controller.scrollView
        XCTAssertEqual(scroll.contentSize.height, scroll.bounds.height, accuracy: 1)
        XCTAssertGreaterThan(scroll.contentSize.width, scroll.bounds.width)
        for y in [-80.0, 15, 80] {
            scroll.contentOffset = CGPoint(x: 120, y: y)
            XCTAssertEqual(scroll.contentOffset.y, 0)
            XCTAssertEqual(scroll.contentOffset.x, 120)
            scroll.setContentOffset(CGPoint(x: 200, y: y), animated: false)
            XCTAssertEqual(scroll.contentOffset.y, 0)
            XCTAssertEqual(scroll.contentOffset.x, 200)
        }
        XCTAssertFalse(scroll.bounces)
        XCTAssertFalse(scroll.alwaysBounceVertical)
        XCTAssertEqual(scroll.contentInsetAdjustmentBehavior, .never)
        XCTAssertEqual(scroll.keyboardDismissMode, .none)
        controller.view.frame.size.height = 88
        controller.view.layoutIfNeeded()
        XCTAssertEqual(scroll.contentSize.height, scroll.bounds.height, accuracy: 1)
        XCTAssertEqual(scroll.contentOffset.y, 0)
    }

    @MainActor func testLongActivityRowHasStableNativeLayout() async throws {
        let workspace = Workspace()
        let event = ActivityEvent(id: "long", ts: 0, agent: "codex-mini", type: "ticket.comment", ticket: "CEN-23", subject: "Update", body: String(repeating: "Long **formatted** comment with [links](https://example.com) and filenames. ", count: 100))
        for size in [DynamicTypeSize.large, .accessibility3] {
            let host = UIHostingController(rootView: EventRow(event: event).environment(workspace).environment(\.dynamicTypeSize, size))
            let first = host.sizeThatFits(in: CGSize(width: 320, height: 10_000))
            XCTAssertGreaterThan(first.height, 40)
            XCTAssertLessThan(first.height, 500, "Feed previews must remain bounded even for long comments")
            XCTAssertFalse(containsWebView(host.view), "Feed rows must not asynchronously load a web renderer")
            try await Task.sleep(for: .milliseconds(250))
            let settled = host.sizeThatFits(in: CGSize(width: 320, height: 10_000))
            XCTAssertEqual(first.height, settled.height, accuracy: 1)
        }
    }

    @MainActor func testAppearanceOverridesDeviceAndFollowsSystem() {
        for (appearance, expected) in [(AppAppearance.light, UIUserInterfaceStyle.light), (.dark, .dark), (.system, .dark)] {
            let host = UIHostingController(rootView: SettingsView().preferredColorScheme(appearance.colorScheme))
            let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first!
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
            window.overrideUserInterfaceStyle = .dark
            window.rootViewController = host
            window.makeKeyAndVisible()
            host.view.layoutIfNeeded()
            XCTAssertEqual(host.traitCollection.userInterfaceStyle, expected)
            window.isHidden = true
        }
    }

    @MainActor func testMarkdownFollowsAppAppearanceWhileDeviceIsDark() async throws {
        let workspace = Workspace()
        workspace.connection = nil
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first!
        let window = UIWindow(windowScene: scene)
        window.overrideUserInterfaceStyle = .dark
        let host = UIHostingController(rootView: MarkdownView(text: .constant("# Theme check"), readOnly: true).environment(workspace).environment(\.colorScheme, .light))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        host.view.layoutIfNeeded()
        let web = try XCTUnwrap(findWebView(host.view))
        for _ in 0..<100 {
            if (try? await web.evaluateJavaScript("typeof window.setMarkdown === 'function'")) as? Bool == true { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTAssertEqual(web.overrideUserInterfaceStyle, .light)
        let light = try await web.evaluateJavaScript("matchMedia('(prefers-color-scheme: dark)').matches") as? Bool
        XCTAssertEqual(light, false)
        host.rootView = MarkdownView(text: .constant("# Theme check"), readOnly: true).environment(workspace).environment(\.colorScheme, .dark)
        host.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(web.overrideUserInterfaceStyle, .dark)
        let dark = try await web.evaluateJavaScript("matchMedia('(prefers-color-scheme: dark)').matches") as? Bool
        XCTAssertEqual(dark, true)
    }

    @MainActor private func findWebView(_ view: UIView) -> WKWebView? {
        if let web = view as? WKWebView { return web }
        return view.subviews.compactMap { findWebView($0) }.first
    }

    @MainActor func testVisualReviewScreens() async throws {
        let workspace = Workspace()
        workspace.connection = nil
        workspace.projects = [Project(slug: "CENTCOM", name: "CENTCOM", key: "CEN", summary: "Your shared workspace", status: "active", color: "#7C83DB", lead: nil, body: "", counts: ["in_progress": 2, "todo": 4])]
        workspace.tickets = (1...9).map { index in
            Ticket(id: "CEN-\(index)", title: ["Refine the iPhone experience", "Add independent light and dark appearance", "Keep activity text stable while scrolling"][index % 3], status: index < 4 ? .inProgress : .todo, priority: 2, project: "CENTCOM", labels: index % 2 == 0 ? ["iOS", "Design", "A longer label to check wrapping"] : ["Bug", "Polish"], body: "", updated: 0)
        }
        workspace.labels = [ProjectLabel(id: "ios", project: "CENTCOM", name: "iOS", color: "#7C83DB", deleted: false), ProjectLabel(id: "design", project: "CENTCOM", name: "Design", color: "#F59E0B", deleted: false)]
        workspace.activity = (1...20).map { index in
            ActivityEvent(id: "event-\(index)", ts: Date().timeIntervalSince1970 * 1000 - Double(index * 60_000), agent: "codex-mini", type: "ticket.comment", ticket: "CEN-\(index)", subject: "Update", body: String(repeating: "Updated the iOS layout with compact rows and a saved appearance setting. ", count: index))
        }
        for scheme in [ColorScheme.light, .dark] {
            try await capture(TabView { NavigationStack { TaskList(title: "Tasks") }.tabItem { Label("Tasks", systemImage: "checklist") }; NavigationStack { ActivityView() }.tabItem { Label("Activity", systemImage: "waveform.path") } }.environment(workspace), scheme: scheme, name: "tasks")
            try await capture(NavigationStack { TaskDetailView(id: "CEN-2") }.environment(workspace), scheme: scheme, name: "detail-labels")
            let empty = Ticket(id: "INB-1", title: "Task with no optional properties", status: .todo, priority: 0, labels: [], body: "", updated: 0)
            workspace.tickets.append(empty)
            try await capture(NavigationStack { TaskDetailView(id: empty.id) }.environment(workspace), scheme: scheme, name: "detail-minimal")
            workspace.tickets.removeAll { $0.id == empty.id }
            try await capture(TaskPropertiesEditor(ticket: workspace.tickets[1]).environment(workspace), scheme: scheme, name: "properties")
            try await capture(LabelChooser(labels: .constant(["iOS"]), allowCreate: true, project: "CENTCOM").environment(workspace), scheme: scheme, name: "label-chooser")
            try await capture(LabelEdit(project: "CENTCOM", label: workspace.labels[0]).environment(workspace), scheme: scheme, name: "label-edit")
            try await capture(TaskEditor(ticket: workspace.tickets[1]).environment(workspace), scheme: scheme, name: "editor")
            try await capture(NavigationStack { ActivityView() }.environment(workspace), scheme: scheme, name: "activity")
            try await capture(NavigationStack { ProjectsView() }.environment(workspace), scheme: scheme, name: "projects")
            try await capture(NavigationStack { SettingsView() }.environment(workspace), scheme: scheme, name: "settings")
        }
    }

    @MainActor private func capture<V: View>(_ view: V, scheme: ColorScheme, name: String) async throws {
        let host = UIHostingController(rootView: view.tint(.primary).environment(\.colorScheme, scheme))
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first!
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        window.overrideUserInterfaceStyle = scheme == .dark ? .dark : .light
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(350))
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
        let attachment = XCTAttachment(image: image)
        attachment.name = "\(name)-\(scheme)"
        attachment.lifetime = .keepAlways
        add(attachment)
        let output = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("\(name)-\(scheme).png")
        try image.pngData()?.write(to: output)
        window.isHidden = true
    }

    @MainActor private func containsWebView(_ view: UIView) -> Bool {
        view is WKWebView || view.subviews.contains(where: containsWebView)
    }
}
