import XCTest
import WebKit
@testable import CENTCOM

@MainActor final class MarkdownProbe: NSObject, WKScriptMessageHandler {
    let ready: XCTestExpectation
    var changes: [String] = []
    init(_ ready: XCTestExpectation) { self.ready = ready }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let value = message.body as? [String: Any] else { return }
        if value["ready"] as? Bool == true { ready.fulfill() }
        if let text = value["markdown"] as? String { changes.append(text) }
    }
}

final class MarkdownTests: XCTestCase {
    @MainActor func testRenderedEditingPreservesUntouchedMarkdown() async throws {
        let ready = expectation(description: "Bundled Markdown editor ready")
        let probe = MarkdownProbe(ready)
        let config = WKWebViewConfiguration()
        config.userContentController.add(probe, name: "markdown")
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 400), configuration: config)
        defer { config.userContentController.removeScriptMessageHandler(forName: "markdown") }
        let folder = try XCTUnwrap(Bundle.main.url(forResource: "Markdown", withExtension: nil))
        web.loadFileURL(folder.appendingPathComponent("index.html"), allowingReadAccessTo: folder)
        await fulfillment(of: [ready], timeout: 15)
        let markdown = "# Heading\n\nA **bold** note.\n\n- [x] Complete\n- [ ] Pending\n\n| Column | Value |\n| --- | --- |\n| A | B |\n\n```swift\nlet count = 1\n```"
        try await web.callAsyncJavaScript("window.setMarkdown(config)", arguments: ["config": ["markdown": markdown, "readOnly": false, "docPath": "Projects/Test/Library/Page.md"]], in: nil, contentWorld: .page)
        let toolbarHidden = try await web.evaluateJavaScript("document.querySelector('#toolbar').hidden") as? Bool
        XCTAssertEqual(toolbarHidden, true, "Formatting belongs above the keyboard, not inside the editor")
        let result = try await web.evaluateJavaScript("({heading:document.querySelector('h1').textContent, bold:document.querySelector('strong').textContent, tasks:document.querySelectorAll('ul[data-type=taskList] > li').length,tables:document.querySelectorAll('table').length,code:document.querySelector('pre').textContent})") as! [String: Any]
        XCTAssertEqual(result["heading"] as? String, "Heading")
        XCTAssertEqual(result["bold"] as? String, "bold")
        XCTAssertEqual(result["tasks"] as? Int, 2)
        XCTAssertEqual(result["tables"] as? Int, 1)
        XCTAssertEqual(result["code"] as? String, "let count = 1")
        let rawControlCount = try await web.evaluateJavaScript("document.querySelectorAll('#source,[aria-label=\"Toggle Markdown source\"]').length") as? Int
        XCTAssertEqual(rawControlCount, 0)
        try await web.callAsyncJavaScript("document.querySelector('.tiptap').focus(); const range = document.createRange();range.selectNodeContents(document.querySelector('h1'));const selection = window.getSelection();selection.removeAllRanges();selection.addRange(range);await new Promise(resolve => setTimeout(resolve, 50));window.markdownCommand('Italic');", arguments: [:], in: nil, contentWorld: .page)
        let heading = try await web.evaluateJavaScript("document.querySelector('h1 em').textContent") as? String
        XCTAssertEqual(heading, "Heading")
        // Formatting a rendered block must leave every untouched Markdown block intact.
        XCTAssertEqual(probe.changes.last, markdown.replacingOccurrences(of: "# Heading", with: "# *Heading*"))

    }
}
