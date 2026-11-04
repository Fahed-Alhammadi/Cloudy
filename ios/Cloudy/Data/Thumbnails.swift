import Foundation
import ImageIO
import UIKit

/// Small previews of images for the grid view, like Android's NodeGrid: downloaded once with the device token,
/// downsampled with ImageIO and kept in memory and in Caches/thumbs (keyed by node id + etag).
actor Thumbnails {
    static let shared = Thumbnails()

    private let memory = NSCache<NSString, UIImage>()
    private var loading: [String: Task<UIImage?, Never>] = [:]
    private var dir: URL { FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("thumbs") }

    /// Images up to 20 MB get a thumbnail; other files show their icon.
    nonisolated static func supports(_ n: FileNode) -> Bool {
        !n.isDir && (n.mime ?? "").hasPrefix("image/") && n.bytes > 0 && n.bytes <= 20_000_000
    }

    func image(for node: FileNode, pixels: CGFloat = 360) async -> UIImage? {
        let key = "\(node.id)-\(safeToken(node.etag ?? ""))"
        if let img = memory.object(forKey: key as NSString) { return img }
        if let task = loading[key] { return await task.value }
        let file = dir.appendingPathComponent(key + ".jpg")
        let task = Task<UIImage?, Never> {
            if let data = try? Data(contentsOf: file), let img = UIImage(data: data) { return img }
            guard let data = try? await API.shared.send("GET", "/api/nodes/\(node.id)/download?inline"),
                  let img = Self.downsample(data, pixels: pixels) else { return nil }
            try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? img.jpegData(compressionQuality: 0.8)?.write(to: file)
            return img
        }
        loading[key] = task
        let img = await task.value
        loading[key] = nil
        if let img { memory.setObject(img, forKey: key as NSString) }
        return img
    }

    private static func downsample(_ data: Data, pixels: CGFloat) -> UIImage? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                     kCGImageSourceThumbnailMaxPixelSize: pixels]
        return CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary).map { UIImage(cgImage: $0) }
    }

    func clear() {
        memory.removeAllObjects()
        try? FileManager.default.removeItem(at: dir)
    }
}
