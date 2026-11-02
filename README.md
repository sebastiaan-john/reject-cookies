<img src="assets/icon.svg" width="64" height="64" alt="">

# Reject Cookies

A Safari extension for macOS that rejects cookie banners for you, or keeps only the necessary cookies when a site offers no reject button.

1. Known consent platforms (OneTrust, Didomi, Sourcepoint, Usercentrics, Cookiebot, and hundreds more) are handled by DuckDuckGo's [autoconsent](https://github.com/duckduckgo/autoconsent) rules, the same ones the DuckDuckGo browser uses. Its heuristic mode clicks an obvious "Reject all" button on other banners.
2. Any banner still on screen after that goes to Apple's on-device model (Foundation Models). The model labels each button and toggle ("accept all", "reject all", "open settings", "save", "optional category"). Plain code then picks the click: reject if possible; otherwise switch off optional categories and save; otherwise open the settings and look again.
3. A banner with no way to decline, such as a lone "OK", is hidden and the page's scroll lock is removed. So is a pay-or-accept wall.

The extension never clicks a button that accepts everything, a subscribe, pay, or login button, or a link that loads another page. It checks the button again right before clicking. Nothing leaves your Mac.

## Requirements

- macOS 26 or later with Apple Intelligence turned on, for the model fallback. Rules still work without it.
- Xcode 26 or later, [XcodeGen](https://github.com/yonaskolb/XcodeGen), and [Bun](https://bun.sh).

## Build and install

A Developer ID–signed, notarized build shows up in Safari like any other extension. Sign in to Xcode with an account on the team in `project.yml`, then:

```sh
xcodegen generate
xcodebuild -project RejectCookies.xcodeproj -scheme RejectCookies -configuration Release \
  -archivePath .build/RejectCookies.xcarchive -allowProvisioningUpdates archive
# Signs with Developer ID and sends the app to Apple's notary service with the Xcode account.
xcodebuild -exportArchive -archivePath .build/RejectCookies.xcarchive \
  -exportOptionsPlist ExportOptions.plist -exportPath .build/export -allowProvisioningUpdates
# Once Apple has notarized it (usually a few minutes; this fails until then):
xcodebuild -exportNotarizedApp -archivePath .build/RejectCookies.xcarchive -exportPath .build/notarized
ditto ".build/notarized/Reject Cookies.app" "/Applications/Reject Cookies.app"
open "/Applications/Reject Cookies.app"
```

If `-exportArchive` fails with "No Accounts" even though Xcode shows your account, distribute from Xcode instead: `open .build/RejectCookies.xcarchive`, then in the Organizer choose Distribute App → Direct Distribution, and export the notarized app when it is ready.

The Xcode build runs `bun run build` in `web/` first. A plain Debug build from Xcode works too, but Safari hides development-signed extensions until Safari → Settings → Developer → "Allow unsigned extensions" is on, and that resets when Safari quits.

Then turn the extension on in Safari → Settings → Extensions and allow it on all websites. The toolbar button shows what happened on the current page and turns the extension off for a site.

## Layout

| Path | What it is |
| --- | --- |
| `web/src/content.ts` | Runs autoconsent in every frame, and hands banners the rules missed to the model, one step at a time. |
| `web/src/dialog.ts` | Finds a visible consent dialog and its controls, and turns them into a snapshot the model can read. |
| `web/src/background.ts` | Serves autoconsent rules, runs its page scripts, and calls the native model unless a rule in any frame of the tab is handling the banner. Remembers per-tab outcomes. |
| `Shared/ConsentDecider.swift` | The model prompt, its structured output, and the code that turns labels into a click. |
| `Extension/SafariWebExtensionHandler.swift` | The native messaging endpoint inside the Safari app extension. |
| `App/` | The container app. It shows whether the extension is on and whether the model is available. |
| `Tools/decide/` | A command-line wrapper around `ConsentDecider` used by the end-to-end script. |

## Checks

```sh
xcodebuild -project RejectCookies.xcodeproj -scheme RejectCookies test   # decision logic
(cd web && bun run check)                                                # TypeScript

# End to end in WebKit against real sites, with the real model:
swiftc -O -swift-version 6 -o .build/decide Shared/ConsentDecider.swift Tools/decide/main.swift
(cd web && bun run build && bun run e2e)                 # rules first, like the extension
(cd web && bun run e2e --model-only)                     # every banner goes to the model
```

The end-to-end script writes before and after screenshots and `results.json` to `.build/e2e/`. Sites only show banners to visitors from regions that require them, such as the EU.

## Third-party code

The bundled autoconsent library and rules are MPL-2.0.
