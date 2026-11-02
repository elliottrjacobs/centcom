import SwiftUI

struct InstructionCopy: Decodable, Identifiable, Hashable {
    let id, name, deviceId, deviceName, agent, scope, path, relativePath, hash: String
    let project: String?
    let projectKey: String?
    let reportedAt: Double
    var label: String { "\(deviceName) · \(agent) · \(project ?? "Global")" }
}
struct CatalogInstruction: Decodable, Identifiable, Hashable {
    let id, name, agent, scope, relativePath: String
    let project: String?
    let versions: Int
    let copies: [InstructionCopy]
}
struct InstructionGroup: Identifiable {
    let id, title, location, scope: String
    var files: [CatalogInstruction]
    var reportedAt: Double { files.flatMap(\.copies).map(\.reportedAt).max() ?? 0 }
    static func make(_ files:[CatalogInstruction], recent:Bool) -> [InstructionGroup] {
        var result:[String:InstructionGroup] = [:]
        for file in files {
            guard let copy = file.copies.first else { continue }
            let id = file.scope == "global" ? "global" : copy.projectKey ?? "project:\(file.project ?? "")"
            if result[id] == nil {
                let root = copy.path.hasSuffix(file.relativePath) ? String(copy.path.dropLast(file.relativePath.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/")) : ""
                let location = ("/" + root).replacingOccurrences(of: "^/(Users|home)/[^/]+", with: "~", options: .regularExpression)
                result[id] = InstructionGroup(id:id, title:file.scope == "global" ? "Global instructions" : file.project ?? "Project", location:file.scope == "global" ? "Defaults across your projects" : location, scope:file.scope, files:[])
            }
            result[id]?.files.append(file)
        }
        return result.values.sorted {
            if $0.scope != $1.scope { return $0.scope == "global" }
            if recent && $0.reportedAt != $1.reportedAt { return $0.reportedAt > $1.reportedAt }
            return $0.title.localizedStandardCompare($1.title) == .orderedAscending
        }
    }
}
extension CatalogInstruction {
    var context: String {
        let folder = relativePath.split(separator: "/").dropLast().joined(separator: "/")
        let tool = agent == "Shared" ? "Shared agents" : agent
        return scope == "global" || folder.isEmpty || [".claude", ".codex", ".agents"].contains(folder) ? tool : "\(folder) · \(tool)"
    }
}
struct InstructionCatalog: Decodable { let files: [CatalogInstruction]; let devices: [SkillDevice] }
struct InstructionDocument: Decodable { let markdown, body: String }

/// Keep the selected label bounded; long filesystem paths belong in the metadata below.
struct InventoryCopyPicker: View {
    let title: String
    let options: [(id: String, label: String)]
    @Binding var selection: String
    var body: some View {
        Menu {
            Picker(title, selection: $selection) {
                ForEach(options, id: \.id) { option in Text(option.label).tag(option.id) }
            }
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(title).font(.caption).foregroundStyle(.secondary)
                    Text(options.first { $0.id == selection }?.label ?? "Choose a copy")
                        .font(.subheadline).foregroundStyle(.primary).lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }.frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.up.chevron.down").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            }.padding(14).frame(maxWidth: .infinity, minHeight: 60, alignment: .leading)
                .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 12))
                .contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityLabel(title)
            .accessibilityValue(options.first { $0.id == selection }?.label ?? "Choose a copy")
    }
}

struct InstructionsView: View {
    @Environment(Workspace.self) private var workspace
    @AppStorage("instructions.sort") private var sort = "name"
    @State private var catalog = InstructionCatalog(files: [], devices: [])
    @State private var query = ""
    @State private var device = ""
    @State private var agent = ""
    @State private var scope = ""
    @State private var project = ""
    @State private var loading = false
    @State private var error: String?
    @State private var connecting = false
    @State private var filtering = false
    private func matches(_ c: InstructionCopy) -> Bool {
        (device.isEmpty || c.deviceId == device) && (agent.isEmpty || c.agent == agent) &&
        (scope.isEmpty || c.scope == scope) && (project.isEmpty || c.project == project)
    }
    private var filtered: [CatalogInstruction] {
        catalog.files.filter { file in
            (query.isEmpty || "\(file.name) \(file.agent) \(file.project ?? "") \(file.relativePath)".localizedCaseInsensitiveContains(query)) && file.copies.contains(where: matches)
        }
    }
    private var agents: [String] { Array(Set(catalog.files.flatMap(\.copies).map(\.agent))).sorted() }
    private var projects: [String] { Array(Set(catalog.files.flatMap(\.copies).compactMap(\.project))).sorted() }
    private var hasFilters: Bool { !device.isEmpty || !agent.isEmpty || !scope.isEmpty || !project.isEmpty }
    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 14) {
                Text("The rules your agents follow, globally or in a project.").font(.subheadline).foregroundStyle(.secondary)
                Picker("Instruction scope", selection: $scope) {
                    Text("All").tag("")
                    Text("Global").tag("global")
                    Text("Projects").tag("project")
                }.pickerStyle(.segmented)
                HStack {
                    Text("\(filtered.count) files · \(catalog.devices.count) \(catalog.devices.count == 1 ? "device" : "devices")").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    if hasFilters || !query.isEmpty { Button("Clear filters") { device = ""; agent = ""; scope = ""; project = ""; query = "" }.font(.caption) }
                }
                if !device.isEmpty || !agent.isEmpty || !project.isEmpty { Text([catalog.devices.first { $0.id == device }?.name, agent.isEmpty ? nil : agent, project.isEmpty ? nil : project].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary) }
                }.frame(maxWidth: .infinity, alignment: .leading).multilineTextAlignment(.leading).padding(.vertical, 8)
            }
            if let error { Section { Text(error).foregroundStyle(.red); Button("Retry") { Task { await refresh() } } } }
            if loading && catalog.files.isEmpty { ProgressView("Loading instructions…") }
            if !loading && error == nil && filtered.isEmpty {
                ContentUnavailableView(catalog.files.isEmpty ? "Bring your instructions together" : "No matching instructions", systemImage: "doc.text", description: Text(catalog.files.isEmpty ? "Connect a device to see its global and project instruction files." : "Try another device, agent, or scope."))
            }
            ForEach(InstructionGroup.make(filtered, recent: sort == "recent")) { group in
                InstructionGroupSection(group: group, copyMatches: matches, expanded: group.scope == "global" || hasFilters || !query.isEmpty, initialCopy: { file in file.copies.first(where: matches)?.id ?? file.copies[0].id })
                    .id("\(group.id):\(hasFilters || !query.isEmpty)")
            }
            if !catalog.devices.isEmpty {
                Section {
                    DisclosureGroup("Device reports") {
                    ForEach(catalog.devices) { d in VStack(alignment: .leading, spacing: 4) { Text(d.name); Text("Reported \(Date(timeIntervalSince1970: d.reportedAt / 1000).formatted(date: .abbreviated, time: .shortened))").font(.caption).foregroundStyle(.secondary) } }
                    Text("Pull to refresh the latest reports. Sync on a device after changing its files.").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }.compactList().navigationTitle("").navigationBarTitleDisplayMode(.inline)
            .pageSearch(text: $query, prompt: "Search instructions")
            .task { await refresh() }.refreshable { await refresh() }
            .toolbar {
                if #available(iOS 26.0, *) {
                    ToolbarItem(placement: .topBarLeading) { pageTitle }
                        .sharedBackgroundVisibility(.hidden)
                } else {
                    ToolbarItem(placement: .topBarLeading) { pageTitle }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    FilterButton(title: "Filter instructions", active: hasFilters) { filtering = true }
                    Button("Connect a device", systemImage: "plus") { connecting = true }
                }
            }.sheet(isPresented: $connecting) { InstructionConnectionView() }
            .sheet(isPresented: $filtering) {
                InventoryFilterSheet(title: "Filter Instructions", clear: { device = ""; agent = ""; scope = ""; project = "" }) {
                    Picker("Device", selection: $device) { Text("All devices").tag(""); ForEach(catalog.devices) { Text($0.name).tag($0.id) } }
                    Picker("Agent", selection: $agent) { Text("All agents").tag(""); ForEach(agents, id: \.self) { Text($0).tag($0) } }
                    Picker("Project", selection: $project) { Text("All projects").tag(""); ForEach(projects, id: \.self) { Text($0).tag($0) } }
                    Picker("Sort by", selection: $sort) { Text("Project name").tag("name"); Text("Recently reported").tag("recent") }
                }
            }
    }
    private var pageTitle: some View {
        Text("Instructions").font(.headline).fixedSize()
            .accessibilityAddTraits(.isHeader).accessibilityIdentifier("instructions-title")
    }
    private func refresh() async {
        guard let client = workspace.client else { return }
        loading = true; error = nil
        defer { loading = false }
        do { catalog = try await client.request("instructions") } catch { self.error = error.localizedDescription }
    }
}
struct InstructionGroupSection: View {
    let group: InstructionGroup
    let copyMatches: (InstructionCopy) -> Bool
    let initialCopy: (CatalogInstruction) -> String
    @State private var expanded: Bool
    init(group: InstructionGroup, copyMatches: @escaping (InstructionCopy) -> Bool, expanded: Bool, initialCopy: @escaping (CatalogInstruction) -> String) {
        self.group = group; self.copyMatches = copyMatches; self.initialCopy = initialCopy; _expanded = State(initialValue: expanded)
    }
    var body: some View {
        Section {
            DisclosureGroup(isExpanded: $expanded) {
                ForEach(group.files.sorted { $0.context.localizedStandardCompare($1.context) == .orderedAscending }) { file in
                    NavigationLink { InstructionDetailView(file:file, initialCopy:initialCopy(file)) } label: {
                        HStack(spacing:12) {
                            Image(systemName:"doc.text").foregroundStyle(.secondary)
                            VStack(alignment:.leading, spacing:5) {
                                Text(file.name).font(.subheadline.weight(.medium))
                                Text(file.context).font(.caption).foregroundStyle(.secondary)
                                Text(Array(Set(file.copies.filter(copyMatches).map(\.deviceName))).sorted().joined(separator:" · ")).font(.caption2).foregroundStyle(.tertiary)
                            }
                            Spacer(minLength:4)
                            if file.versions > 1 { Text("\(file.versions) versions").font(.caption2).foregroundStyle(.secondary) }
                        }.padding(.vertical,6)
                    }
                }
            } label: {
                HStack(spacing:12) {
                    Image(systemName:group.scope == "global" ? "globe" : "folder").font(.title3).foregroundStyle(.secondary).frame(width:30)
                    VStack(alignment:.leading, spacing:5) {
                        Text(group.title).font(.headline)
                        Text(group.scope == "global" ? "Applies across your projects" : Array(Set(group.files.map(\.agent))).sorted().joined(separator: " · ")).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                    Spacer(minLength:4)
                    Text("\(group.files.count)").font(.caption).foregroundStyle(.secondary)
                }.padding(.vertical,10)
            }.tint(.primary)
        }
    }
}
struct InstructionDetailView: View {
    @Environment(Workspace.self) private var workspace
    let file: CatalogInstruction
    let initialCopy: String
    @State private var copy = ""
    @State private var document: InstructionDocument?
    @State private var error: String?
    private var selectedID: String { copy.isEmpty ? initialCopy : copy }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text(file.project ?? file.context).font(.title2.weight(.semibold))
                Text("\(file.name) · \(file.scope == "global" ? "Global" : file.context)").foregroundStyle(.secondary)
                if file.versions > 1 { Text("\(file.versions) file versions. Choose a reported copy below.").font(.subheadline).foregroundStyle(.secondary) }
                InventoryCopyPicker(title: "Reported copy", options: file.copies.map { (id: $0.id, label: $0.label) }, selection: Binding(get: { selectedID }, set: { copy = $0 }))
                DisclosureGroup("File details") {
                if let location = file.copies.first(where: { $0.id == selectedID }) {
                    Text(location.path).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    Text("Reported \(Date(timeIntervalSince1970: location.reportedAt / 1000).formatted())").font(.caption2).foregroundStyle(.tertiary)
                }
                }.font(.subheadline).tint(.primary)
                Divider()
                if let error { Text(error).foregroundStyle(.red) }
                else if let document { MarkdownView(text: .constant(document.body), readOnly: true).id(selectedID) }
                else { ProgressView("Loading instructions…") }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(20)
        }.navigationTitle("Instructions").navigationBarTitleDisplayMode(.inline)
            .task(id: selectedID) {
                guard let client = workspace.client else { return }
                document = nil; error = nil
                do { let result: InstructionDocument = try await client.request("instructions/copies/\(selectedID)"); try Task.checkCancellation(); document = result }
                catch is CancellationError { } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
            }
    }
}
struct InstructionConnectionView: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                Section("Macs") {
                    Text("Run on each Mac using the CENTCOM CLI connected to your shared server:")
                    Text("centcom instruction sync --device macbook --device-name \"MacBook\"").font(.caption.monospaced()).textSelection(.enabled)
                    Text("Finds global files, projects under ~/Projects, and ~/CENTCOM. Use --project-dir for other project folders. Sync again after changing files.")
                }
                Section("Other agents and bots") {
                    Text("Use report_instructions in MCP, or submit a JSON report with --report-file. Give custom subsets their own reporter name.")
                    Text("Reports let you read copies here. They do not overwrite files on your devices.")
                }
            }.navigationTitle("Connect a device").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
