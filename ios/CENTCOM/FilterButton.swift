import SwiftUI

/// Shared toolbar affordance; the filled symbol means a filter is applied, not merely open.
struct FilterButton: View {
    let title: String
    let active: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: active ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
        }
        .accessibilityLabel(title)
        .accessibilityValue(active ? "Active filters" : "No filters")
    }
}

struct InventoryFilterSheet<Content: View>: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let clear: () -> Void
    @ViewBuilder let content: () -> Content
    var body: some View {
        NavigationStack {
            Form { Section { content() } }
                .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Reset", action: clear) }
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                }
        }.presentationDetents([.medium, .large])
    }
}
