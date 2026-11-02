import SwiftUI

struct SkillInstallation: Decodable, Identifiable, Hashable {
    let id, deviceId, deviceName, agent, scope, path, hash: String
    let project: String?
    let reportedAt: Double
    var label: String { "\(deviceName) · \(agent) · \(project.map { URL(fileURLWithPath: $0).lastPathComponent } ?? "Global")" }
}
struct SkillLibrary: Decodable, Hashable, Identifiable {
    let id, name: String
    /// The server resolves display names from the owner's `skill-sources.json`.
    var displayName: String { name }
}
struct CatalogSkill: Decodable, Identifiable, Hashable {
    let id, name, description: String
    let sourceUrl: String?
    let library: SkillLibrary?
    let versions: Int
    let installations: [SkillInstallation]
}
struct SkillDevice: Decodable, Identifiable { let id, name: String; let reportedAt: Double }
struct SkillCatalog: Decodable { let skills: [CatalogSkill]; let devices: [SkillDevice] }
struct SkillDocument: Decodable { let markdown, body: String }

struct SkillsView: View {
    @Environment(Workspace.self) private var workspace
    @State private var catalog = SkillCatalog(skills: [], devices: [])
    @State private var query = ""
    @State private var device = ""
    @State private var agent = ""
    @State private var scope = ""
    @State private var project = ""
    @State private var library = ""
    @State private var loading = false
    @State private var error: String?
    @State private var connecting = false
    @State private var filtering = false
    @State private var browseLibraries = false
    private var filtered: [CatalogSkill] {
        catalog.skills.filter { skill in
            (query.isEmpty || "\(skill.name) \(skill.description) \(skill.sourceUrl ?? "") \(skill.library?.displayName ?? "")".localizedCaseInsensitiveContains(query)) &&
            (library.isEmpty || (skill.library?.id ?? "local") == library) &&
            skill.installations.contains { matches($0) }
        }
    }
    private var libraries: [SkillLibrary] { Array(Set(catalog.skills.compactMap(\.library))).sorted { $0.displayName.localizedStandardCompare($1.displayName) == .orderedAscending } }
    private var agents: [String] { Array(Set(catalog.skills.flatMap(\.installations).map(\.agent))).sorted() }
    private var projects: [String] { Array(Set(catalog.skills.flatMap(\.installations).compactMap(\.project))).sorted() }
    private var hasFilters: Bool { !library.isEmpty || !device.isEmpty || !agent.isEmpty || !scope.isEmpty || !project.isEmpty }
    private func matches(_ i: SkillInstallation) -> Bool {
        (device.isEmpty || i.deviceId == device) && (agent.isEmpty || i.agent == agent) &&
        (scope.isEmpty || i.scope == scope) && (project.isEmpty || i.project == project)
    }
    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 14) {
                Text("Reusable capabilities available to your agents.").font(.subheadline).foregroundStyle(.secondary)
                Picker("Browse Skills", selection: $browseLibraries) {
                    Text("All Skills").tag(false)
                    Text("Libraries").tag(true)
                }.pickerStyle(.segmented)
                HStack {
                    Text("\(filtered.count) Skills · \(catalog.devices.count) \(catalog.devices.count == 1 ? "device" : "devices")").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    if hasFilters || !query.isEmpty { Button("Clear filters") { device = ""; agent = ""; scope = ""; project = ""; query = ""; library = "" }.font(.caption) }
                }
                if hasFilters { Text([libraries.first { $0.id == library }?.displayName, catalog.devices.first { $0.id == device }?.name, agent.isEmpty ? nil : agent, scope.isEmpty ? nil : scope.capitalized, project.isEmpty ? nil : URL(fileURLWithPath: project).lastPathComponent].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary) }
                }.padding(.vertical, 8)
            }
            if let error { Section { Text(error).foregroundStyle(.red); Button("Retry") { Task { await refresh() } } } }
            if loading && catalog.skills.isEmpty { ProgressView("Loading Skills…") }
            if !loading && error == nil && filtered.isEmpty {
                ContentUnavailableView(catalog.skills.isEmpty ? "Bring your Skills together" : "No matching Skills", systemImage: "books.vertical", description: Text(catalog.skills.isEmpty ? "Connect a Mac or agent runtime to see its installed Skills." : "Try another device, agent, or scope."))
            }
            if browseLibraries {
                Section("Libraries") {
                    ForEach(libraries.filter { library in filtered.contains { $0.library?.id == library.id } }) { item in
                        Button {
                            library = item.id; browseLibraries = false
                        } label: {
                            HStack(spacing: 14) {
                                Image(systemName: "books.vertical").foregroundStyle(.secondary)
                                Text(item.displayName).foregroundStyle(.primary)
                                Spacer()
                                Text(filtered.filter { $0.library?.id == item.id }.count, format: .number).foregroundStyle(.secondary)
                                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                            }.padding(.vertical, 8)
                        }.buttonStyle(.plain)
                    }
                    if filtered.contains(where: { $0.library == nil }) {
                        Button("Other local Skills") { library = "local"; browseLibraries = false }
                    }
                }
            } else {
            ForEach(filtered) { skill in
                NavigationLink {
                    SkillDetailView(skill: skill, initialInstallation: skill.installations.first(where: matches)?.id ?? skill.installations[0].id)
                } label: {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(skill.name).font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
                        Text(skill.description).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                        Text(Array(Set(skill.installations.filter { matches($0) }.map(\.deviceName))).sorted().joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                        HStack {
                            Text(skill.library?.displayName ?? "Other local Skills").lineLimit(1)
                            if skill.versions > 1 { Text("\(skill.versions) versions").fixedSize() }
                        }.font(.caption2).foregroundStyle(.tertiary)
                    }.padding(.vertical, 8)
                }
            }
            }
            if !catalog.devices.isEmpty {
                Section {
                    DisclosureGroup("Device reports") {
                    ForEach(catalog.devices) { d in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(d.name)
                            Text("Reported \(Date(timeIntervalSince1970: d.reportedAt / 1000).formatted(date: .abbreviated, time: .shortened))").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Text("Pull to refresh the latest reports. Sync on a device after installing or updating Skills.").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }.compactList().navigationTitle("Skills").navigationBarTitleDisplayMode(.inline)
            .pageSearch(text: $query, prompt: "Search Skills")
            .task { await refresh() }.refreshable { await refresh() }
            .toolbar {
                FilterButton(title: "Filter Skills", active: hasFilters) { filtering = true }
                Button("Connect a device", systemImage: "plus") { connecting = true }
            }
            .onChange(of: browseLibraries) { _, browsing in if browsing { library = "" } }
            .sheet(isPresented: $connecting) { SkillConnectionView() }
            .sheet(isPresented: $filtering) {
                InventoryFilterSheet(title: "Filter Skills", clear: { device = ""; agent = ""; scope = ""; project = ""; library = "" }) {
                    Picker("Library", selection: $library) { Text("All libraries").tag(""); ForEach(libraries) { Text($0.displayName).tag($0.id) }; if !libraries.contains(where: { $0.id == "local" }) { Text("Other local Skills").tag("local") } }
                    Picker("Device", selection: $device) { Text("All devices").tag(""); ForEach(catalog.devices) { Text($0.name).tag($0.id) } }
                    Picker("Agent", selection: $agent) { Text("All agents").tag(""); ForEach(agents, id: \.self) { Text($0).tag($0) } }
                    Picker("Scope", selection: $scope) { Text("All scopes").tag(""); Text("Global").tag("global"); Text("Project only").tag("project") }
                    Picker("Project", selection: $project) { Text("All projects").tag(""); ForEach(projects, id: \.self) { Text(URL(fileURLWithPath: $0).lastPathComponent).tag($0) } }
                }
            }
    }
    private func refresh() async {
        guard let client = workspace.client else { return }
        loading = true; error = nil
        defer { loading = false }
        do { catalog = try await client.request("skills") } catch { self.error = error.localizedDescription }
    }
}
struct SkillDetailView: View {
    @Environment(Workspace.self) private var workspace
    let skill: CatalogSkill
    let initialInstallation: String
    @State private var installation = ""
    @State private var document: SkillDocument?
    @State private var error: String?
    private var selectedID: String { installation.isEmpty ? initialInstallation : installation }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text(skill.name).font(.title2.weight(.semibold))
                if !skill.description.isEmpty { Text(skill.description).font(.subheadline).foregroundStyle(.secondary) }
                if let sourceUrl = skill.sourceUrl, let url = URL(string: sourceUrl) { Link("View on GitHub ↗", destination: url).font(.subheadline) }
                if skill.versions > 1 { Text("\(skill.versions) different file versions. Choose an installed copy below.").font(.subheadline).foregroundStyle(.secondary) }
                InventoryCopyPicker(title: "Installed copy", options: skill.installations.map { (id: $0.id, label: $0.label) }, selection: Binding(get: { selectedID }, set: { installation = $0 }))
                DisclosureGroup("Installation details") {
                if let location = skill.installations.first(where: { $0.id == selectedID }) {
                    Text("Found on \(location.deviceName) in \(location.agent)’s \(location.scope == "global" ? "global" : "project") Skills folder.").font(.subheadline).foregroundStyle(.secondary)
                    Text(location.path).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    Text("Reported \(Date(timeIntervalSince1970: location.reportedAt / 1000).formatted())").font(.caption2).foregroundStyle(.tertiary)
                }
                }.font(.subheadline).tint(.primary)
                Divider()
                if let error { Text(error).foregroundStyle(.red) }
                else if let document {
                    MarkdownView(text: .constant(document.body), readOnly: true).id(selectedID)
                } else { ProgressView("Loading SKILL.md…") }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(20)
        }.navigationTitle("Skill").navigationBarTitleDisplayMode(.inline)
            .task(id: selectedID) {
                guard let client = workspace.client else { return }
                document = nil; error = nil
                do {
                    let result: SkillDocument = try await client.request("skills/installations/\(selectedID)")
                    try Task.checkCancellation()
                    document = result
                } catch is CancellationError { } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
            }
    }
}
struct SkillConnectionView: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                Section("Macs") {
                    Text("Run on each Mac using the CENTCOM CLI connected to your shared server:")
                    Text("centcom skill sync --device macbook --device-name \"MacBook\"").font(.caption.monospaced()).textSelection(.enabled)
                    Text("Use a unique ID for each device. Global Skills and project Skills under ~/Projects are discovered automatically. Repeat after installs and updates.")
                }
                Section("Other agents and bots") {
                    Text("Report a custom Skills folder from its host:")
                    Text("centcom skill sync --device grok-host --root /path/to/skills --agent Grok --reporter grok").font(.caption.monospaced()).textSelection(.enabled)
                    Text("This reports installed files. It does not install or overwrite Skills.")
                }
            }.navigationTitle("Connect a device").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
