// Draws the sync badges for Windows and Linux (the Finder extension draws its own from SF Symbols, which may only be
// used on Apple platforms): a white glyph on a coloured disc with a thin white ring, same colours as on macOS.
//   swift badges/render.swift      (from desktop/; writes the files below, which are committed)
//   explorer/icons/<id>.ico        Windows overlays: full-size transparent icons with the badge in the lower-left corner
//   linux/icons/hicolor/<n>x<n>/emblems/emblem-cloudy-<id>.png    emblems for GNOME Files, Nemo, Caja and Dolphin
import AppKit

let badges: [(id: String, color: NSColor)] = [
    ("synced", NSColor(srgbRed: 0.16, green: 0.69, blue: 0.38, alpha: 1)),
    ("syncing", NSColor(srgbRed: 0.04, green: 0.42, blue: 0.85, alpha: 1)),
    ("error", NSColor(srgbRed: 0.84, green: 0.2, blue: 0.27, alpha: 1)),
]

/** The badge in a 64×64 space (y up), scaled into `rect`. */
func drawBadge(_ id: String, _ color: NSColor, in rect: NSRect) {
    let ctx = NSGraphicsContext.current!.cgContext
    ctx.saveGState()
    ctx.translateBy(x: rect.minX, y: rect.minY)
    ctx.scaleBy(x: rect.width / 64, y: rect.height / 64)
    NSColor.white.setFill()
    NSBezierPath(ovalIn: NSRect(x: 0, y: 0, width: 64, height: 64)).fill()
    color.setFill()
    NSBezierPath(ovalIn: NSRect(x: 5, y: 5, width: 54, height: 54)).fill()
    NSColor.white.setStroke()
    NSColor.white.setFill()
    let p = NSBezierPath()
    p.lineCapStyle = .round
    p.lineJoinStyle = .round
    p.lineWidth = 7.5
    switch id {
    case "synced":
        p.move(to: NSPoint(x: 19, y: 32))
        p.line(to: NSPoint(x: 28, y: 23))
        p.line(to: NSPoint(x: 45, y: 41))
        p.stroke()
    case "syncing":
        // Two arcs chasing each other, each ending in an arrowhead.
        p.lineWidth = 6
        p.appendArc(withCenter: NSPoint(x: 32, y: 32), radius: 14, startAngle: 200, endAngle: 340, clockwise: true)
        p.stroke()
        let q = NSBezierPath()
        q.lineCapStyle = .round
        q.lineWidth = 6
        q.appendArc(withCenter: NSPoint(x: 32, y: 32), radius: 14, startAngle: 20, endAngle: 160, clockwise: true)
        q.stroke()
        for (angle, dir) in [(340.0, -1.0), (160.0, -1.0)] {
            let a = angle * .pi / 180
            let tip = NSPoint(x: 32 + 14 * cos(a), y: 32 + 14 * sin(a))
            // Tangent of a clockwise arc at `a`, pointing along the motion.
            let t = NSPoint(x: sin(a) * dir * -1, y: -cos(a) * dir * -1)
            let n = NSPoint(x: cos(a), y: sin(a))
            let head = NSBezierPath()
            head.move(to: NSPoint(x: tip.x + t.x * 7, y: tip.y + t.y * 7))
            head.line(to: NSPoint(x: tip.x + n.x * 7 - t.x * 2, y: tip.y + n.y * 7 - t.y * 2))
            head.line(to: NSPoint(x: tip.x - n.x * 7 - t.x * 2, y: tip.y - n.y * 7 - t.y * 2))
            head.close()
            head.fill()
        }
    default: // error
        p.move(to: NSPoint(x: 32, y: 45))
        p.line(to: NSPoint(x: 32, y: 29))
        p.stroke()
        NSBezierPath(ovalIn: NSRect(x: 27.5, y: 14.5, width: 9, height: 9)).fill()
    }
    ctx.restoreGState()
}

func png(size: Int, draw: (NSRect) -> Void) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current!.imageInterpolation = .high
    draw(NSRect(x: 0, y: 0, width: size, height: size))
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

/** An .ico holding PNG images (Windows Vista and later read PNG entries of any size). */
func ico(_ images: [(Int, Data)]) -> Data {
    var d = Data()
    func u16(_ v: Int) { d.append(contentsOf: [UInt8(v & 0xff), UInt8(v >> 8 & 0xff)]) }
    func u32(_ v: Int) { u16(v & 0xffff); u16(v >> 16) }
    u16(0); u16(1); u16(images.count)
    var offset = 6 + 16 * images.count
    for (size, data) in images {
        d.append(UInt8(size >= 256 ? 0 : size)); d.append(UInt8(size >= 256 ? 0 : size))
        d.append(0); d.append(0); u16(1); u16(32); u32(data.count); u32(offset)
        offset += data.count
    }
    for (_, data) in images { d.append(data) }
    return d
}

let fm = FileManager.default
let root = URL(fileURLWithPath: fm.currentDirectoryPath)
for b in badges {
    // Windows draws an overlay over the whole icon: the badge takes the lower-left part (y up here).
    let images = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256].map { s in
        (s, png(size: s) { r in
            let w = (Double(s) * (s <= 24 ? 0.62 : 0.5)).rounded()
            drawBadge(b.id, b.color, in: NSRect(x: 0, y: 0, width: w, height: w))
        })
    }
    let icoURL = root.appendingPathComponent("explorer/icons/\(b.id).ico")
    try! fm.createDirectory(at: icoURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try! ico(images).write(to: icoURL)
    for s in [16, 22, 24, 32, 48, 64, 128] {
        let dir = root.appendingPathComponent("linux/icons/hicolor/\(s)x\(s)/emblems")
        try! fm.createDirectory(at: dir, withIntermediateDirectories: true)
        try! png(size: s) { r in drawBadge(b.id, b.color, in: r) }.write(to: dir.appendingPathComponent("emblem-cloudy-\(b.id).png"))
    }
}
print("ok")
