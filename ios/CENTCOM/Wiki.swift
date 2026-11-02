import QuickLook
import SwiftUI
import UniformTypeIdentifiers

/// The project's library: docs, documentation, outputs and files. (Type names keep the old "Wiki" name.)
struct ProjectWiki: View {
    @Environment(Workspace.self) private var workspace
    let slug: String
    @State private var pages: [WikiNode] = []
    @State private var error: String?
    @State private var loaded = false
    @State private var creating = false
    @State private var importing = false
    @State private var uploading = false
    @State private var query = ""
    @State private var preview: URL?
    @State private var opening: String?
    @AppStorage("wikiSort") private var sort = "title"
    private var visiblePages: [WikiNode] { pages.filter { query.isEmpty || $0.displayName.localizedCaseInsensitiveContains(query) || $0.name.localizedCaseInsensitiveContains(query) }.sorted { if sort == "updated" && $0.mtime != $1.mtime { return ($0.mtime ?? 0) > ($1.mtime ?? 0) }; return $0.displayName.localizedStandardCompare($1.displayName) == .orderedAscending } }
    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            if uploading { ProgressView("Uploading file…") }
            if loaded && pages.isEmpty { ContentUnavailableView("Your project library", systemImage: "book.closed", description: Text("Add docs, decisions, runbooks, outputs and files for this project.")) }
            ForEach(visiblePages) { page in
                if page.isDocument {
                    NavigationLink { WikiPageView(path: page.path) } label: { Label(page.displayName, systemImage: page.symbol) }
                } else {
                    Button { Task { await open(page) } } label: {
                        HStack { Label(page.displayName, systemImage: page.symbol); Spacer(); if opening == page.path { ProgressView() } }
                    }.disabled(opening != nil).accessibilityHint("Opens a preview of the file")
                }
            }
        }.navigationTitle("Library")
            .searchable(text: $query, prompt: "Find docs and files")
            .task {
                while !Task.isCancelled { await load(); try? await Task.sleep(for: .seconds(5)) }
            }.refreshable { await load() }
            .quickLookPreview($preview)
            .toolbar { Menu { Picker("Sort the library", selection: $sort) { Text("Title A–Z").tag("title"); Text("Recently updated").tag("updated") } } label: { Image(systemName: "arrow.up.arrow.down") }.accessibilityLabel("Sort the library"); Menu { Button("New doc", systemImage: "doc.badge.plus") { creating = true }; Button("Upload file", systemImage: "square.and.arrow.up") { importing = true }.disabled(uploading) } label: { Image(systemName: "plus") }.accessibilityLabel("Add to Library") }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.item]) { result in
                switch result {
                case .success(let file): Task { await upload(file) }
                case .failure(let error): self.error = error.localizedDescription
                }
            }
            .sheet(isPresented: $creating, onDismiss: { Task { await load() } }) { WikiEditor(slug: slug) }
    }
    private func load() async {
        guard let client = workspace.client else { return }
        do {
            let tree: WikiNode = try await client.request("tree")
            pages = tree.find("Projects/\(slug)/Library")?.documents ?? []
            error = nil; loaded = true
        } catch { self.error = error.localizedDescription }
    }
    private func upload(_ file: URL) async {
        guard let client = workspace.client else { return }
        uploading = true; defer { uploading = false }
        do {
            let _ = try await client.upload(file, directory: "Projects/\(slug)/Library", agent: workspace.userID)
            await load()
        } catch { self.error = error.localizedDescription }
    }
    private func open(_ file: WikiNode) async {
        guard let client = workspace.client else { return }
        opening = file.path; defer { opening = nil }
        do { preview = try await client.download(file.path); error = nil }
        catch { self.error = error.localizedDescription }
    }
}

struct WikiPageView: View {
    @Environment(Workspace.self) private var workspace
    let path: String
    @State private var document: WikiDocument?
    @State private var error: String?
    @State private var editing = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if let document {
                    Text(document.title).font(.largeTitle.bold())
                    MarkdownView(text: .constant(document.body), readOnly: true, docPath: path)
                } else if let error { Text(error).foregroundStyle(.red) } else { ProgressView() }
            }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
        }.navigationTitle("Library").navigationBarTitleDisplayMode(.inline)
            .task(id: editing) {
                guard !editing else { return }
                while !Task.isCancelled { await load(); try? await Task.sleep(for: .seconds(5)) }
            }.refreshable { await load() }
            .toolbar { Button("Edit") { editing = true }.disabled(document == nil) }
            .sheet(isPresented: $editing, onDismiss: { Task { await load() } }) {
                if let document { WikiEditor(slug: path.split(separator: "/").dropFirst().first.map(String.init) ?? "", document: document) }
            }
    }
    private func load() async {
        do { document = try await workspace.client?.request("doc", query: [URLQueryItem(name: "path", value: path)]); error = nil }
        catch { self.error = error.localizedDescription }
    }
}

struct WikiEditor: View {
    @Environment(Workspace.self) private var workspace
    @Environment(\.dismiss) private var dismiss
    let slug: String
    let document: WikiDocument?
    @State private var title: String
    @State private var text: String
    @State private var busy = false
    @State private var error: String?
    // An independent editing draft preserves unsaved content across refreshes.
    init(slug: String, document: WikiDocument? = nil) {
        self.slug = slug; self.document = document
        _title = State(initialValue: document?.title ?? "")
        _text = State(initialValue: document?.body ?? "")
    }
    var body: some View {
        NavigationStack {
            Form {
                if document == nil { TextField("Doc title", text: $title) }
                Section("Content") { MarkdownView(text: $text, docPath: document?.path ?? "Projects/\(slug)/Library/Untitled.md") }
                if let error { Text(error).foregroundStyle(.red) }
            }.markdownKeyboardToolbar().navigationTitle(document == nil ? "New doc" : "Edit doc").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }
                    ToolbarItem(placement: .confirmationAction) { Button { save() } label: { Text(busy ? "Saving…" : "Save").foregroundStyle(.white) }.buttonStyle(.borderedProminent).tint(.navy).foregroundStyle(.white).disabled(busy || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
                }.interactiveDismissDisabled(busy || text != (document?.body ?? ""))
        }
    }
    private func save() {
        busy = true; error = nil
        Task {
            defer { busy = false }
            do {
                guard let client = workspace.client else { throw ClientError.message("Connect to your server first.") }
                let name = title.components(separatedBy: CharacterSet(charactersIn: "/\\:\u{0}")).joined(separator: "-").trimmingCharacters(in: .whitespacesAndNewlines)
                let path = document?.path ?? "Projects/\(slug)/Library/\(name).md"
                var payload: [String: Any] = ["path": path, "body": text, "agent": workspace.userID]
                if let document { payload["ifMatch"] = document.mtime }
                else { payload["frontmatter"] = ["title": title] }
                let _: WikiDocument = try await client.request("doc", method: document == nil ? "POST" : "PUT", body: payload)
                dismiss()
            } catch { self.error = error.localizedDescription }
        }
    }
}
