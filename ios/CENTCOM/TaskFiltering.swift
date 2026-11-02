import SwiftUI

enum TaskScope: String, CaseIterable, Identifiable {
    case open, all, done
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
    func includes(_ ticket: Ticket) -> Bool {
        switch self { case .open: ticket.status.isOpen; case .all: true; case .done: ticket.status == .done }
    }
    func tasks(from tickets: [Ticket], sort: TaskSort) -> [Ticket] {
        tickets.filter(includes).sorted(by: sort.precedes)
    }
}

enum TaskSort: String, CaseIterable, Identifiable {
    case priority, updated, created, title, due
    var id: String { rawValue }
    var title: String { switch self { case .priority: "Priority"; case .updated: "Recently updated"; case .created: "Newest created"; case .title: "Title A–Z"; case .due: "Due date" } }
    func precedes(_ a: Ticket, _ b: Ticket) -> Bool {
        switch self {
        case .priority:
            let x = a.priority == 0 ? 5 : a.priority, y = b.priority == 0 ? 5 : b.priority
            if x != y { return x < y }
        case .title:
            let order = a.title.localizedStandardCompare(b.title)
            if order != .orderedSame { return order == .orderedAscending }
        case .due:
            if a.due != b.due { return (a.due ?? "9999") < (b.due ?? "9999") }
        case .created:
            if a.created != b.created { return (a.created ?? 0) > (b.created ?? 0) }
        case .updated: break
        }
        return a.updated == b.updated ? a.id.localizedStandardCompare(b.id) == .orderedAscending : a.updated > b.updated
    }
}
struct TaskFilters: Equatable {
    var status = "", priority = "", assignee = "", project = "", due = ""
    var labels: [String] = []
    var count: Int { [status, priority, assignee, project, due].filter { !$0.isEmpty }.count + labels.count }
    func matches(_ ticket: Ticket, today: String) -> Bool {
        (status.isEmpty || ticket.status.rawValue == status) &&
        (priority.isEmpty || ticket.priority == Int(priority)) &&
        (assignee.isEmpty || (assignee == "__none" ? ticket.agent == nil : ticket.agent == assignee)) &&
        (project.isEmpty || (project == "__inbox" ? ticket.project == nil : ticket.project == project)) &&
        labels.allSatisfy { label in ticket.labels.contains { $0.caseInsensitiveCompare(label) == .orderedSame } } &&
        (due.isEmpty || (due == "none" ? ticket.due == nil : due == "today" ? ticket.due == today : ticket.status.isOpen && ticket.due != nil && ticket.due! < today))
    }
}
struct TaskFilterSheet: View {
    @Environment(Workspace.self) private var workspace
    @Environment(\.dismiss) private var dismiss
    @Binding var filters: TaskFilters
    let showProjects: Bool
    var scope: String? = nil
    var body: some View {
        NavigationStack {
            Form {
                Section("Match all filters") {
                    Picker("Status", selection: $filters.status) { Text("All statuses").tag(""); ForEach(TaskStatus.allCases) { Text($0.title).tag($0.rawValue) } }
                    Picker("Priority", selection: $filters.priority) { Text("All priorities").tag(""); ForEach(0..<priorities.count, id: \.self) { Text(priorities[$0]).tag(String($0)) } }
                    Picker("Assignee", selection: $filters.assignee) { Text("All assignees").tag(""); Text("Unassigned").tag("__none"); ForEach(workspace.agents) { Text($0.name).tag($0.id) } }
                    if showProjects { Picker("Project", selection: $filters.project) { Text("All projects").tag(""); Text("Inbox").tag("__inbox"); ForEach(workspace.projects) { Text($0.name).tag($0.slug) } } }
                    Picker("Due date", selection: $filters.due) { Text("Any due date").tag(""); Text("Overdue (open)").tag("overdue"); Text("Due today").tag("today"); Text("No due date").tag("none") }
                    LabelSelector(labels: $filters.labels, allowCreate: false, project: showProjects ? (filters.project.isEmpty ? nil : filters.project == "__inbox" ? nil : filters.project) : scope, allProjects: showProjects && filters.project.isEmpty)
                }
                if filters.count > 0 { Button("Clear filters") { filters = TaskFilters() } }
            }.onChange(of: filters.project) { _, _ in filters.labels = [] }.navigationTitle("Filter tasks").navigationBarTitleDisplayMode(.inline)
                .toolbar { Button("Done") { dismiss() } }

        }
    }
}

func uniqueLabels(_ labels: [String]) -> [String] {
    var result: [String] = []
    for label in labels {
        let name = String(label.split(whereSeparator: \.isWhitespace).joined(separator: " ").prefix(60))
        if !name.isEmpty && !result.contains(where: { $0.caseInsensitiveCompare(name) == .orderedSame }) { result.append(name) }
    }
    return result
}
func labelHue(_ label: String) -> Double {
    var hash = 0
    for unit in label.lowercased().utf16 { hash = (hash * 31 + Int(unit)) % 360 }
    return Double(hash) / 360
}
struct LabelChip: View {
    @Environment(Workspace.self) private var workspace
    var project: String? = nil
    let name: String
    var lineLimit: Int? = 1
    var remove: (() -> Void)? = nil
    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(workspace.labels.first { !$0.deleted && $0.project == project && $0.name.caseInsensitiveCompare(name) == .orderedSame }.map { Color(hex: $0.color) } ?? Color(hue: labelHue(name), saturation: 0.62, brightness: 0.82)).frame(width: 7, height: 7)
            Text(name).font(.caption).lineLimit(lineLimit).fixedSize(horizontal: false, vertical: true)
            if let remove { Button(action: remove) { Image(systemName: "xmark").font(.caption2) }.buttonStyle(.plain).accessibilityLabel("Remove label \(name)") }
        }.foregroundStyle(.primary).padding(.horizontal, 9).padding(.vertical, 5)
            .background(.secondary.opacity(0.08), in: Capsule()).overlay(Capsule().stroke(.secondary.opacity(0.25), lineWidth: 0.5))
    }
}
struct ChipFlow: Layout {
    var spacing: CGFloat = 6
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize { positions(width: proposal.width ?? 300, subviews: subviews).1 }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = positions(width: bounds.width, subviews: subviews)
        for (index, subview) in subviews.enumerated() { subview.place(at: CGPoint(x: bounds.minX + result.0[index].x, y: bounds.minY + result.0[index].y), proposal: ProposedViewSize(width: min(bounds.width, subview.sizeThatFits(.unspecified).width), height: nil)) }
    }
    private func positions(width: CGFloat, subviews: Subviews) -> ([CGPoint], CGSize) {
        var points: [CGPoint] = []
        var sizes: [CGSize] = []
        var rowStart = 0
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        func centerRow() {
            for index in rowStart..<points.count {
                points[index].y = y + (rowHeight - sizes[index].height) / 2
            }
        }
        for view in subviews {
            let size = view.sizeThatFits(ProposedViewSize(width: min(width, view.sizeThatFits(.unspecified).width), height: nil))
            if x > 0 && x + size.width > width {
                centerRow()
                x = 0; y += rowHeight + spacing; rowHeight = 0; rowStart = points.count
            }
            points.append(CGPoint(x: x, y: y)); sizes.append(size)
            x += size.width + spacing; rowHeight = max(rowHeight, size.height)
        }
        centerRow()
        return (points, CGSize(width: width, height: y + rowHeight))
    }
}
struct LabelSelector: View {
    @Binding var labels: [String]
    var allowCreate = true
    var project: String? = nil
    var allProjects = false
    @State private var choosing = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack { Text("Labels"); Spacer(); Button(allowCreate ? "Add label" : "Choose labels", systemImage: "tag") { choosing = true }.buttonStyle(.borderless) }
            if !labels.isEmpty { ChipFlow { ForEach(labels, id: \.self) { name in LabelChip(project: project, name: name) { labels.removeAll { $0 == name } } } } }
        }.sheet(isPresented: $choosing) { LabelChooser(labels: $labels, allowCreate: allowCreate, project: project, allProjects: allProjects) }
    }
}
private struct LabelEditRequest: Identifiable {
    let id = UUID()
    let name: String
    let label: ProjectLabel?
    var selectOnSave = false
}

func replacingLabel(_ oldName: String, with newName: String, in labels: [String]) -> [String] {
    uniqueLabels(labels.map { $0.caseInsensitiveCompare(oldName) == .orderedSame ? newName : $0 })
}

struct LabelChooser: View {
    @Environment(Workspace.self) private var workspace
    @Environment(\.dismiss) private var dismiss
    @Binding var labels: [String]
    let allowCreate: Bool
    var project: String? = nil
    var allProjects = false
    @State private var query = ""
    @State private var editingLabel: LabelEditRequest?
    private var known: [String] { uniqueLabels(workspace.labels.filter { !$0.deleted && (allProjects || $0.project == project) }.map(\.name) + labels).sorted { $0.localizedStandardCompare($1) == .orderedAscending } }
    private var name: String { uniqueLabels([query]).first ?? "" }
    var body: some View {
        NavigationStack {
            List {
                if allowCreate && !name.isEmpty && !known.contains(where: { $0.caseInsensitiveCompare(name) == .orderedSame }) {
                    Button("Create label “\(name)”", systemImage: "plus") { editingLabel = LabelEditRequest(name: name, label: nil, selectOnSave: true) }
                }
                ForEach(known.filter { query.isEmpty || $0.localizedCaseInsensitiveContains(query) }, id: \.self) { label in
                    let selected = labels.contains { $0.caseInsensitiveCompare(label) == .orderedSame }
                    HStack(spacing: 12) {
                    Button { if selected { labels.removeAll { $0.caseInsensitiveCompare(label) == .orderedSame } } else { labels.append(label) } } label: {
                        HStack { LabelChip(project: project, name: label); Spacer(); if selected { Image(systemName: "checkmark") } }
                    }.buttonStyle(.plain).foregroundStyle(.primary).accessibilityAddTraits(selected ? .isSelected : [])
                    if allowCreate && !allProjects {
                        Button {
                            editingLabel = LabelEditRequest(name: label, label: workspace.labels.first { !$0.deleted && $0.project == project && $0.name.caseInsensitiveCompare(label) == .orderedSame })
                        } label: { Image(systemName: "pencil").frame(width: 44, height: 44) }
                            .buttonStyle(.borderless).accessibilityLabel("Edit \(label) name and color")
                    }
                    }
                }
                if known.isEmpty && name.isEmpty { Text(allowCreate ? "Search to create your first label." : "No labels yet.").foregroundStyle(.secondary) }
            }.navigationTitle("Labels").navigationBarTitleDisplayMode(.inline)
                .searchable(text: $query, prompt: allowCreate ? "Find or create a label" : "Find labels")
                .toolbar { Button("Done") { dismiss() } }
                .sheet(item: $editingLabel) { request in
                    LabelEdit(project: project, label: request.label, name: request.name) { saved in
                        labels = replacingLabel(request.name, with: saved.name, in: labels)
                        if request.selectOnSave { labels = uniqueLabels(labels + [saved.name]) }
                        query = ""
                    }
                }
        }
    }
}
