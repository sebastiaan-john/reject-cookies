import FoundationModels

/// One interactive element in a consent dialog. Mirrors `Control` in web/src/protocol.ts.
struct DialogControl: Codable, Sendable {
    var index: Int
    var kind: String
    var label: String
    var checked: Bool?
    /// Autoconsent's regex reading of the label: reject, accept, settings, or acknowledge.
    var hint: String?
    /// Accepts everything, or is a paywall or login button. Never chosen.
    var forbidden: Bool?
}

/// A visible consent dialog as the content script saw it. Mirrors `DialogSnapshot` in web/src/protocol.ts.
struct DialogSnapshot: Codable, Sendable {
    var host: String
    var text: String
    var controls: [DialogControl]
    /// Labels already clicked in this dialog, oldest first.
    var clicked: [String]
}

/// The next step on a dialog. Mirrors `Decision` in web/src/protocol.ts.
struct ConsentDecision: Equatable, Sendable {
    enum Kind: String, Sendable {
        case decline, customize, save, noChoice, notConsent
    }

    var kind: Kind
    /// Index of the control to click, or -1.
    var target: Int
    /// Indices of toggles to switch off before clicking `target`.
    var turnOff: [Int]

    static let noChoice = ConsentDecision(kind: .noChoice, target: -1, turnOff: [])
    static let notConsent = ConsentDecision(kind: .notConsent, target: -1, turnOff: [])
}

/// What the model reads in a dialog. Code, not the model, turns this into a click.
@Generable
struct DialogReading {
    @Generable
    enum Role: String {
        case acceptAll, rejectAll, openSettings, saveChoices, optionalCategory, necessaryCategory, other
    }

    @Generable
    struct LabeledControl {
        @Guide(description: "The control's number from the list.", .range(0...(DialogReading.maxControls - 1)))
        var index: Int
        var role: Role
    }

    @Guide(description: "True if the dialog asks the visitor to consent to cookies or tracking.")
    var isCookieConsent: Bool

    @Guide(description: "A role for every control in the list, in order.", .maximumCount(DialogReading.maxControls))
    var controls: [LabeledControl]

    /// Matches `MAX_CONTROLS` in web/src/dialog.ts.
    static let maxControls = 30
}

/// Decides how to get rid of a cookie consent dialog while allowing as few cookies as possible.
/// Apple's on-device model labels the dialog's controls; `decision(from:for:)` picks the click.
enum ConsentDecider {
    static let instructions = """
        You read cookie consent dialogs on websites, in any language. You get the dialog's text and a numbered \
        list of its controls. Say whether the dialog asks for consent to cookies or tracking, then give each control \
        one role:
        - acceptAll: accepts or allows all cookies ("Accept all", "Alle akzeptieren", "Alles accepteren", "I agree", "OK").
        - rejectAll: rejects optional cookies or keeps only necessary ones ("Reject all", "Decline", "Weigeren", \
        "Nur notwendige", "Only necessary", "Continue without accepting", "Doorgaan zonder akkoord").
        - openSettings: opens cookie settings or preferences ("Manage options", "Settings", "Instellingen", \
        "Customize", "More options"). Language pickers, login, and subscribe buttons are other.
        - saveChoices: a button that saves or confirms the current selection ("Save", "Confirm my choices", \
        "Keuze opslaan", "Auswahl speichern"). Explanations and links about preferences are other.
        - optionalCategory: a toggle for an optional category such as analytics, statistics, performance, marketing, \
        advertising, personalization, social media, functional, or preferences.
        - necessaryCategory: a toggle for strictly necessary or essential cookies.
        - other: anything else, such as a privacy policy link or a close button.
        """

    static let model = SystemLanguageModel(useCase: .contentTagging)

    static var availability: (available: Bool, reason: String?) {
        switch model.availability {
        case .available:
            (true, nil)
        case .unavailable(.appleIntelligenceNotEnabled):
            (false, "Apple Intelligence is turned off")
        case .unavailable(.deviceNotEligible):
            (false, "this Mac does not support Apple Intelligence")
        case .unavailable(.modelNotReady):
            (false, "the model is still downloading")
        case .unavailable(let reason):
            (false, String(describing: reason))
        }
    }

    static func prompt(for dialog: DialogSnapshot) -> String {
        let controls = dialog.controls.map { control in
            let state = control.checked.map { $0 ? " (on)" : " (off)" } ?? ""
            return "[\(control.index)] \(control.kind) \"\(control.label)\"\(state)"
        }
        return """
            Site: \(dialog.host)

            Dialog text:
            \(dialog.text)

            Controls:
            \(controls.joined(separator: "\n"))
            """
    }

    static func read(_ dialog: DialogSnapshot) async throws -> DialogReading {
        let session = LanguageModelSession(model: model, instructions: instructions)
        // Without a cap the model sometimes keeps adding controls until the context runs out.
        let options = GenerationOptions(samplingMode: .greedy, maximumResponseTokens: 40 + 20 * dialog.controls.count)
        let response = try await session.respond(to: prompt(for: dialog), generating: DialogReading.self, options: options)
        return response.content
    }

    /// Asks the model to label the dialog and picks the next step. If the model fails, acts only on
    /// a reject or settings button that autoconsent's regexes recognise, and otherwise rethrows.
    static func decide(_ dialog: DialogSnapshot) async throws -> ConsentDecision {
        do {
            return decision(from: try await read(dialog), for: dialog)
        } catch {
            let fromHints = decision(from: DialogReading(isCookieConsent: true, controls: []), for: dialog)
            guard fromHints.kind == .decline || fromHints.kind == .customize else { throw error }
            return fromHints
        }
    }

    nonisolated(unsafe) private static let rejectsEverything = #/(?i)\b(all|alle|alles|tout|tous|todo|todas|tutti|wszystk)/#
    /// "Reject all marketing cookies" rejects one category, not everything.
    nonisolated(unsafe) private static let namesACategory =
        #/(?i)analyt|statist|marketing|advert|werbung|reclame|publicit|personali|social|functional|performance|tracking/#

    private static let hintRoles: [String: DialogReading.Role] = [
        "reject": .rejectAll, "accept": .acceptAll, "settings": .openSettings, "acknowledge": .acceptAll,
    ]

    /// Picks the step that leaves the fewest cookies: a reject-all button, then switching off every
    /// optional toggle and saving, then opening settings. Forbidden buttons and labels clicked in an
    /// earlier step are never picked.
    static func decision(from reading: DialogReading, for dialog: DialogSnapshot) -> ConsentDecision {
        guard reading.isCookieConsent else { return .notConsent }
        let modelRoles = Dictionary(reading.controls.map { ($0.index, $0.role) }, uniquingKeysWith: { first, _ in first })
        // Autoconsent's regexes are precise on the labels they recognise; the model covers the rest.
        func role(of control: DialogControl) -> DialogReading.Role? {
            hintRoles[control.hint ?? ""] ?? modelRoles[control.index]
        }
        let clicked = Set(dialog.clicked)
        func buttons(_ wanted: DialogReading.Role) -> [DialogControl] {
            dialog.controls.filter {
                $0.kind != "toggle" && $0.forbidden != true && !clicked.contains($0.label) && role(of: $0) == wanted
            }
        }
        let toggles = dialog.controls.filter { $0.kind == "toggle" }
        // Every toggle goes off unless the model calls it strictly necessary, so a toggle the model
        // skipped, or one the page switches on later, errs toward fewer cookies.
        let turnOff = toggles.filter { role(of: $0) != .necessaryCategory }.map(\.index)
        let anyOn = toggles.contains { $0.checked == true && role(of: $0) != .necessaryCategory }
        // "Reject all marketing cookies" rejects one category, so it never counts as declining.
        let rejects = buttons(.rejectAll).filter { !$0.label.contains(namesACategory) }
        let save = buttons(.saveChoices).first
        let settings = buttons(.openSettings).first

        if let reject = rejects.first(where: { $0.label.contains(rejectsEverything) }) {
            return ConsentDecision(kind: .decline, target: reject.index, turnOff: [])
        }
        // With nothing to switch off, saving only confirms; a settings view is the safer bet than a
        // button the model may have mistaken for "save".
        if !toggles.isEmpty, let save, anyOn || settings == nil {
            return ConsentDecision(kind: .save, target: save.index, turnOff: turnOff)
        }
        // Next to toggles, a plain "Reject" may cover one category, so settings come first there.
        if let reject = rejects.first, toggles.isEmpty || settings == nil {
            return ConsentDecision(kind: .decline, target: reject.index, turnOff: [])
        }
        if let settings {
            return ConsentDecision(kind: .customize, target: settings.index, turnOff: [])
        }
        return .noChoice
    }
}
