import QuickLook
import SwiftUI

struct AgentSkill: Decodable, Identifiable {
    let name, description: String
    var id: String { name }
}
struct AgentDeliverable: Decodable, Identifiable {
    let id, title, url, kind, date, addedBy: String
    let project, note: String?
}
struct AgentProfile: Decodable {
    let id, name, source, description, instructions, updatedBy, path: String
    let skills: [AgentSkill]
    let deliverables: [AgentDeliverable]
    let updated: Double
    var sourceLabel: String { source == "grokbot-sync" ? "Synced from Grok Bot" : "Self-reported" }
}
struct AgentProfileSummary: Decodable, Identifiable {
    let id, description: String
}
struct AgentHome: Decodable {
    let agent: Agent
    let profile: AgentProfile?
    let deliverables: [AgentDeliverable]
    let activity: [ActivityEvent]
}

enum AgentOutputTarget: Equatable {
    case external(URL), document(String), file(String), unavailable
    init(_ value: String) {
        if let url = URL(string: value), let scheme = url.scheme {
            self = ["https", "http"].contains(scheme.lowercased()) && url.host != nil ? .external(url) : .unavailable
        } else if value.isEmpty || value.hasPrefix("/") || value.split(separator: "/").contains("..") {
            self = .unavailable
        } else {
            self = value.lowercased().hasSuffix(".md") ? .document(value) : .file(value)
        }
    }
}

struct AgentsView: View {
    @Environment(Workspace.self) private var workspace
    @State private var profiles: [AgentProfileSummary] = []
    @State private var query = ""
    @State private var error: String?
    private var visible: [Agent] {
        workspace.agents.filter(\.isInDirectory).filter { agent in
            query.isEmpty || "\(agent.name) \(agent.id) \(profiles.first { $0.id == agent.id }?.description ?? "")".localizedCaseInsensitiveContains(query)
        }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }
    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            if visible.isEmpty {
                ContentUnavailableView { Label { Text("No matching agents") } icon: { AgentRobotIcon().frame(width: 40, height: 40) } } description: { Text("Your bots and personal agents appear here when they publish a profile or work in CENTCOM.") }
            }
            ForEach(visible) { agent in
                NavigationLink { AgentHomeView(id: agent.id) } label: {
                    AgentDirectoryCard(agent: agent, description: profiles.first { $0.id == agent.id }?.description ?? "", tickets: workspace.tickets.filter { $0.agent == agent.id })
                }
            }
        }.compactList().navigationTitle("Agents").navigationBarTitleDisplayMode(.inline)
            .pageSearch(text: $query, prompt: "Find an agent")
            .task(id: workspace.connection) {
                while !Task.isCancelled { await load(); try? await Task.sleep(for: .seconds(5)) }
            }
            .refreshable { await workspace.refresh(); await load() }
    }
    private func load() async {
        guard let client = workspace.client else { return }
        do {
            let result: [AgentProfileSummary] = try await client.request("agent-profiles")
            try Task.checkCancellation()
            profiles = result; error = nil
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}

private struct AgentDirectoryCard: View {
    let agent: Agent
    let description: String
    let tickets: [Ticket]
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                AgentRobotIcon().frame(width: 24, height: 24)
                    .foregroundStyle(Color(hex: agent.color ?? "5b5bd6"))
                    .frame(width: 44, height: 44)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
                VStack(alignment: .leading, spacing: 4) {
                    Text(agent.name).font(.headline).foregroundStyle(.primary)
                    Text(agent.id).font(.caption).foregroundStyle(.secondary)
                }
            }
            if !description.isEmpty {
                Text(activityPreview(description)).font(.subheadline).foregroundStyle(.secondary).lineLimit(3)
            }
            HStack(spacing: 24) {
                stat("Working", count: tickets.filter { $0.status == .inProgress || $0.status == .inReview }.count)
                stat("Queued", count: tickets.filter { $0.status == .todo || $0.status == .backlog }.count)
                stat("Done", count: tickets.filter { $0.status == .done }.count)
            }
        }.padding(.vertical, 12)
    }
    private func stat(_ title: String, count: Int) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(count, format: .number).font(.headline).monospacedDigit().foregroundStyle(.primary)
            Text(title).font(.caption).foregroundStyle(.secondary)
        }.accessibilityElement(children: .combine)
    }
}

struct AgentHomeView: View {
    @Environment(Workspace.self) private var workspace
    let id: String
    @State private var home: AgentHome?
    @State private var error: String?
    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            if let home {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 10) { AgentRobotIcon().frame(width: 24, height: 24); Text(home.agent.name).font(.title2.bold()) }
                        Text(home.agent.id).font(.caption.monospaced()).foregroundStyle(.secondary)
                        if let profile = home.profile {
                            Text(profile.sourceLabel).font(.caption).foregroundStyle(.secondary)
                            Text("Updated \(Date(timeIntervalSince1970: profile.updated / 1000).formatted()) by \(workspace.agentName(profile.updatedBy))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }.padding(.vertical, 8)
                }
                Section("Description") {
                    AgentMarkdown(text: home.profile?.description ?? "", path: home.profile?.path,
                                  empty: "This agent hasn’t published a profile yet.")
                }
                Section("Operating instructions and rules") {
                    AgentMarkdown(text: home.profile?.instructions ?? "", path: home.profile?.path,
                                  empty: "No instructions or rules published yet.")
                }
                Section("Skills") {
                    if let skills = home.profile?.skills, !skills.isEmpty {
                        ForEach(skills) { skill in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(skill.name).font(.subheadline.weight(.semibold))
                                Text(skill.description).font(.subheadline).foregroundStyle(.secondary)
                            }.padding(.vertical, 4)
                        }
                    } else { Text("No skills listed yet.").foregroundStyle(.secondary) }
                }
                Section("Outputs") {
                    Text("Deliverables").font(.headline)
                    if home.deliverables.isEmpty { Text("No deliverables reported yet.").foregroundStyle(.secondary) }
                    ForEach(home.deliverables) { output in AgentDeliverableRow(agentID: id, output: output, onRemoved: load) }
                    Text("Activity").font(.headline)
                    if home.activity.isEmpty { Text("No activity yet.").foregroundStyle(.secondary) }
                    ForEach(home.activity) { event in
                        AgentActivityRow(event: event)
                    }
                }
            } else if error == nil { ProgressView("Loading agent…") }
        }.navigationTitle(home?.agent.name ?? workspace.agentName(id)).navigationBarTitleDisplayMode(.inline)
            .task(id: workspace.connection) {
                while !Task.isCancelled { await load(); try? await Task.sleep(for: .seconds(5)) }
            }.refreshable { await load() }
    }
    private func load() async {
        guard let client = workspace.client else { return }
        do {
            let result: AgentHome = try await client.request("agents/\(id)/home")
            try Task.checkCancellation()
            home = result; error = nil
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}

private struct AgentMarkdown: View {
    let text: String
    let path: String?
    let empty: String
    var body: some View {
        VStack(alignment: .leading) {
            if text.isEmpty { Text(empty).foregroundStyle(.secondary) }
            else { MarkdownView(text: .constant(text), readOnly: true, docPath: path ?? "") }
        }.padding(.vertical, 4)
    }
}

private struct AgentActivityRow: View {
    let event: ActivityEvent
    var body: some View {
        VStack(alignment: .leading) {
            if let ticket = event.ticket {
                NavigationLink { TaskDetailView(id: ticket) } label: { EventRow(event: event) }
            } else { EventRow(event: event) }
        }
    }
}

private struct AgentDeliverableRow: View {
    @Environment(Workspace.self) private var workspace
    let agentID: String
    let output: AgentDeliverable
    let onRemoved: () async -> Void
    @State private var preview: URL?
    @State private var error: String?
    @State private var busy = false
    @State private var confirmingRemoval = false
    private var label: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(output.title).font(.subheadline.weight(.medium))
            Text([output.kind.uppercased(), output.project, output.date].compactMap { $0 }.joined(separator: " · "))
                .font(.caption).foregroundStyle(.secondary)
            if let note = output.note, !note.isEmpty { Text(note).font(.caption).foregroundStyle(.secondary) }
        }.padding(.vertical, 4)
    }
    var body: some View {
        VStack(alignment: .leading) {
            switch AgentOutputTarget(output.url) {
            case .external(let url): Link(destination: url) { label }
            case .document(let path): NavigationLink { WikiPageView(path: path) } label: { label }
            case .file(let path):
                Button { Task { await open(path) } } label: { HStack { label; if busy { ProgressView() } } }.disabled(busy)
            case .unavailable: label
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }.quickLookPreview($preview)
            .swipeActions { Button("Remove", role: .destructive) { confirmingRemoval = true } }
            .confirmationDialog("Remove “\(output.title)” from deliverables?", isPresented: $confirmingRemoval, titleVisibility: .visible) {
                Button("Remove", role: .destructive) { Task { await remove() } }
            } message: { Text("The linked file or page will remain unchanged.") }
    }
    private func open(_ path: String) async {
        guard let client = workspace.client else { return }
        busy = true; defer { busy = false }
        do { preview = try await client.download(path); error = nil }
        catch { self.error = error.localizedDescription }
    }
    private func remove() async {
        guard let client = workspace.client else { return }
        struct Result: Decodable { let ok: Bool }
        do {
            let _: Result = try await client.request("agents/\(agentID)/deliverables/\(output.id)", method: "DELETE", query: [URLQueryItem(name: "agent", value: workspace.userID)])
            await onRemoved()
        } catch { self.error = error.localizedDescription }
    }
}
