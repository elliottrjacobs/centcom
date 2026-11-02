import SwiftUI
import WebKit

@MainActor @Observable final class MarkdownKeyboard {
    weak var webView: WKWebView?
    var focused = false
    var keyboardVisible = false
    func command(_ name: String) {
        webView?.callAsyncJavaScript("window.markdownCommand(name)", arguments: ["name": name], in: nil, in: .page) { _ in }
    }
}
private struct MarkdownKeyboardModifier: ViewModifier {
    @State private var keyboard = MarkdownKeyboard()
    private let actions: [(String,String)] = [("Bold","bold"),("Italic","italic"),("Heading","textformat.size"),("Bulleted list","list.bullet"),("Checklist","checklist"),("Numbered list","list.number"),("Quote","text.quote"),("Inline code","chevron.left.forwardslash.chevron.right"),("Link","link"),("Image","photo"),("Code block","curlybraces"),("Table","tablecells"),("Undo","arrow.uturn.backward"),("Redo","arrow.uturn.forward")]
    func body(content: Content) -> some View {
        content.environment(keyboard)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if keyboard.focused && keyboard.keyboardVisible {
                    HStack(spacing: 0) {
                        LockedHorizontalBar {
                            HStack(spacing: 2) {
                                ForEach(actions, id: \.0) { name, symbol in
                                    Button { keyboard.command(name) } label: { Image(systemName: symbol).font(.system(size: 18)).frame(width: 44, height: 44) }.buttonStyle(.plain).accessibilityLabel(name)
                                }
                            }.fixedSize(horizontal: true, vertical: true)
                        }
                        Divider().frame(height: 24)
                        Button { keyboard.webView?.endEditing(true); keyboard.focused = false } label: { Image(systemName: "keyboard.chevron.compact.down").frame(width: 44, height: 44) }.buttonStyle(.plain).accessibilityLabel("Dismiss keyboard")
                    }.padding(.horizontal, 8).background(.regularMaterial, in: Capsule()).padding(.horizontal, 12).padding(.vertical, 6)
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in keyboard.keyboardVisible = true }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in keyboard.keyboardVisible = false }
            .onDisappear { keyboard.focused = false; keyboard.webView = nil }
    }
}
extension View { func markdownKeyboardToolbar() -> some View { modifier(MarkdownKeyboardModifier()) } }
