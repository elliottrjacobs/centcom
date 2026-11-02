import SwiftUI

enum AppPage: String, CaseIterable, Identifiable {
    case tasks, inbox, projects, activity, agents, skills, instructions, settings
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
    var symbol: String {
        switch self {
        case .tasks: "checklist"
        case .inbox: "tray"
        case .projects: "square.stack.3d.up"
        case .activity: "waveform.path"
        case .agents: "person.2"
        case .skills: "books.vertical"
        case .instructions: "doc.text"
        case .settings: "gearshape"
        }
    }
    @ViewBuilder var icon: some View {
        if self == .agents { AgentRobotIcon().frame(width: 20, height: 20) }
        else { Image(systemName: symbol) }
    }
    static func opening(_ raw:String?) -> AppPage { raw.flatMap(AppPage.init(rawValue:)) ?? .tasks }
    static func ordered(_ raw: String) -> [AppPage] {
        var seen = Set<AppPage>()
        return (raw.split(separator: ",").compactMap { AppPage(rawValue: String($0)) } + allCases).filter { seen.insert($0).inserted }
    }
    static func visible(_ order: String, hidden: String) -> [AppPage] {
        let hiddenIDs = Set(hidden.split(separator: ",").map(String.init))
        return ordered(order).filter { !hiddenIDs.contains($0.rawValue) }
    }

}
struct WorkspaceNavigation: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var selectionHighlight
    @AppStorage("navigation.order.v1") private var order = AppPage.allCases.map(\.rawValue).joined(separator: ",")
    @AppStorage("navigation.hidden.v1") private var hidden = ""
    @State private var selected = AppPage.opening(UserDefaults.standard.string(forKey: "navigation.startPage"))
    @State private var expanded = false
    @State private var customizing = false
    private var visible: [AppPage] { AppPage.visible(order, hidden: hidden) }
    private var pinned: [AppPage] { Array(visible.prefix(3)) }
    private var more: [AppPage] { Array(visible.dropFirst(3)) }
    var body: some View {
        NavigationStack {
            // Belongs to the root page, so pushed detail screens naturally replace the bar.
            VStack(spacing: 0) {
                page.id(selected).frame(maxWidth: .infinity, maxHeight: .infinity).clipped()
                navigationBar
            }
        }
            .sheet(isPresented: $customizing) { NavigationCustomization() }
            .onChange(of: visible, initial: true) { _, pages in
                if pages.isEmpty { hidden = ""; return }
                if !pages.contains(selected), let first = pages.first { selected = first }
            }
    }
    private var navigationBar: some View {
        HStack(spacing: 4) {
            ForEach(pinned) { destination in
                Button { selected = destination } label: {
                    VStack(spacing: 4) {
                        destination.icon.font(.system(size: 19))
                        Text(destination.title).font(.caption2.weight(.medium)).lineLimit(1)
                    }.frame(maxWidth: .infinity).frame(minHeight: 48)
                        .foregroundStyle(selected == destination ? .primary : .secondary)
                        .background { if selected == destination { selectionCapsule } }
                        .contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityLabel(destination.title)
                    .accessibilityAddTraits(selected == destination ? .isSelected : [])
            }
            if !pinned.isEmpty { Divider().frame(height: 24).padding(.horizontal, 2) }
            Button { expanded.toggle() } label: {
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 17, weight: .medium))
                    .frame(width: 48, height: 48)
                    .background { if more.contains(selected) { selectionCapsule } }
                    .contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityLabel("More pages")
                .accessibilityValue(more.contains(selected) ? "\(selected.title) selected" : "")
                .popover(isPresented: $expanded, arrowEdge: .bottom) {
                    VStack(spacing: 4) {
                        HStack {
                            Text("More pages").font(.caption.weight(.semibold)); Spacer()
                        }.padding(.horizontal, 12)
                        Divider()
                        ForEach(more) { destination in
                            Button { selected = destination; expanded = false } label: {
                                HStack(spacing: 14) { destination.icon.frame(width: 20); Text(destination.title); Spacer(); if selected == destination { Image(systemName: "checkmark").font(.caption.weight(.semibold)) } }
                                    .font(.subheadline).padding(.horizontal, 14).frame(minHeight: 44)
                                    .background(selected == destination ? Color.primary.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 12))
                            }.buttonStyle(.plain).accessibilityAddTraits(selected == destination ? .isSelected : [])
                        }
                        if more.isEmpty { Text("All your pages are in the bar.").font(.caption).foregroundStyle(.secondary).padding(12) }
                        Divider()
                        Button { expanded = false; customizing = true } label: {
                            Label("Arrange pages", systemImage: "slider.horizontal.3")
                                .font(.subheadline).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(.horizontal, 14)
                        }.buttonStyle(.plain)
                    }.padding(10).frame(minWidth: 250).presentationCompactAdaptation(.popover)
                }
        }.animation(reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.82), value: selected)
            .padding(6).background(.regularMaterial, in: Capsule())
            .overlay(Capsule().stroke(.secondary.opacity(0.12)))
            .frame(maxWidth: 420).padding(.horizontal, 20).padding(.vertical, 8)
    }
    private var selectionCapsule: some View {
        Capsule().fill(Color.primary.opacity(0.07))
            .matchedGeometryEffect(id: "selected-page", in: selectionHighlight)
    }
    @ViewBuilder private var page: some View {
        switch selected {
        case .tasks: TaskList(title: "Tasks")
        case .inbox: TaskList(title: "Inbox", inbox: true)
        case .projects: ProjectsView()
        case .activity: ActivityView()
        case .agents: AgentsView()
        case .skills: SkillsView()
        case .instructions: InstructionsView()
        case .settings: SettingsView()
        }
    }
}
struct NavigationCustomization: View {
    @AppStorage("navigation.startPage") private var startPage = AppPage.tasks.rawValue
    @Environment(\.dismiss) private var dismiss
    @AppStorage("navigation.order.v1") private var order = AppPage.allCases.map(\.rawValue).joined(separator: ",")
    @AppStorage("navigation.hidden.v1") private var hidden = ""
    private var hiddenIDs: Set<String> { Set(hidden.split(separator: ",").map(String.init)) }
    private var visible: [AppPage] { AppPage.ordered(order).filter { !hiddenIDs.contains($0.rawValue) } }
    private var hiddenPages: [AppPage] { AppPage.ordered(order).filter { hiddenIDs.contains($0.rawValue) } }
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Menu {
                        ForEach(visible) { page in
                            Button { startPage = page.rawValue } label: {
                                if startPage == page.rawValue { Label(page.title, systemImage: "checkmark") }
                                else { Text(page.title) }
                            }.accessibilityIdentifier("opening-page-" + page.rawValue)
                        }
                    } label: {
                        HStack {
                            Text("Opening page")
                            Spacer()
                            Text(AppPage.opening(startPage).title).foregroundStyle(.secondary)
                            Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(.secondary)
                        }.foregroundStyle(.primary)
                    }.accessibilityLabel("Opening page").accessibilityValue(AppPage.opening(startPage).title)
                        .accessibilityIdentifier("opening-page-picker")
                } header: { Text("On startup") } footer: { Text("Open this page when you launch CENTCOM. Your current page stays open while you arrange the bar.") }
                Section {
                    ForEach(visible) { page in
                        HStack {
                            Label { Text(page.title) } icon: { page.icon }
                            Spacer()
                            Text(visible.prefix(3).contains(page) ? "In bar" : "More")
                                .font(.caption).foregroundStyle(.secondary)
                        }.frame(minHeight: 32)
                            .deleteDisabled(visible.count <= 1)
                    }
                        .onMove { from, to in
                            var items = visible
                            items.move(fromOffsets: from, toOffset: to)
                            order = (items + hiddenPages).map(\.rawValue).joined(separator: ",")
                        }
                        .onDelete { indices in
                            var next = hiddenIDs
                            for index in indices { next.insert(visible[index].rawValue) }
                            if next.count < AppPage.allCases.count { hidden = next.sorted().joined(separator: ",") }
                        }
                } header: { Text("Page order") } footer: { Text("Drag the handles to change the order. The first three pages stay in your bar; the rest open from the arrows. Tap minus to hide a page.") }
                Section("Hidden items") {
                    if hiddenPages.isEmpty { Text("No hidden items").foregroundStyle(.secondary) }
                    ForEach(hiddenPages) { page in
                        Button { hidden = hiddenIDs.subtracting([page.rawValue]).sorted().joined(separator: ",") } label: {
                            HStack { Label { Text(page.title) } icon: { page.icon }; Spacer(); Image(systemName: "plus.circle") }
                        }.buttonStyle(.plain)
                    }.onMove(perform: nil).deleteDisabled(true)
                }
                Section { Button("Reset to default") { order = AppPage.allCases.map(\.rawValue).joined(separator: ","); hidden = ""; startPage = AppPage.tasks.rawValue } }
            }.environment(\.editMode, .constant(.active))
                .onChange(of: visible, initial: true) { _, pages in
                    if !pages.contains(where: { $0.rawValue == startPage }), let first = pages.first { startPage = first.rawValue }
                }
                .navigationTitle("Arrange pages").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
