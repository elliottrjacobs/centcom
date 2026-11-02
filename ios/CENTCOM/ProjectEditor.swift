import SwiftUI

let projectIcons: [(id: String, symbol: String)] = [
    ("Box", "shippingbox"), ("Command", "command"), ("BookOpen", "book"), ("Video", "film"),
    ("Palette", "paintpalette"), ("Image", "photo"), ("Globe", "globe"), ("Folder", "folder"),
    ("Rocket", "paperplane"), ("Target", "target"), ("Bolt", "bolt"), ("User", "person"),
    ("Map", "map"), ("Code", "chevron.left.forwardslash.chevron.right"), ("Bulb", "lightbulb"), ("Music", "music.note"),
    ("Camera", "camera"), ("Bookmark", "bookmark"), ("Cloud", "cloud"), ("Heart", "heart"), ("Home", "house"), ("Briefcase", "briefcase"), ("Users", "person.2"), ("Tree", "tree"), ("Coffee", "cup.and.saucer"), ("Gift", "gift"), ("Star", "star"), ("Sun", "sun.max"), ("Moon", "moon"), ("Headphone", "headphones"), ("Microphone", "mic"), ("Gamepad", "gamecontroller"), ("Car", "car"), ("Airplane", "airplane"), ("Wallet", "wallet.pass"), ("Chart", "chart.bar"), ("Shield", "shield"), ("Lock", "lock"), ("Database", "externaldrive"), ("Monitor", "desktopcomputer"), ("Mobile", "iphone"), ("GraduationCap", "graduationcap"), ("ShoppingBag", "bag"), ("ShoppingCart", "cart"), ("Compass", "safari"), ("Leaf", "leaf"), ("Flask", "flask"), ("Building", "building.2")
]
let projectColors = ["#64748b", "#3b82f6", "#14b8a6", "#22c55e", "#eab308", "#f97316", "#ef4444", "#ec4899", "#8b5cf6", "#a16207"]

struct ProjectBadge: View {
    @Environment(\.colorScheme) private var colorScheme
    let project: Project
    var body: some View {
        Image(systemName: projectIcons.first { $0.id == project.icon }?.symbol ?? "shippingbox")
            .foregroundStyle(project.tint).brightness(colorScheme == .dark ? 0.18 : 0)
    }
}
struct StatusValue: View {
    let status: TaskStatus
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: status.symbol).font(.system(size: 16)).frame(width: 18, height: 18)
            Text(status.title)
        }.foregroundStyle(.secondary)
    }
}

struct ProjectEditor: View {
    @Environment(Workspace.self) private var workspace
    @Environment(\.dismiss) private var dismiss
    let project: Project?
    var onSaved: ((String) -> Void)?
    @State private var name: String
    @State private var summary: String
    @State private var about: String
    @State private var icon: String
    @State private var color: String
    @State private var status: String
    @State private var busy = false
    @State private var error: String?
    @State private var discard = false
    init(project: Project? = nil, onSaved: ((String) -> Void)? = nil) {
        self.project = project; self.onSaved = onSaved
        _name = State(initialValue: project?.name ?? "")
        _summary = State(initialValue: project?.summary ?? "")
        _about = State(initialValue: project?.body ?? "")
        _icon = State(initialValue: project?.icon ?? "Box")
        _color = State(initialValue: project?.color ?? projectColors[0])
        _status = State(initialValue: project?.status ?? "active")
    }
    private var dirty: Bool {
        name != (project?.name ?? "") || summary != (project?.summary ?? "") || about != (project?.body ?? "") || icon != (project?.icon ?? "Box") || color != (project?.color ?? projectColors[0]) || status != (project?.status ?? "active")
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("Project") {
                    TextField("Project name", text: $name)
                    TextField("Short summary", text: $summary, axis: .vertical)
                    Picker("Status", selection: $status) {
                        ForEach(["backlog", "planned", "active", "paused", "completed", "canceled"], id: \.self) { Text($0.capitalized).tag($0) }
                    }
                }
                Section("Icon") {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 42))], spacing: 8) {
                        ForEach(projectIcons, id: \.id) { item in
                            Button { icon = item.id } label: {
                                Image(systemName: item.symbol).font(.system(size: 20)).frame(width: 42, height: 42)
                                    .background(icon == item.id ? Color.primary.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 8))
                            }.buttonStyle(.plain).accessibilityLabel(item.id).accessibilityAddTraits(icon == item.id ? [.isSelected] : [])
                        }
                    }
                }
                Section("Color") {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 42))], spacing: 8) {
                        ForEach(projectColors, id: \.self) { value in
                            Button { color = value } label: {
                                Circle().fill(Color(hex: value)).frame(width: 30, height: 30)
                                    .overlay { if color.lowercased() == value { Image(systemName: "checkmark").font(.caption.bold()).foregroundStyle(.white).shadow(radius: 1) } }
                                    .frame(width: 42, height: 42)
                            }.buttonStyle(.plain).accessibilityLabel(value).accessibilityAddTraits(color.lowercased() == value ? [.isSelected] : [])
                        }
                    }
                }
                Section("About this project") { MarkdownView(text: $about, docPath: "Projects/\(project?.slug ?? name)/project.md") }
                if let error { Text(error).foregroundStyle(.red) }
            }.markdownKeyboardToolbar().navigationTitle(project == nil ? "New project" : "Edit project").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { if dirty { discard = true } else { dismiss() } }.disabled(busy) }
                    ToolbarItem(placement: .confirmationAction) { Button { save() } label: { Text(busy ? "Saving…" : "Save").foregroundStyle(.white) }.buttonStyle(.borderedProminent).tint(.navy).foregroundStyle(.white).disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
                }.interactiveDismissDisabled(busy || dirty)
                .confirmationDialog("Discard project changes?", isPresented: $discard, titleVisibility: .visible) { Button("Discard changes", role: .destructive) { dismiss() } }
        }
    }
    private func save() {
        busy = true; error = nil
        Task {
            defer { busy = false }
            do {
                guard let client = workspace.client else { throw ClientError.message("Connect to your server first.") }
                let result: Project = try await client.request(project.map { "projects/\($0.slug)" } ?? "projects", method: project == nil ? "POST" : "PATCH", body: ["name": name, "summary": summary, "body": about, "icon": icon, "color": color, "status": status, "agent": workspace.userID])
                await workspace.refresh(); onSaved?(result.slug); dismiss()
            } catch { self.error = error.localizedDescription }
        }
    }
}
