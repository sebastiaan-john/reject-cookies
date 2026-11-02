// Renders the extension's PNG icons. Edit App/AppIcon.icon in Icon Composer and assets/toolbar.svg,
// then run: swift scripts/render-icons.swift
// The app uses App/AppIcon.icon directly; Xcode compiles it.
import AppKit

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let ictool = "/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool"

/** Icon Composer's renderer, so the PNGs get the same glass, shape, and lighting as the app icon. */
func exportAppIcon(_ size: Int, to path: String) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: ictool)
    process.arguments = [
        root.appending(path: "App/AppIcon.icon").path, "--export-image",
        "--output-file", root.appending(path: path).path,
        "--platform", "macOS", "--rendition", "Default",
        "--width", "\(size)", "--height", "\(size)", "--scale", "1",
    ]
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { fatalError("ictool failed for \(path)") }
}

/** Safari draws toolbar icons as templates, so only the glyph's alpha matters. */
func renderToolbar(_ size: Int, to path: String) throws {
    guard let svg = NSImage(contentsOf: root.appending(path: "assets/toolbar.svg")) else { fatalError("cannot load toolbar.svg") }
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    svg.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
    NSGraphicsContext.restoreGraphicsState()
    try rep.representation(using: .png, properties: [:])!.write(to: root.appending(path: path))
}

for size in [48, 96, 128, 256, 512] { try exportAppIcon(size, to: "web/static/images/icon-\(size).png") }
try exportAppIcon(256, to: "assets/icon.png")
for size in [16, 32] { try renderToolbar(size, to: "web/static/images/toolbar-\(size).png") }
