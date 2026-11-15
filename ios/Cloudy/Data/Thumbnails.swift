import Foundation
import ImageIO
import UIKit

/// Small previews for the grid view, like Android's NodeGrid. From a server that makes them (1.19+, `User.thumbnails`):
/// its small WebP of a picture or PDF, instead of downloading the whole picture. Pictures it has none of (BMP, a file it
/// could not read) and older servers: the picture itself, downloaded once with the device token. Downsampled with
/// ImageIO and kept in memory and in Caches/thumbs (keyed by node id + etag).
actor Thumbnails {
    static let shared = Thumbnails()

    private let memory = NSCache<NSString, UIImage>()
    private var loading: [String: Task<UIImage?, Never>] = [:]
    private var dir: URL { FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("thumbs") }

    /// Types the server makes thumbnails of (server/src/thumbs.ts THUMBABLE).
    nonisolated static let serverTypes: Set<String> = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif",
                                                       "image/heic", "image/heif", "image/tiff", "application/pdf"]

    /// A picture small enough (20 MB) to download whole for its preview.
    nonisolated static func picture(_ n: FileNode) -> Bool {
        !n.isDir && (n.mime ?? "").hasPrefix("image/") && n.bytes > 0 && n.bytes <= 20_000_000
    }

    /// Whether `n` can get a preview; `server`: the server makes thumbnails. Other files show their icon.
    nonisolated static func supports(_ n: FileNode, server: Bool) -> Bool {
        (server && !n.isDir && n.bytes > 0 && serverTypes.contains(n.mime ?? "")) || picture(n)
    }

    func image(for node: FileNode, server: Bool, pixels: CGFloat = 360) async -> UIImage? {
        let key = "\(node.id)-\(safeToken(node.etag ?? ""))"
        if let img = memory.object(forKey: key as NSString) { return img }
        if let task = loading[key] { return await task.value }
        let file = dir.appendingPathComponent(key + ".jpg")
        let task = Task<UIImage?, Never> {
            if let data = try? Data(contentsOf: file), let img = UIImage(data: data) { return img }
            var img: UIImage?
            if server, Self.serverTypes.contains(node.mime ?? "") {
                // The etag in the address gives a changed file a new one: the server lets it be cached for good.
                let v = (node.etag ?? "").addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
                if let data = try? await API.shared.send("GET", "/api/nodes/\(node.id)/thumb?v=\(v)") {
                    img = Self.downsample(data, pixels: pixels)
                }
            }
            if img == nil, Self.picture(node), let data = try? await API.shared.send("GET", "/api/nodes/\(node.id)/download?inline") {
                img = Self.downsample(data, pixels: pixels)
            }
            guard let img else { return nil }
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
