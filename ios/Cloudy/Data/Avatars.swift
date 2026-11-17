import Foundation
import ImageIO
import UIKit

/// Profile pictures (server 1.20+), like the web's `avatar()` and Android's `Avatar`. A picture's address carries its
/// version, so a cached copy never goes stale: a new picture has a new version. Kept in memory and in Caches/avatars.
actor Avatars {
    static let shared = Avatars()

    private let memory = NSCache<NSString, UIImage>()
    private var loading: [String: Task<UIImage?, Never>] = [:]
    private var dir: URL { FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("avatars") }

    /// Whether the picture is already in memory (shown at once, without a fade).
    nonisolated func cached(userId: String, version: String) -> UIImage? {
        memory.object(forKey: Self.key(userId, version) as NSString)
    }

    func image(userId: String, version: String) async -> UIImage? {
        let key = Self.key(userId, version)
        if let img = memory.object(forKey: key as NSString) { return img }
        if let task = loading[key] { return await task.value }
        let file = dir.appendingPathComponent(key + ".jpg")
        let task = Task<UIImage?, Never> {
            if let data = try? Data(contentsOf: file), let img = UIImage(data: data) { return img }
            guard let data = try? await API.shared.avatar(userId: userId, version: version),
                  let img = Self.downsample(data, pixels: 256) else { return nil }
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try? img.jpegData(compressionQuality: 0.85)?.write(to: file)
            return img
        }
        loading[key] = task
        let img = await task.value
        loading[key] = nil
        if let img { memory.setObject(img, forKey: key as NSString) }
        return img
    }

    func clear() {
        memory.removeAllObjects()
        try? FileManager.default.removeItem(at: dir)
    }

    private static func key(_ userId: String, _ version: String) -> String { "\(safeToken(userId))-\(safeToken(version))" }

    private static func downsample(_ data: Data, pixels: CGFloat) -> UIImage? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                     kCGImageSourceThumbnailMaxPixelSize: pixels]
        return CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary).map { UIImage(cgImage: $0) }
    }

    /// The picture in `data` as a square JPEG for upload: the middle of it, at most 512 px, upright (EXIF), white behind
    /// see-through parts. Drawing it anew leaves the photo's metadata (place, camera) behind. Nil when unreadable.
    nonisolated static func squareJPEG(_ data: Data, side maxSide: CGFloat = 512) -> Data? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
              let w = props[kCGImagePropertyPixelWidth] as? CGFloat, let h = props[kCGImagePropertyPixelHeight] as? CGFloat,
              w > 0, h > 0 else { return nil }
        // Decoded so that the shorter side is about 512 px (the longer one scales with it).
        let longest = max(w, h) * min(1, maxSide / min(w, h))
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                     kCGImageSourceThumbnailMaxPixelSize: ceil(longest)]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        let short = CGFloat(min(cg.width, cg.height))
        guard short > 0, let square = cg.cropping(to: CGRect(x: (CGFloat(cg.width) - short) / 2, y: (CGFloat(cg.height) - short) / 2,
                                                             width: short, height: short).integral) else { return nil }
        let out = min(short, maxSide)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let img = UIGraphicsImageRenderer(size: CGSize(width: out, height: out), format: format).image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: out, height: out))
            UIImage(cgImage: square).draw(in: CGRect(x: 0, y: 0, width: out, height: out))
        }
        return img.jpegData(compressionQuality: 0.9)
    }
}
