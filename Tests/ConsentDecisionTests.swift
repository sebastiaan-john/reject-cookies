import Testing


private func dialog(_ controls: [(String, String, Bool?)], clicked: [String] = []) -> DialogSnapshot {
    DialogSnapshot(
        host: "example.com",
        text: "We use cookies.",
        controls: controls.enumerated().map { DialogControl(index: $0, kind: $1.0, label: $1.1, checked: $1.2) },
        clicked: clicked
    )
}

private func reading(_ roles: [DialogReading.Role], consent: Bool = true) -> DialogReading {
    DialogReading(isCookieConsent: consent, controls: roles.enumerated().map { .init(index: $0, role: $1) })
}

@Test func prefersRejectOverSettings() {
    let d = dialog([("button", "Accept all", nil), ("button", "Settings", nil), ("button", "Reject all", nil)])
    let decision = ConsentDecider.decision(from: reading([.acceptAll, .openSettings, .rejectAll]), for: d)
    #expect(decision == ConsentDecision(kind: .decline, target: 2, turnOff: []))
}

@Test func opensSettingsWhenThereIsNoReject() {
    let d = dialog([("button", "Accept all", nil), ("button", "Manage options", nil)])
    let decision = ConsentDecider.decision(from: reading([.acceptAll, .openSettings]), for: d)
    #expect(decision == ConsentDecision(kind: .customize, target: 1, turnOff: []))
}

@Test func turnsOffOptionalTogglesThatAreOnAndSaves() {
    let d = dialog([
        ("button", "Accept all", nil), ("button", "Save choices", nil),
        ("toggle", "Necessary", true), ("toggle", "Analytics", true), ("toggle", "Marketing", false),
    ])
    let roles: [DialogReading.Role] = [.acceptAll, .saveChoices, .necessaryCategory, .optionalCategory, .optionalCategory]
    let decision = ConsentDecider.decision(from: reading(roles), for: d)
    #expect(decision == ConsentDecision(kind: .save, target: 1, turnOff: [3, 4]))
}

@Test func doesNotReopenSettingsAlreadyClicked() {
    let d = dialog([("button", "Accept all", nil), ("button", "Manage options", nil)], clicked: ["Manage options"])
    #expect(ConsentDecider.decision(from: reading([.acceptAll, .openSettings]), for: d) == .noChoice)
}

@Test func acceptOnlyDialogIsNoChoice() {
    let d = dialog([("button", "OK", nil), ("link", "Learn more", nil)])
    #expect(ConsentDecider.decision(from: reading([.acceptAll, .other]), for: d) == .noChoice)
}

@Test func notConsentWins() {
    let d = dialog([("button", "Subscribe", nil), ("button", "No thanks", nil)])
    #expect(ConsentDecider.decision(from: reading([.other, .rejectAll], consent: false), for: d) == .notConsent)
}

@Test func ignoresIndicesTheModelMadeUp() {
    let d = dialog([("button", "Accept all", nil)])
    let made = DialogReading(isCookieConsent: true, controls: [.init(index: 0, role: .acceptAll), .init(index: 7, role: .rejectAll)])
    #expect(ConsentDecider.decision(from: made, for: d) == .noChoice)
}

@Test func regexHintOverridesTheModel() {
    var d = dialog([("button", "Taal selecteren", nil), ("button", "Alleen noodzakelijke", nil)])
    d.controls[1].hint = "reject"
    let decision = ConsentDecider.decision(from: reading([.openSettings, .other]), for: d)
    #expect(decision == ConsentDecision(kind: .decline, target: 1, turnOff: []))
}

@Test func opensSettingsRatherThanSavingWhenNothingNeedsTurningOff() {
    var d = dialog([("button", "Explanation", nil), ("button", "Zelf instellen", nil), ("toggle", "Marketing", false)])
    d.controls[1].hint = "settings"
    let decision = ConsentDecider.decision(from: reading([.saveChoices, .openSettings, .optionalCategory]), for: d)
    #expect(decision == ConsentDecision(kind: .customize, target: 1, turnOff: []))
}

@Test func neverPicksSubscribeOrLogin() {
    var d = dialog([("button", "Consent and continue", nil), ("button", "Reject all and subscribe", nil), ("button", "Preferences", nil)])
    d.controls[0].hint = "accept"
    d.controls[1].hint = "reject"
    d.controls[1].forbidden = true
    d.controls[2].hint = "settings"
    let decision = ConsentDecider.decision(from: reading([.acceptAll, .rejectAll, .openSettings]), for: d)
    #expect(decision == ConsentDecision(kind: .customize, target: 2, turnOff: []))
}

@Test func prefersRejectAllOverACategoryReject() {
    var d = dialog([("button", "Weigeren", nil), ("button", "Aanvaarden", nil), ("button", "Alles weigeren", nil)])
    d.controls[0].hint = "reject"
    d.controls[1].hint = "accept"
    d.controls[2].hint = "reject"
    #expect(ConsentDecider.decision(from: reading([.other, .other, .other]), for: d) == ConsentDecision(kind: .decline, target: 2, turnOff: []))
}

@Test func turnsOffToggleTheModelSkipped() {
    let d = dialog([("button", "Save", nil), ("toggle", "Analytics", true), ("toggle", "Marketing", true)])
    let skipped = DialogReading(isCookieConsent: true, controls: [.init(index: 0, role: .saveChoices), .init(index: 1, role: .optionalCategory)])
    #expect(ConsentDecider.decision(from: skipped, for: d) == ConsentDecision(kind: .save, target: 0, turnOff: [1, 2]))
}

@Test func opensSettingsBeforeACategoryRejectNextToToggles() {
    var d = dialog([("button", "Reject analytics", nil), ("button", "Customize", nil), ("toggle", "Marketing", false)])
    d.controls[0].hint = "reject"
    d.controls[1].hint = "settings"
    #expect(ConsentDecider.decision(from: reading([.other, .other, .optionalCategory]), for: d) == ConsentDecision(kind: .customize, target: 1, turnOff: []))
}

@Test func aRejectAllForOneCategoryIsNotAGlobalReject() {
    var d = dialog([("button", "Reject all marketing cookies", nil), ("button", "Save", nil), ("toggle", "Analytics", true)])
    d.controls[0].hint = "reject"
    let decision = ConsentDecider.decision(from: reading([.other, .saveChoices, .optionalCategory]), for: d)
    #expect(decision == ConsentDecision(kind: .save, target: 1, turnOff: [2]))
}

@Test func aCategoryRejectNextToSettingsOpensSettings() {
    var d = dialog([("button", "Reject all marketing cookies", nil), ("button", "Manage preferences", nil)])
    d.controls[0].hint = "reject"
    d.controls[1].hint = "settings"
    #expect(ConsentDecider.decision(from: reading([.other, .other]), for: d) == ConsentDecision(kind: .customize, target: 1, turnOff: []))
}
