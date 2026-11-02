import SwiftUI

/// Own the search field's placement so iOS cannot move it below our custom page bar.
private struct PageSearchField: View {
    @Binding var text: String
    let prompt: String
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary).accessibilityHidden(true)
            TextField(prompt, text: $text)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .submitLabel(.search).focused($focused).onSubmit { focused = false }
                .accessibilityIdentifier("page-search")
            if !text.isEmpty {
                Button { text = "" } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                }.buttonStyle(.plain).accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 12).frame(minHeight: 44)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal, 16).padding(.vertical, 8)
        .background(.background)
    }
}

extension View {
    func pageSearch(text: Binding<String>, prompt: String) -> some View {
        safeAreaInset(edge: .top, spacing: 0) { PageSearchField(text: text, prompt: prompt) }
    }
}
