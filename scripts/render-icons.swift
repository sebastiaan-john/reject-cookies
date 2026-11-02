// Renders assets/icon.svg into the PNG sizes the extension and the app's asset catalog need.
// Usage: swift scripts/render-icons.swift
import AppKit

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
guard let svg = NSImage(contentsOf: root.appending(path: "assets/icon.svg")) else { fatalError("cannot load icon.svg") }

func render(_ size: Int, to path: String) throws {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    svg.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
    NSGraphicsContext.restoreGraphicsState()
    let url = root.appending(path: path)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try rep.representation(using: .png, properties: [:])!.write(to: url)
}

for size in [48, 96, 128, 256, 512] { try render(size, to: "web/static/images/icon-\(size).png") }
for size in [16, 32] { try render(size, to: "web/static/images/toolbar-\(size).png") }
for size in [16, 32, 64, 128, 256, 512, 1024] { try render(size, to: "App/Assets.xcassets/AppIcon.appiconset/icon-\(size).png") }
