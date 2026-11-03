import SwiftUI

@main
struct CENTCOMApp: App {
    @State private var workspace = Workspace()
    @AppStorage("appearance") private var appearance = AppAppearance.system
    /// Only ever intercepts the reserved demo host; every other request goes to the network as usual.
    init() { URLProtocol.registerClass(DemoURLProtocol.self) }
    var body: some Scene {
        WindowGroup { RootView().environment(workspace).tint(.primary).preferredColorScheme(appearance.colorScheme) }
    }
}

struct RootView: View {
    @Environment(Workspace.self) private var workspace
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        Group {
            if workspace.isConfigured {
                WorkspaceNavigation()
                .safeAreaInset(edge: .top, spacing: 0) {
                    if !workspace.online {
                        HStack { Image(systemName: "wifi.slash"); Text(workspace.error ?? "Connecting…").font(.caption); Spacer() }
                            .padding(10).background(.orange.opacity(0.12))
                    }
                }
            } else {
                NavigationStack { ConnectionView() }
            }
        }
        .task(id: "\(scenePhase)-\(workspace.connection?.url.absoluteString ?? "")") {
            guard scenePhase == .active, workspace.isConfigured else { return }
            while !Task.isCancelled {
                await workspace.refresh()
                do { try await Task.sleep(for: .seconds(5)) } catch { break }
            }
        }
    }
}

struct TaskRow: View {
    @Environment(Workspace.self) private var workspace
    let ticket: Ticket
    var showProject = true
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: ticket.status.symbol).font(.system(size: 17)).foregroundStyle(ticket.status.color).frame(width: 22).padding(.top, 2)
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .top, spacing: 12) { Text(ticket.title).font(.subheadline.weight(.medium)).lineLimit(2).foregroundStyle(.primary).frame(maxWidth: .infinity, alignment: .leading); Text(ticket.id).font(.caption).foregroundStyle(.secondary).fixedSize() }
                metadata
            }
        }.padding(.vertical, 2).accessibilityElement(children: .combine)
    }
    @ViewBuilder private var projectBadge: some View {
        if showProject, let project = workspace.projects.first(where: { $0.slug == ticket.project }) { HStack(spacing: 5) { ProjectBadge(project: project); Text(project.name).lineLimit(1) }.font(.caption).foregroundStyle(.secondary).padding(.horizontal, 9).padding(.vertical, 5).overlay(Capsule().stroke(.secondary.opacity(0.15))) }
    }
    private var metadata: some View {
        ChipFlow(spacing: 5) {
            if ticket.priority > 0 {
                HStack(spacing: 4) {
                    Image(systemName: ticket.priority == 1 ? "exclamationmark.square.fill" : "chart.bar.fill")
                    Text(priorities[min(ticket.priority, 4)])
                }.fixedSize()
                    .font(.caption).foregroundStyle(.secondary)
                    .padding(.horizontal, 9).padding(.vertical, 5)
                    .overlay(Capsule().stroke(.secondary.opacity(0.15)))
            }
            ForEach(uniqueLabels(ticket.labels), id: \.self) { name in
                LabelChip(project: ticket.project, name: name, lineLimit: nil)
            }
            projectBadge
        }
    }
}

struct TaskList: View {
    @Environment(Workspace.self) private var workspace
    let title: String
    var project: String? = nil
    var inbox = false
    @State private var query = ""
    @State private var filter = TaskScope.open
    @State private var filters = TaskFilters()
    @State private var filtering = false
    @AppStorage("taskSort") private var sort = TaskSort.priority
    @State private var compose = false
    @State private var selectedTask: Ticket?
    @State private var manageInboxLabels = false
    @State private var error: String?
    @State private var updating: Set<String> = []

    private var scopedTasks: [Ticket] {
        workspace.tickets.filter {
            (project == nil || $0.project == project) && (!inbox || $0.project == nil) &&
            filters.matches($0, today: TaskEditor.dateFormatter.string(from: Date())) &&
            (query.isEmpty || "\($0.id) \($0.title) \($0.body) \($0.labels.joined(separator: " "))".localizedCaseInsensitiveContains(query.trimmingCharacters(in: .whitespacesAndNewlines)))
        }
    }
    private var tasks: [Ticket] { filter.tasks(from: scopedTasks, sort: sort) }
    var body: some View {
        List {
            HStack(spacing: 8) {
                ForEach(TaskScope.allCases) { scope in filterButton(scope) }
                Spacer(minLength: 0)
            }.listRowBackground(Color.clear).listRowSeparator(.hidden)
            HStack {
                Text("\(tasks.count) tasks · \(sort.title)").font(.caption).foregroundStyle(.secondary)
                Spacer()
                if filters.count > 0 || !query.isEmpty { Button("Clear filters") { filters = TaskFilters(); query = ""; filter = .all }.font(.caption) }
            }.listRowBackground(Color.clear).listRowSeparator(.hidden)
            if tasks.isEmpty {
                ContentUnavailableView(query.isEmpty ? "No \(filter == .open ? "open " : "")tasks" : "No matching tasks", systemImage: "checklist", description: Text(filters.count > 0 || !query.isEmpty ? "Try changing or clearing your filters." : "Tap + to capture your next task."))
                    .listRowBackground(Color.clear)
            }
            ForEach(tasks) { ticket in
                Button { selectedTask = ticket } label: { TaskRow(ticket: ticket, showProject: project == nil && !inbox) }.buttonStyle(.plain).listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                    .swipeActions(edge: .trailing) {
                        Button {
                            updating.insert(ticket.id)
                            Task {
                                defer { updating.remove(ticket.id) }
                                do { try await workspace.update(ticket, fields: ["status": ticket.status == .done ? "todo" : "done"]) }
                                catch { self.error = error.localizedDescription }
                            }
                        } label: { Label(ticket.status == .done ? "Reopen" : "Complete", systemImage: ticket.status == .done ? "arrow.uturn.backward" : "checkmark") }
                            .tint(.navy).disabled(updating.contains(ticket.id))
                    }
            }
        }
        .compactList()
        .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $selectedTask) { TaskDetailView(id: $0.id) }
        .sheet(isPresented: $manageInboxLabels) { LabelManager(project: nil) }
        .refreshable { await workspace.refresh() }
        .toolbar {
            if inbox { Button("Manage labels", systemImage: "tag") { manageInboxLabels = true } }
            FilterButton(title: "Filter tasks", active: filters.count > 0) { filtering = true }
            Menu { Picker("Sort tasks", selection: $sort) { ForEach(TaskSort.allCases) { Text($0.title).tag($0) } } } label: { Image(systemName: "arrow.up.arrow.down") }.accessibilityLabel("Sort tasks")
            Button { compose = true } label: { Image(systemName: "plus") }.accessibilityLabel("New task")
        }
        .sheet(isPresented: $filtering) { TaskFilterSheet(filters: $filters, showProjects: project == nil && !inbox, scope: project) }
        .onChange(of: filters.status) { _, value in if !value.isEmpty { filter = .all } }
        .onChange(of: filter) { _, value in if value != .all { filters.status = "" } }
        .sheet(isPresented: $compose) { TaskEditor(project: project) }
        .alert("Couldn’t update task", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) { Button("OK") { error = nil } } message: { Text(error ?? "") }
    }
    private func filterButton(_ value: TaskScope) -> some View {
        Button { filter = value } label: {
            Text("\(value.title) \(scopedTasks.filter { value.includes($0) }.count)").font(.subheadline.weight(filter == value ? .semibold : .regular))
                .foregroundStyle(filter == value ? .primary : .secondary)
                .padding(.horizontal, 16).frame(minHeight: 44)
                .background(filter == value ? Color.primary.opacity(0.07) : .clear, in: Capsule())
        }.buttonStyle(.plain).accessibilityAddTraits(filter == value ? .isSelected : [])
    }
}

struct ProjectsView: View {
    @Environment(Workspace.self) private var workspace
    @State private var query = ""
    @State private var compose = false
    @State private var projectStatus = ""
    @AppStorage("projectSort") private var projectSort = "name"
    private var visibleProjects: [Project] {
        workspace.projects.filter { (projectStatus.isEmpty || $0.status == projectStatus) && (query.isEmpty || "\($0.name) \($0.summary)".localizedCaseInsensitiveContains(query)) }.sorted {
            if projectSort == "open" && $0.open != $1.open { return $0.open > $1.open }
            return $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
    }
    var body: some View {
        List {
            if visibleProjects.isEmpty && !workspace.projects.isEmpty { ContentUnavailableView("No matching projects", systemImage: "magnifyingglass", description: Text("Change your search or status filter.")) }
            ForEach(visibleProjects) { project in
                NavigationLink { ProjectHome(slug: project.slug) } label: {
                    HStack(spacing: 12) { ProjectBadge(project: project).font(.system(size: 19)); Text(project.name).font(.subheadline.weight(.medium)); Spacer(); Text(project.open, format: .number).font(.caption).foregroundStyle(.tertiary) }.padding(.vertical, 8)

                }.listRowSeparator(.hidden)
            }
        }
        .overlay { if workspace.projects.isEmpty { ContentUnavailableView("No projects yet", systemImage: "square.stack.3d.up", description: Text("Create a project to organize your tasks.")) } }
        .compactList().listRowSeparator(.hidden)
        .navigationTitle("Projects").navigationBarTitleDisplayMode(.inline)
        .pageSearch(text: $query, prompt: "Search projects")
        .refreshable { await workspace.refresh() }
        .toolbar {
            Menu {
                Picker("Status", selection: $projectStatus) { Text("All statuses").tag(""); ForEach(Array(Set(workspace.projects.map(\.status))).sorted(), id: \.self) { Text($0.capitalized).tag($0) } }
                Picker("Sort projects", selection: $projectSort) { Text("Name A–Z").tag("name"); Text("Most open tasks").tag("open") }
            } label: { Image(systemName: projectStatus.isEmpty ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill") }.accessibilityLabel("Sort and filter projects")
            Button { compose = true } label: { Image(systemName: "plus") }.accessibilityLabel("New project")
        }
        .sheet(isPresented: $compose) { ProjectEditor() }
    }
}

struct ProjectHome: View {
    @Environment(Workspace.self) private var workspace
    let slug: String
    @State private var compose = false
    @State private var editing = false
    @State private var renamedSlug: String?
    @State private var manageLabels = false
    var body: some View {
        if let project = workspace.projects.first(where: { $0.slug == (renamedSlug ?? slug) }) {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack { ProjectBadge(project: project); Text(project.key).foregroundStyle(.secondary) }.font(.caption.weight(.semibold))
                        Text(project.name).font(.title2.weight(.semibold))
                        if !project.body.isEmpty { MarkdownView(text: .constant(project.body), readOnly: true, docPath: "Projects/\(project.slug)/project.md") } else { Text("Add an overview with Edit project.").foregroundStyle(.secondary) }
                        HStack { Text(project.status.capitalized); Spacer(); Text(workspace.agentName(project.lead)) }.font(.caption).foregroundStyle(.secondary)
                    }.padding(.vertical, 8)
                    HStack {
                        Metric(value: project.open, title: "Open")
                        Spacer()
                        Metric(value: project.counts["in_progress", default: 0], title: "In progress")
                        Spacer()
                        Metric(value: project.counts["in_review", default: 0], title: "In review")
                    }.padding(.vertical, 8)
                    NavigationLink { TaskList(title: "Tasks", project: project.slug) } label: { Label("All project tasks", systemImage: "checklist") }
                    NavigationLink { ProjectWiki(slug: project.slug) } label: { Label("Library", systemImage: "book.closed") }
                }
                Section("Active work") {
                    let active = workspace.tickets.filter { $0.project == project.slug && $0.status.isOpen }.sorted { $0.updated > $1.updated }
                    if active.isEmpty { Text("No open tasks").foregroundStyle(.secondary) }
                    ForEach(Array(active.prefix(8))) { ticket in
                        NavigationLink { TaskDetailView(id: ticket.id) } label: { TaskRow(ticket: ticket, showProject: false) }
                    }
                }
            }
            .compactList()
            .navigationTitle("Project home").navigationBarTitleDisplayMode(.inline)
            .refreshable { await workspace.refresh() }
            .sheet(isPresented: $manageLabels) { LabelManager(project: project.slug) }
            .toolbar { Menu { Button("Edit project", systemImage: "square.and.pencil") { editing = true }; Button("Manage labels", systemImage: "tag") { manageLabels = true } } label: { Image(systemName: "ellipsis") }.accessibilityLabel("Project options"); Button { compose = true } label: { Image(systemName: "plus") }.accessibilityLabel("New project task") }
            .sheet(isPresented: $editing) { ProjectEditor(project: project) { renamedSlug = $0 } }
            .sheet(isPresented: $compose) { TaskEditor(project: project.slug) }
        } else { ContentUnavailableView("Project unavailable", systemImage: "folder") }
    }
}

struct Metric: View {
    let value: Int
    let title: String
    var body: some View { VStack(alignment: .leading, spacing: 5) { Text(value, format: .number).font(.title2.weight(.semibold)); Text(title).font(.caption).foregroundStyle(.secondary) } }
}

struct ActivityView: View {
    @Environment(Workspace.self) private var workspace
    @State private var filters = ActivityFilters()
    @State private var filtering = false
    /// Task events, plus every change to an agent's instructions: agents act on those, so they always show.
    private var sourceEvents: [ActivityEvent] { workspace.activity.filter { $0.ticket != nil || $0.isInstructionChange } }
    private var events: [ActivityEvent] { filters.apply(to: sourceEvents) }
    private var actors: [String] { Array(Set(sourceEvents.map(\.agent))).sorted() }
    private var kinds: [String] { Array(Set(sourceEvents.map(\.type))).sorted() }
    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Changes and conversations across your projects.").font(.subheadline).foregroundStyle(.secondary)
                    Text("\(events.count) recent events · \(filters.oldestFirst ? "Oldest first" : "Newest first")").font(.caption).foregroundStyle(.secondary)
                    if filters.isActive {
                        Text([filters.actor.isEmpty ? nil : workspace.agentName(filters.actor), filters.kind.isEmpty ? nil : ActivityFilters.label(for: filters.kind)].compactMap { $0 }.joined(separator: " · ")).font(.caption)
                        Button("Clear filters") { filters.actor = ""; filters.kind = "" }.font(.caption)
                    }
                }.padding(.vertical, 8)
            }
            if events.isEmpty {
                ContentUnavailableView(filters.isActive ? "No matching activity" : "No activity yet", systemImage: "waveform.path", description: Text(filters.isActive ? "Try changing or clearing your filters." : "Task changes and comments will appear here."))
            }
            ForEach(events) { event in
                if event.isInstructionChange, let target = event.target {
                    NavigationLink { AgentHomeView(id: target) } label: { EventRow(event: event) }
                } else {
                    NavigationLink { TaskDetailView(id: event.ticket ?? "") } label: { EventRow(event: event) }
                }
            }
        }.compactList().navigationTitle("Activity").navigationBarTitleDisplayMode(.inline)
            .refreshable { await workspace.refresh() }
            .toolbar { FilterButton(title: "Filter activity", active: filters.isActive) { filtering = true } }
            .sheet(isPresented: $filtering) {
                InventoryFilterSheet(title: "Filter activity", clear: { filters = ActivityFilters() }) {
                    Picker("Who acted", selection: $filters.actor) {
                        Text("Everyone").tag("")
                        ForEach(actors, id: \.self) { Text(workspace.agentName($0)).tag($0) }
                    }
                    Picker("Event", selection: $filters.kind) {
                        Text("All events").tag("")
                        ForEach(kinds, id: \.self) { Text(ActivityFilters.label(for: $0)).tag($0) }
                    }
                    Picker("Order", selection: $filters.oldestFirst) {
                        Text("Newest first").tag(false)
                        Text("Oldest first").tag(true)
                    }
                    Text("Browse recent changes by who made them and what happened.").font(.caption).foregroundStyle(.secondary)
                }
            }
    }
}

struct EventRow: View {
    @Environment(Workspace.self) private var workspace
    let event: ActivityEvent
    var expanded = false
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline) {
                HStack(spacing: 6) {
                    if !expanded {
                        if event.isInstructionChange { Image(systemName: "exclamationmark.shield.fill").foregroundStyle(.red) }
                        else if let project = workspace.project(for: event) { ProjectBadge(project: project) }
                        else { Image(systemName: "tray").foregroundStyle(.secondary) }
                    }
                    Text(expanded ? workspace.agentName(event.agent) : event.isInstructionChange ? "Instructions" : workspace.projectName(for: event)).fontWeight(.medium)
                }
                Spacer(minLength: 8)
                Text(event.date, style: .relative).foregroundStyle(.tertiary)
            }.font(.caption)
            if !expanded || event.device != nil {
                Text([expanded ? nil : workspace.agentName(event.agent), event.device.map { "on \($0)" }].compactMap { $0 }.joined(separator: " ")).font(.caption).foregroundStyle(.secondary)
            }
            if event.isInstructionChange {
                let whose = event.target == event.agent ? "its own instructions" : "the instructions of \(workspace.agentName(event.target ?? event.subject ?? "an agent"))"
                Text("Changed \(whose)").font(.subheadline.weight(.semibold)).foregroundStyle(.red)
                    .lineLimit(3).fixedSize(horizontal: false, vertical: true)
            } else if let body = event.body {
                if expanded {
                    MarkdownView(text: .constant(body), readOnly: true)
                } else {
                    Text(activityPreview(body)).font(.subheadline.weight(.regular)).foregroundStyle(.primary)
                        .lineLimit(3).fixedSize(horizontal: false, vertical: true)
                }
            } else {
                Text("\(event.type.replacingOccurrences(of: "ticket.", with: "").capitalized) \(event.ticket ?? "") · \(event.subject ?? "")")
                    .font(.subheadline.weight(.regular)).foregroundStyle(.primary).lineLimit(3).fixedSize(horizontal: false, vertical: true)
            }
            if event.body != nil, !expanded, let ticket = event.ticket {
                Text(ticket).font(.caption2.monospaced()).foregroundStyle(.tertiary)
            }
        }.padding(.vertical, 8).accessibilityElement(children: .combine)
    }
}

/// Native previews participate in the first layout pass; no asynchronous web height in list cells.
func activityPreview(_ markdown: String) -> String {
    let parsed = try? AttributedString(markdown: markdown, options: .init(interpretedSyntax: .full))
    let plain = parsed.map { String($0.characters) } ?? markdown
    return plain.split(whereSeparator: \.isWhitespace).joined(separator: " ")
}

struct ConnectionView: View {
    @Environment(Workspace.self) private var workspace
    @State private var address = ""
    @State private var token = ""
    @State private var busy = false
    @State private var message: String?
    @State private var success = false
    var body: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    Image("CentcomLogo").renderingMode(.original).resizable().scaledToFit()
                        .frame(width: 56, height: 56)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .accessibilityHidden(true)
                    Text(workspace.isConfigured ? "One shared workspace" : "Your work, with you.").font(.title.bold())
                    Text("Connect to the same CENTCOM server you use on your Mac. Projects, tasks and comments stay together.").foregroundStyle(.secondary)
                }.padding(.vertical)
            }
            Section("Server") {
                TextField("https://your-server", text: $address).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("server-address")
                SecureField("Server token", text: $token).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("server-token")
            }
            Section {
                Button { connect() } label: { HStack { Text(busy ? "Connecting…" : "Connect"); Spacer(); if busy { ProgressView() } else { Image(systemName: "arrow.right") } } }.tint(.navy).buttonStyle(.borderedProminent).foregroundStyle(.white).disabled(busy || address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if let message { Text(message).font(.footnote).foregroundStyle(success ? .green : .red) }
            } footer: {
                Text("Enter your server’s HTTPS address, shown in Settings in the CENTCOM Mac app. The remote access guide in the CENTCOM docs explains how to reach your server from this device. Your token is stored securely in this device’s Keychain.")
            }
            Section {
                Button { connectDemo() } label: { HStack { Text(workspace.isDemo ? "Reload the demo workspace" : "Explore a demo workspace"); Spacer(); Image(systemName: "sparkles") } }.disabled(busy)
            } footer: {
                Text("A fictional workspace stored in the app, to see how CENTCOM works without a server. Nothing is sent anywhere, and changes are not saved.")
            }
            if let last = workspace.lastSynced { Section("Status") { LabeledContent("Backend", value: workspace.isDemo ? "Demo workspace" : workspace.online ? "Connected" : "Offline"); LabeledContent("Last synced") { Text(last, style: .time) } } }
        }.navigationTitle("Connection")
        .onAppear {
            guard !workspace.isDemo else { return }
            address = workspace.connection?.url.absoluteString ?? ""
            token = workspace.connection?.token ?? ""
        }
    }
    private func connectDemo() {
        busy = true; message = nil
        Task {
            defer { busy = false }
            do { try await workspace.connect(address: DemoURLProtocol.address, token: DemoURLProtocol.token); success = true; message = "Exploring the demo workspace. Connect your own server above at any time." }
            catch { success = false; message = error.localizedDescription }
        }
    }
    private func connect() {
        busy = true; message = nil
        Task {
            defer { busy = false }
            do { try await workspace.connect(address: address, token: token); success = true; message = "Connected to your shared workspace." }
            catch { success = false; message = error.localizedDescription }
        }
    }
}
