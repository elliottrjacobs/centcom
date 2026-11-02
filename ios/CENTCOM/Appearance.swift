import SwiftUI

enum AppAppearance: String, CaseIterable, Identifiable {
    case system, light, dark
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

struct SettingsLink: View {
    var body: some View {
        NavigationLink { SettingsView() } label: { Image(systemName: "gearshape") }
            .accessibilityLabel("Settings")
    }
}

struct SettingsView: View {
    @AppStorage("navigation.startPage") private var startPage = AppPage.tasks.rawValue
    @AppStorage("deviceName") private var deviceName = UIDevice.current.name
    @AppStorage("appearance") private var appearance = AppAppearance.system
    var body: some View {
        Form {
            Section {
                Picker("Default page", selection: $startPage) {
                    ForEach(AppPage.allCases) { Text($0.title).tag($0.rawValue) }
                }
            } header: { Text("On startup") } footer: { Text("Open this page when you launch CENTCOM on this device. Changing it won’t interrupt the page you’re viewing.") }

            Section {
                TextField("Device name", text: $deviceName).onChange(of: deviceName) { _, value in
                    deviceName = String(value.filter { !$0.isNewline && !$0.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) }.prefix(100))
                }
            } header: { Text("This device") } footer: { Text("Included with ticket updates from this iPhone or iPad. Your identity stays separate from the device. Leave blank to omit it.") }
            Section {
                Picker("Appearance", selection: $appearance) {
                    ForEach(AppAppearance.allCases) { Text($0.title).tag($0) }
                }.pickerStyle(.segmented)
            } header: { Text("Appearance") } footer: {
                Text("Light and Dark stay as selected. System follows your device’s appearance.")
            }
            Section {
                NavigationLink { ConnectionView() } label: { Label("Connection", systemImage: "network") }
            }
            if privacyURL != nil || supportURL != nil {
                Section {
                    if let privacyURL { Link(destination: privacyURL) { Label("Privacy policy", systemImage: "hand.raised") } }
                    if let supportURL { Link(destination: supportURL) { Label("Support", systemImage: "questionmark.circle") } }
                } header: { Text("About") } footer: { Text("CENTCOM collects nothing. It talks only to the server you connect it to.") }
            }
        }.navigationTitle("Settings").navigationBarTitleDisplayMode(.inline)
    }
    /// From Info.plist (`CENTCOM_PRIVACY_URL` / `CENTCOM_SUPPORT_URL` in Base.xcconfig); absent until set.
    private var privacyURL: URL? { Self.url("CENTCOMPrivacyURL") }
    private var supportURL: URL? { Self.url("CENTCOMSupportURL") }
    private static func url(_ key: String) -> URL? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String, value.hasPrefix("https://") else { return nil }
        return URL(string: value)
    }
}

private struct CompactListModifier: ViewModifier {
    func body(content: Content) -> some View {
        content.listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Color(uiColor: .systemBackground))
            .environment(\.defaultMinListRowHeight, 44)
            .listSectionSpacing(.compact)
    }
}

extension View {
    func compactList() -> some View { modifier(CompactListModifier()) }
}
