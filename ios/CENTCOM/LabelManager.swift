import SwiftUI
struct LabelManager: View {
    @Environment(Workspace.self) private var workspace
    @Environment(\.dismiss) private var dismiss
    let project: String?
    @State private var selected: ProjectLabel?
    @State private var creating = false
    @State private var archived = false
    @State private var deleting: ProjectLabel?
    @State private var error: String?
    @State private var busy = false
    private var labels: [ProjectLabel] { workspace.labels.filter { $0.project == project && $0.deleted == archived }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending } }
    var body: some View {
        NavigationStack {
            List {
                Section { Text("Labels belong to \(project ?? "Inbox"). Renaming updates its tasks. Deleting removes the label from them.").font(.footnote).foregroundStyle(.secondary) }
                Section {
                    ForEach(labels) { label in
                        HStack {
                            Circle().fill(Color(hex: label.color)).frame(width: 9, height: 9)
                            Text(label.name); Spacer()
                            if archived { Button("Restore") { restore(label) }.disabled(busy) }
                            else { Button("Edit") { selected = label } }
                        }.swipeActions { if !archived { Button("Delete", role: .destructive) { deleting = label } } }
                    }
                    if labels.isEmpty { Text(archived ? "No deleted labels" : "No labels yet").foregroundStyle(.secondary) }
                }
                Button(archived ? "Show active labels" : "Deleted labels") { archived.toggle() }
                if let error { Text(error).foregroundStyle(.red) }
            }.navigationTitle("\(project ?? "Inbox") labels").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }; ToolbarItem(placement: .primaryAction) { Button("New label", systemImage: "plus") { creating = true } } }
                .sheet(item: $selected) { LabelEdit(project: project, label: $0) }
                .sheet(isPresented: $creating) { LabelEdit(project: project) }
                .confirmationDialog("Delete “\(deleting?.name ?? "")”?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
                    if let label = deleting { Button("Delete label", role: .destructive) { mutate(label, deleted: true) } }
                } message: { Text("This removes the label from this project’s tasks. You can restore the label later, but its task assignments will not be restored.") }
        }
    }
    private func restore(_ label: ProjectLabel) { mutate(label, deleted: false) }
    private func mutate(_ label: ProjectLabel, deleted: Bool) {
        busy = true
        Task { defer { busy = false }; do { try await workspace.saveLabel(project: project, label: label, name: label.name, color: label.color, deleted: deleted) } catch { self.error = error.localizedDescription } }
    }
}
struct LabelEdit: View {
    @Environment(Workspace.self) private var workspace
    @Environment(\.dismiss) private var dismiss
    let project: String?
    let label: ProjectLabel?
    var onSaved: ((ProjectLabel) -> Void)?
    @State private var name: String
    @State private var color: String
    @State private var busy = false
    @State private var error: String?
    init(project: String?, label: ProjectLabel? = nil, name: String = "", onSaved: ((ProjectLabel) -> Void)? = nil) {
        self.project = project; self.label = label; self.onSaved = onSaved
        _name = State(initialValue: label?.name ?? name); _color = State(initialValue: label?.color ?? "#64748b")
    }
    var body: some View {
        NavigationStack {
            Form {
                TextField("Label name", text: $name)
                Section("Color") {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 44))]) {
                        ForEach(projectColors, id: \.self) { value in
                            Button { color = value } label: { Circle().fill(Color(hex: value)).frame(width: 30, height: 30).overlay { if color == value { Image(systemName: "checkmark").foregroundStyle(.white) } }.frame(width: 44, height: 44) }.buttonStyle(.plain).accessibilityLabel(value)
                        }
                    }
                }
                if let error { Text(error).foregroundStyle(.red) }
            }.navigationTitle(label == nil ? "New label" : "Edit label").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }
                    ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
                }.interactiveDismissDisabled(busy)
        }
    }
    private func save() {
        busy = true
        Task { defer { busy = false }; do { let saved = try await workspace.saveLabel(project: project, label: label, name: name.trimmingCharacters(in: .whitespacesAndNewlines), color: color); onSaved?(saved); dismiss() } catch { self.error = error.localizedDescription } }
    }
}
