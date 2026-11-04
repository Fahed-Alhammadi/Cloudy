package io.cloudy.app.data

/**
 * Names and etags from the server become parts of local file paths (offline copies, open with / send, PDF cache).
 * A broken or hostile server must not be able to write outside those folders ("../../shared_prefs/session.xml"), so
 * every such part goes through here. Same rules as the desktop app's checkName: no `/`, `\`, NUL (and here no
 * control characters either), and never "", "." or "..".
 */
object SafeName {
    private const val MAX_BYTES = 200 // file systems allow 255 bytes per name; leaves room for ".part"

    /** [name] as one path segment: bad characters become `_`, an unusable name becomes "file". */
    fun segment(name: String): String {
        var s = buildString { name.forEach { c -> append(if (c == '/' || c == '\\' || c == '\u0000' || c.isISOControl()) '_' else c) } }
        if (s.isEmpty() || s == "." || s == "..") s = "file"
        if (s.toByteArray().size > MAX_BYTES) {
            // Too long for the file system: shorten the name, keep the extension (so other apps know the type).
            val dot = s.lastIndexOf('.')
            val ext = if (dot > 0 && s.length - dot <= 16) s.substring(dot) else ""
            var base = s.substring(0, s.length - ext.length)
            while (base.isNotEmpty() && (base + ext).toByteArray().size > MAX_BYTES) base = base.dropLast(1)
            s = base.ifEmpty { "file" } + ext
        }
        return s
    }

    /** An etag reduced to `[A-Za-z0-9_-]` (it names cache folders). */
    fun etag(etag: String): String = etag.filter { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '_' || it == '-' }.take(64).ifEmpty { "0" }
}
