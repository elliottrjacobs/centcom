import SwiftUI
import WebKit

/// The same Markdown schema as desktop, bundled locally for offline rendering.
struct MarkdownView: View {
    @Environment(Workspace.self) private var workspace
    @Environment(\.colorScheme) private var colorScheme
    @Environment(MarkdownKeyboard.self) private var keyboard: MarkdownKeyboard?
    @Binding var text: String
    var readOnly = false
    var docPath = ""
    var editingHeight: CGFloat = 360
    @State private var height: CGFloat = 80
    var body: some View {
        MarkdownWebView(text: $text, height: $height, readOnly: readOnly, docPath: docPath, connection: workspace.connection, keyboard: keyboard, colorScheme: colorScheme)
            .frame(height: readOnly ? height : editingHeight)
            .clipped()
    }
}

private struct MarkdownWebView: UIViewRepresentable {
    @Binding var text: String
    @Binding var height: CGFloat
    let readOnly: Bool
    let docPath: String
    let connection: Connection?
    let keyboard: MarkdownKeyboard?
    let colorScheme: ColorScheme
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(context.coordinator, name: "markdown")
        config.setURLSchemeHandler(context.coordinator, forURLScheme: "centcom-vault")
        let view = WKWebView(frame: .zero, configuration: config)
        view.overrideUserInterfaceStyle = colorScheme == .dark ? .dark : .light
        view.clipsToBounds = true
        view.isOpaque = false; view.backgroundColor = .clear; view.scrollView.backgroundColor = .clear
        view.scrollView.isScrollEnabled = !readOnly
        view.navigationDelegate = context.coordinator; view.uiDelegate = context.coordinator
        context.coordinator.webView = view
        if let folder = Bundle.main.url(forResource: "Markdown", withExtension: nil),
           FileManager.default.fileExists(atPath: folder.appendingPathComponent("index.html").path) {
            view.loadFileURL(folder.appendingPathComponent("index.html"), allowingReadAccessTo: folder)
        }
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {
        view.overrideUserInterfaceStyle = colorScheme == .dark ? .dark : .light
        context.coordinator.parent = self
        context.coordinator.sync()
    }
    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "markdown")
        coordinator.tasks.values.forEach { $0.cancel() }
        coordinator.tasks.removeAll()
        view.navigationDelegate = nil; view.uiDelegate = nil
    }
    @MainActor final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate, WKURLSchemeHandler {
        var parent: MarkdownWebView
        weak var webView: WKWebView?
        var ready = false
        var lastText: String?
        var tasks: [ObjectIdentifier: Task<Void, Never>] = [:]
        init(_ parent: MarkdownWebView) { self.parent = parent }
        func sync() {
            guard ready, lastText != parent.text else { return }
            lastText = parent.text
            webView?.callAsyncJavaScript("window.setMarkdown(config)", arguments: ["config": ["markdown": parent.text, "readOnly": parent.readOnly, "docPath": parent.docPath]], in: nil, in: .page) { _ in }
        }
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame, let body = message.body as? [String: Any] else { return }
            if let focused = body["focused"] as? Bool, !parent.readOnly {
                if focused { parent.keyboard?.webView = webView; parent.keyboard?.focused = true }
                else if parent.keyboard?.webView === webView { parent.keyboard?.focused = false }
            }
            if body["ready"] as? Bool == true { ready = true; sync() }
            if let text = body["markdown"] as? String, !parent.readOnly { lastText = text; parent.text = text }
            if let height = body["height"] as? Double, abs(parent.height - height) > 1 { parent.height = min(max(height, 30), 100_000) }
        }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if action.navigationType == .linkActivated, let url = action.request.url {
                if ["https", "http", "mailto"].contains(url.scheme ?? "") { UIApplication.shared.open(url) }
                decisionHandler(.cancel)
            } else { decisionHandler(action.request.url?.isFileURL == true ? .allow : .cancel) }
        }
        func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
            let alert = UIAlertController(title: prompt, message: nil, preferredStyle: .alert)
            alert.addTextField { $0.text = defaultText; $0.keyboardType = .URL; $0.autocapitalizationType = .none }
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
            alert.addAction(UIAlertAction(title: "Insert", style: .default) { _ in completionHandler(alert.textFields?.first?.text) })
            var controller = webView.window?.rootViewController
            while let presented = controller?.presentedViewController { controller = presented }
            guard let controller else { completionHandler(nil); return }
            controller.present(alert, animated: true)
        }
        func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
            guard let connection = parent.connection, let original = urlSchemeTask.request.url,
                  let path = URLComponents(url: original, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "path" })?.value,
                  !path.hasPrefix("/"), !path.split(separator: "/").contains("..") else {
                urlSchemeTask.didFailWithError(URLError(.badURL)); return
            }
            let id = ObjectIdentifier(urlSchemeTask)
            tasks[id] = Task {
                defer { tasks[id] = nil }
                do {
                    var request = URLRequest(url: connection.url.appending(path: "api/raw").appending(path: path))
                    request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
                    let (data, response) = try await URLSession.shared.data(for: request)
                    try Task.checkCancellation()
                    guard let response = response as? HTTPURLResponse, response.statusCode == 200,
                          response.mimeType?.hasPrefix("image/") == true else { throw URLError(.badServerResponse) }
                    urlSchemeTask.didReceive(URLResponse(url: original, mimeType: response.mimeType, expectedContentLength: data.count, textEncodingName: nil))
                    urlSchemeTask.didReceive(data); urlSchemeTask.didFinish()
                } catch { if !Task.isCancelled { urlSchemeTask.didFailWithError(error) } }
            }
        }
        func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) { tasks.removeValue(forKey: ObjectIdentifier(urlSchemeTask))?.cancel() }
    }
}
