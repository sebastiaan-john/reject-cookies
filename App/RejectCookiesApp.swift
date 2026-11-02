import SafariServices
import SwiftUI

let extensionIdentifier = "ai.sebastiaan.RejectCookies.Extension"

@main
struct RejectCookiesApp: App {
    var body: some Scene {
        Window("Reject Cookies", id: "main") {
            StatusView()
        }
        .windowResizability(.contentSize)
    }
}

/// Shows whether the Safari extension is on and whether the on-device model can run.
struct StatusView: View {
    @State private var extensionEnabled: Bool?
    @State private var model = ConsentDecider.availability

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label {
                Text(extensionLabel)
            } icon: {
                Image(systemName: extensionEnabled == true ? "checkmark.circle.fill" : "circle.dashed")
                    .foregroundStyle(extensionEnabled == true ? .green : .secondary)
            }
            Label {
                Text(model.available ? "On-device model ready" : "On-device model unavailable: \(model.reason ?? "unknown")")
            } icon: {
                Image(systemName: model.available ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                    .foregroundStyle(model.available ? .green : .orange)
            }
            Text("Known consent platforms are rejected with DuckDuckGo's autoconsent rules. Other banners are read by Apple's on-device model, which rejects them or turns off optional categories. Nothing leaves your Mac.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Open Safari Extension Settings") {
                SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionIdentifier)
            }
        }
        .padding(20)
        .frame(width: 380)
        .task { await refresh() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await refresh() }
        }
    }

    private var extensionLabel: String {
        switch extensionEnabled {
        case true?: "Extension is on in Safari"
        case false?: "Turn the extension on in Safari Settings → Extensions"
        case nil: "Checking Safari…"
        }
    }

    private func refresh() async {
        model = ConsentDecider.availability
        extensionEnabled = try? await SFSafariExtensionManager.stateOfSafariExtension(withIdentifier: extensionIdentifier).isEnabled
    }
}
