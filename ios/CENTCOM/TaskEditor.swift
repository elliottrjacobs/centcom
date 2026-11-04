import SwiftUI

struct TaskEditor: View {
    @Environment(Workspace.self) private var workspace
    @Environment(\.dismiss) private var dismiss
    let ticket: Ticket?
    @State private var title: String
    @State private var details: String
    @State private var project: String
    @State private var status: TaskStatus
    @State private var priority: Int
    @State private var assignee: String
    @State private var due: Date
    @State private var hasDue: Bool
    @State private var labels: [String]
    @State private var choosingLabels = false
    @State private var choosingDate = false
    @State private var creatingProject = false
    @FocusState private var titleFocused: Bool
    @State private var busy = false
    @State private var error: String?

    // This sheet owns an editing draft. Live refreshes must not replace unsaved input.
    init(ticket: Ticket? = nil, project: String? = nil) {
        self.ticket = ticket
        _title = State(initialValue: ticket?.title ?? "")
        _details = State(initialValue: ticket?.body ?? "")
        _project = State(initialValue: ticket?.project ?? project ?? "")
        _status = State(initialValue: ticket?.status ?? .todo)
        _priority = State(initialValue: ticket?.priority ?? 0)
        _assignee = State(initialValue: ticket?.agent ?? "")
        _labels = State(initialValue: ticket?.labels ?? [])
        _hasDue = State(initialValue: ticket?.due != nil)
        _due = State(initialValue: Self.dateFormatter.date(from: ticket?.due ?? "") ?? Date())
    }
    static var dateFormatter: DateFormatter {
        let format = DateFormatter(); format.locale = Locale(identifier: "en_US_POSIX"); format.dateFormat = "yyyy-MM-dd"; return format
    }
    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        TextField("Task title", text: $title, axis: .vertical).font(.title2.weight(.semibold)).focused($titleFocused).accessibilityIdentifier("task-title")
                        MarkdownView(text: $details, docPath: "Projects/\(project)/Tickets/\(ticket?.id ?? "New").md", editingHeight: max(220, geometry.size.height - 100)).accessibilityIdentifier("task-description")
                        if let error { Text(error).foregroundStyle(.red).font(.footnote) }
                    }.padding(.horizontal, 22).padding(.top, 16)
                }.scrollDismissesKeyboard(.interactively)
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { properties.padding(.vertical, 8).background(Color(uiColor: .systemBackground)) }
            .markdownKeyboardToolbar()
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel("Cancel").disabled(busy) }
                ToolbarItem(placement: .principal) {
                    Menu {
                        Picker("Project", selection: $project) { Text("Inbox").tag(""); ForEach(workspace.projects) { Text($0.name).tag($0.slug) } }
                        Divider()
                        Button("New project…", systemImage: "plus") { creatingProject = true }
                    } label: {
                        HStack(spacing: 7) { if let selected = workspace.projects.first(where: { $0.slug == project }) { ProjectBadge(project: selected); Text(selected.name).lineLimit(1) } else { Label("Inbox", systemImage: "tray") } }.font(.subheadline.weight(.medium))
                    }.labelStyle(.titleAndIcon).foregroundStyle(.primary).accessibilityLabel("Project")
                }
                ToolbarItem(placement: .confirmationAction) { Button { save() } label: { Image(systemName: "arrow.up").fontWeight(.semibold).foregroundStyle(.white) }.buttonStyle(.borderedProminent).tint(.navy).accessibilityLabel("Save task").disabled(busy || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
            }
            .sheet(isPresented: $creatingProject) { ProjectEditor { project = $0 } }
            .sheet(isPresented: $choosingLabels) { LabelChooser(labels: $labels, allowCreate: true, project: project.isEmpty ? nil : project) }
            .sheet(isPresented: $choosingDate) { NavigationStack { Form { Toggle("Due date", isOn: $hasDue); if hasDue { DatePicker("Due", selection: $due, displayedComponents: .date) } }.navigationTitle("Due date").toolbar { Button("Done") { choosingDate = false } } }.presentationDetents([.medium]) }
            .interactiveDismissDisabled(busy)
            .onChange(of: project) { _, _ in labels = [] }
        }
    }
    private var properties: some View {
        TaskPropertyStrip {
                Menu { Picker("Status", selection: $status) { ForEach(TaskStatus.allCases) { StatusValue(status: $0).tag($0) } } } label: { Label(status.title, systemImage: status.symbol) }.taskProperty()
                Menu { Picker("Assignee", selection: $assignee) { Text("Unassigned").tag(""); ForEach(workspace.agents) { Text($0.name).tag($0.id) } } } label: { Label(workspace.agentName(assignee.isEmpty ? nil : assignee), systemImage: "person.crop.circle").lineLimit(1) }.taskProperty()
                Menu { Picker("Priority", selection: $priority) { ForEach(0..<priorities.count, id: \.self) { Text(priorities[$0]).tag($0) } } } label: { Label(priority == 0 ? "Priority" : priorities[priority], systemImage: priority == 1 ? "exclamationmark.square.fill" : "chart.bar.fill") }.taskProperty()
                Button { choosingLabels = true } label: { Label(labels.isEmpty ? "Labels" : "\(labels.count) labels", systemImage: "tag") }.taskProperty()
                Button { choosingDate = true } label: { Label(hasDue ? Self.dateFormatter.string(from: due) : "Due date", systemImage: "calendar") }.taskProperty()
        }
    }
    private func save() {
        busy = true; error = nil
        let body: [String: Any] = ["title": title.trimmingCharacters(in: .whitespacesAndNewlines), "body": details,
                                  "project": project.isEmpty ? NSNull() : project as Any, "status": status.rawValue, "priority": priority,
                                  "agent": assignee.isEmpty ? NSNull() : assignee as Any,
                                  "due": hasDue ? Self.dateFormatter.string(from: due) as Any : NSNull(),
                                  "labels": uniqueLabels(labels)]
        Task {
            defer { busy = false }
            do {
                if let ticket { try await workspace.update(ticket, fields: body) }
                else { _ = try await workspace.create(fields: body) }
                dismiss()
            } catch { self.error = error.localizedDescription }
        }
    }
}

struct TaskDetailView: View {
    @Environment(Workspace.self) private var workspace
    let id: String
    @State private var editing = false
    @State private var choosingLabels = false
    @State private var draftLabels: [String] = []
    @State private var choosingDate = false
    @State private var draftDue = Date()
    @State private var hasDue = false
    @State private var busy = false
    @State private var error: String?
    @State private var detail: TicketDetail?
    private var ticket: Ticket? { workspace.tickets.first { $0.id == (detail?.ticket.id ?? id) } ?? detail?.ticket }
    @State private var commenting = false
    @State private var editingComment: ActivityEvent?
    @State private var deletingComment: ActivityEvent?
    @State private var showingProperties = false
    var body: some View {
        Group {
            if let ticket {
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        VStack(alignment: .leading, spacing: 10) {
                            Text(ticket.id).font(.subheadline).foregroundStyle(.secondary)
                            Text(ticket.title).font(.title2.weight(.semibold)).textSelection(.enabled)
                        }
                        ChipFlow(spacing: 6) {
                            Menu { ForEach(TaskStatus.allCases) { status in Button(status.title, systemImage: status.symbol) { update(ticket, fields: ["status": status.rawValue]) } } } label: { Label(ticket.status.title, systemImage: ticket.status.symbol) }.taskProperty().disabled(busy)
                            if ticket.priority > 0 {
                                Menu { ForEach(0..<priorities.count, id: \.self) { priority in Button(priorities[priority]) { update(ticket, fields: ["priority": priority]) } } } label: { Label(priorities[min(ticket.priority, 4)], systemImage: ticket.priority == 1 ? "exclamationmark.square.fill" : "chart.bar.fill") }.taskProperty()
                            }
                            if ticket.agent != nil {
                                Menu {
                                    Button("Unassigned") { update(ticket, fields: ["agent": NSNull()]) }
                                    ForEach(workspace.agents) { agent in Button(agent.name) { update(ticket, fields: ["agent": agent.id]) } }
                                } label: { Label(workspace.agentName(ticket.agent), systemImage: "person.crop.circle") }.taskProperty()
                            }
                            ForEach(uniqueLabels(ticket.labels), id: \.self) { name in
                                Button { draftLabels = ticket.labels; choosingLabels = true } label: {
                                    LabelChip(project: ticket.project, name: name, lineLimit: nil)
                                }.buttonStyle(.plain).accessibilityLabel("Edit label \(name)")
                            }
                            if ticket.project != nil {
                                Menu {
                                    Button("Inbox") { update(ticket, fields: ["project": NSNull()]) }
                                    ForEach(workspace.projects) { project in Button(project.name) { update(ticket, fields: ["project": project.slug]) } }
                                } label: {
                                    if let project = workspace.projects.first(where: { $0.slug == ticket.project }) { HStack(spacing: 6) { ProjectBadge(project: project); Text(project.name) } }
                                    else { Label(ticket.project ?? "Inbox", systemImage: "folder") }
                                }.taskProperty()
                            }
                            if let due = ticket.due {
                                Button { hasDue = true; draftDue = TaskEditor.dateFormatter.date(from: due) ?? Date(); choosingDate = true } label: { Label(due, systemImage: "calendar") }.taskProperty()
                            }
                            Button { showingProperties = true } label: { Image(systemName: "plus") }.taskProperty().accessibilityLabel("Edit properties")
                        }.disabled(busy).padding(10).background(.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 18))
                        if !ticket.body.isEmpty { MarkdownView(text: .constant(ticket.body), readOnly: true, docPath: "Projects/\(ticket.project ?? "Inbox")/Tickets/\(ticket.id).md") }
                        if let children = detail?.children, !children.isEmpty {
                            Text("Subtasks").font(.headline)
                            ForEach(children) { child in NavigationLink { TaskDetailView(id: child.id) } label: { TaskRow(ticket: child) } }
                        }
                        HStack(alignment: .firstTextBaseline) {
                            Text("Last reported device").foregroundStyle(.secondary)
                            Spacer()
                            Text(mergedEvents().first(where: { $0.device != nil })?.device ?? "Not reported").multilineTextAlignment(.trailing)
                        }.font(.caption)
                        if let report = mergedEvents().first(where: { $0.device != nil }) {
                            Text("Reported by \(workspace.agentName(report.agent)) · \(report.date.formatted(date: .abbreviated, time: .shortened))").font(.caption2).foregroundStyle(.secondary)
                        }
                        Divider()
                        Text("Activity").font(.headline)
                        ForEach(mergedEvents()) { event in
                            EventRow(event: event, expanded: true)
                                .contextMenu {
                                    if workspace.canChange(event) {
                                        Button("Edit", systemImage: "pencil") { editingComment = event }
                                        Button("Delete", systemImage: "trash", role: .destructive) { deletingComment = event }
                                    }
                                }
                                .accessibilityActions {
                                    if workspace.canChange(event) {
                                        Button("Edit comment") { editingComment = event }
                                        Button("Delete comment") { deletingComment = event }
                                    }
                                }
                        }
                        if let error { Text(error).foregroundStyle(.red) }
                    }.padding(.horizontal, 22).padding(.vertical, 16)
                }
                .safeAreaInset(edge: .bottom) { Button { commenting = true } label: { HStack { Image(systemName: "plus"); Text("Comment…").foregroundStyle(.secondary); Spacer() }.padding(16).background(.regularMaterial, in: Capsule()) }.buttonStyle(.plain).padding(.horizontal, 20).padding(.bottom, 8) }
                .toolbar { Button("Edit", systemImage: "square.and.pencil") { editing = true } }
                .sheet(isPresented: $choosingLabels, onDismiss: {
                    if uniqueLabels(draftLabels) != uniqueLabels(ticket.labels) { update(ticket, fields: ["labels": uniqueLabels(draftLabels)]) }
                }) { LabelChooser(labels: $draftLabels, allowCreate: true, project: ticket.project) }
                .sheet(isPresented: $choosingDate) {
                    NavigationStack {
                        Form { Toggle("Due date", isOn: $hasDue); if hasDue { DatePicker("Due", selection: $draftDue, displayedComponents: .date) } }
                            .navigationTitle("Due date").navigationBarTitleDisplayMode(.inline)
                            .toolbar {
                                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { choosingDate = false } }
                                ToolbarItem(placement: .confirmationAction) { Button("Save") { update(ticket, fields: ["due": hasDue ? TaskEditor.dateFormatter.string(from: draftDue) as Any : NSNull()]); choosingDate = false } }
                            }
                    }.presentationDetents([.medium])
                }
                .sheet(isPresented: $showingProperties, onDismiss: { Task { await load() } }) { TaskPropertiesEditor(ticket: ticket) }
                .sheet(isPresented: $editing, onDismiss: { Task { await load() } }) { TaskEditor(ticket: ticket) }
                .sheet(isPresented: $commenting, onDismiss: { Task { await load() } }) { CommentComposer(ticket: ticket) }
                .sheet(item: $editingComment, onDismiss: { Task { await load() } }) { CommentComposer(ticket: ticket, editing: $0) }
                .confirmationDialog("Delete this comment?", isPresented: Binding(get: { deletingComment != nil }, set: { if !$0 { deletingComment = nil } }), titleVisibility: .visible, presenting: deletingComment) { event in
                    Button("Delete", role: .destructive) {
                        Task {
                            do { try await workspace.deleteComment(event, on: ticket.id); await load() }
                            catch { self.error = error.localizedDescription }
                        }
                    }
                } message: { _ in Text("Its text is erased for good. The thread keeps a note that it was deleted.") }
            } else { ContentUnavailableView("Task unavailable", systemImage: "doc.text.magnifyingglass", description: Text(error ?? "Refresh to try again.")) }
        }.navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await workspace.refresh(); await load() }
    }
    private func mergedEvents() -> [ActivityEvent] {
        var events = Dictionary((detail?.activity ?? []).map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
        // Whichever copy saw the later change wins, so an edit or deletion is never undone by a stale cache.
        for event in workspace.activity where event.ticket == id && (events[event.id].map { $0.lastChange < event.lastChange } ?? true) { events[event.id] = event }
        return events.values.sorted { $0.ts > $1.ts }
    }
    private func load() async {
        do { detail = try await workspace.client?.request("tickets/\(id)") }
        catch { self.error = error.localizedDescription }
    }
    private func update(_ ticket: Ticket, fields: [String: Any]) {
        busy = true; error = nil
        Task { defer { busy = false }; do { try await workspace.update(ticket, fields: fields); await load() } catch { self.error = error.localizedDescription } }
    }

}

struct TaskPropertyStrip<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        LockedHorizontalBar {
            HStack(alignment: .center, spacing: 8) { content }
                .lineLimit(1).fixedSize(horizontal: true, vertical: true)
                .padding(.horizontal, 18)
        }
    }
}

struct TaskPropertiesEditor: View {
    @Environment(Workspace.self) private var workspace
    @Environment(\.dismiss) private var dismiss
    let ticket: Ticket
    @State private var status: TaskStatus
    @State private var priority: Int
    @State private var assignee: String
    @State private var project: String
    @State private var labels: [String]
    @State private var hasDue: Bool
    @State private var due: Date
    @State private var busy = false
    @State private var error: String?

    // This sheet owns a draft until Save; background refreshes do not overwrite edits.
    init(ticket: Ticket) {
        self.ticket = ticket
        _status = State(initialValue: ticket.status)
        _priority = State(initialValue: ticket.priority)
        _assignee = State(initialValue: ticket.agent ?? "")
        _project = State(initialValue: ticket.project ?? "")
        _labels = State(initialValue: ticket.labels)
        _hasDue = State(initialValue: ticket.due != nil)
        _due = State(initialValue: TaskEditor.dateFormatter.date(from: ticket.due ?? "") ?? Date())
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        Text("Status")
                        Spacer()
                        Menu {
                            ForEach(TaskStatus.allCases) { value in
                                Button(value.title, systemImage: value.symbol) { status = value }
                            }
                        } label: {
                            HStack(spacing: 8) {
                                StatusValue(status: status)
                                Image(systemName: "chevron.up.chevron.down").font(.caption)
                            }
                        }.accessibilityLabel("Status, \(status.title)")
                    }
                    Picker("Priority", selection: $priority) { ForEach(0..<priorities.count, id: \.self) { Text(priorities[$0]).tag($0) } }
                    Picker("Assignee", selection: $assignee) {
                        Text("Unassigned").tag("")
                        ForEach(workspace.agents) { Text($0.name).tag($0.id) }
                        if !assignee.isEmpty && !workspace.agents.contains(where: { $0.id == assignee }) { Text(assignee).tag(assignee) }
                    }
                    Toggle("Due date", isOn: $hasDue)
                    if hasDue { DatePicker("Due", selection: $due, displayedComponents: .date) }
                }
                Section {
                    LabelSelector(labels: $labels, project: project.isEmpty ? nil : project)
                }
                Section {
                    Picker("Project", selection: $project) {
                        Text("Inbox").tag("")
                        ForEach(workspace.projects) { Text($0.name).tag($0.slug) }
                    }
                }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .disabled(busy)
            .navigationTitle("Properties").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }
                ToolbarItem(placement: .confirmationAction) { Button("Save", action: save).disabled(busy) }
            }
            .onChange(of: project) { _, _ in labels = [] }
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(busy)
    }

    private func save() {
        busy = true; error = nil
        // Only send changed fields so an unrelated concurrent update is preserved.
        var fields: [String: Any] = [:]
        if status != ticket.status { fields["status"] = status.rawValue }
        if priority != ticket.priority { fields["priority"] = priority }
        if assignee != (ticket.agent ?? "") { fields["agent"] = assignee.isEmpty ? NSNull() : assignee as Any }
        if project != (ticket.project ?? "") { fields["project"] = project.isEmpty ? NSNull() : project as Any }
        if uniqueLabels(labels) != uniqueLabels(ticket.labels) { fields["labels"] = uniqueLabels(labels) }
        let date = hasDue ? TaskEditor.dateFormatter.string(from: due) : nil
        if date != ticket.due { fields["due"] = date as Any? ?? NSNull() }
        Task {
            defer { busy = false }
            do {
                if !fields.isEmpty { try await workspace.update(ticket, fields: fields) }
                dismiss()
            } catch { self.error = error.localizedDescription }
        }
    }
}

private struct TaskPropertyModifier: ViewModifier {
    func body(content: Content) -> some View { content.labelStyle(.titleAndIcon).font(.subheadline).foregroundStyle(.primary).padding(.horizontal, 9).padding(.vertical, 5).background(.secondary.opacity(0.07), in: Capsule()).buttonStyle(.plain) }
}
extension View { func taskProperty() -> some View { modifier(TaskPropertyModifier()) } }
struct CommentComposer: View {
    @Environment(Workspace.self) private var workspace
    @Environment(\.dismiss) private var dismiss
    let ticket: Ticket
    /// The comment being edited; nil writes a new one.
    let editing: ActivityEvent?
    @State private var text: String
    @State private var busy = false
    @State private var error: String?
    init(ticket: Ticket, editing: ActivityEvent? = nil) {
        self.ticket = ticket
        self.editing = editing
        _text = State(initialValue: editing?.body ?? "")
    }
    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                VStack(spacing: 8) {
                    MarkdownView(text: $text, docPath: "Projects/\(ticket.project ?? "Inbox")/Tickets/\(ticket.id).md", editingHeight: max(60, geometry.size.height - (error == nil ? 40 : 80)))
                    if let error { Text(error).foregroundStyle(.red).font(.footnote) }
                }.padding(20)
            }
                .markdownKeyboardToolbar().navigationTitle(editing == nil ? "Comment" : "Edit comment").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }
                    ToolbarItem(placement: .confirmationAction) { Button(editing == nil ? "Post" : "Save") { busy = true; Task { defer { busy = false }; do { if let editing { try await workspace.editComment(editing, on: ticket.id, body: text) } else { try await workspace.comment(on: ticket.id, body: text) }; dismiss() } catch { self.error = error.localizedDescription } } }.disabled(busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
                }.interactiveDismissDisabled(busy)
        }
    }
}
