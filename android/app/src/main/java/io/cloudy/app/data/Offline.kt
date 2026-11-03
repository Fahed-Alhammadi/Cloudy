package io.cloudy.app.data

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File

/**
 * Keeps pinned files and folders on the device.
 * Layout under filesDir/offline:
 *   files/<nodeId>/<name>     downloaded content
 *   dirs/<nodeId>.json        cached folder listing (for browsing without network)
 *   state.json                pinned ids + etag and details of each downloaded file (to open it offline)
 * Disk work runs on Dispatchers.IO, one change at a time ([lock]); the getters only read the in-memory state.
 */
class Offline(context: Context, private val api: Api) {
    private val root = File(context.filesDir, "offline")
    private val json = Json { ignoreUnknownKeys = true }

    @kotlinx.serialization.Serializable
    private data class State(
        val pinned: Set<Long> = emptySet(),
        val etags: Map<Long, String> = emptyMap(),
        val nodes: Map<Long, FileNode> = emptyMap(),
    )

    private val stateFile = File(root, "state.json")
    // Read once at startup (a small file); afterwards only the in-memory copy is read on the UI thread.
    @Volatile private var state: State = runCatching { json.decodeFromString<State>(stateFile.readText()) }.getOrDefault(State())
    private val lock = Mutex()

    private fun save() {
        root.mkdirs()
        stateFile.writeText(json.encodeToString(state))
    }

    fun isPinned(id: Long) = id in state.pinned
    val pinned: Set<Long> get() = state.pinned

    // The in-memory check comes first, so files that aren't offline never touch the disk (called while drawing lists).
    fun localFile(node: FileNode): File? =
        if (state.etags[node.id] != node.etag) null else File(root, "files/${node.id}/${node.name}").takeIf { it.exists() }

    /** The node as last seen online, if its content is on the device: lets the app open it without network. */
    fun savedNode(id: Long): FileNode? = state.nodes[id]?.takeIf { localFile(it) != null }

    /** Any downloaded copy, even if outdated (used when offline). */
    fun anyLocalFile(id: Long): File? = File(root, "files/$id").listFiles()?.firstOrNull()

    fun hasCachedListing(id: Long): Boolean = File(root, "dirs/$id.json").exists()

    fun cachedListing(id: Long): NodeListing? =
        runCatching { json.decodeFromString<NodeListing>(File(root, "dirs/$id.json").readText()) }.getOrNull()

    fun cacheListing(listing: NodeListing) {
        File(root, "dirs").mkdirs()
        File(root, "dirs/${listing.node.id}.json").writeText(json.encodeToString(listing))
    }

    suspend fun pin(node: FileNode) {
        io {
            state = state.copy(pinned = state.pinned + node.id)
            save()
        }
        sync()
    }

    suspend fun unpin(id: Long) = io {
        state = state.copy(pinned = state.pinned - id)
        save()
        cleanup()
    }

    private suspend fun <T> io(block: suspend () -> T): T = withContext(Dispatchers.IO) { lock.withLock { block() } }

    /** Downloads everything pinned that changed on the server. Returns the number of files fetched. */
    suspend fun sync(onProgress: (String) -> Unit = {}): Int = io {
        var fetched = 0
        val keep = mutableSetOf<Long>()
        suspend fun visit(id: Long) {
            val listing = api.node(id)
            val n = listing.node
            keep += n.id
            state = state.copy(nodes = state.nodes + (n.id to n))
            if (n.isDir) {
                cacheListing(listing)
                for (c in listing.children.orEmpty()) {
                    if (c.isDir) visit(c.id) else fetchFile(c, keep)?.let { fetched++; onProgress(c.name) }
                }
            } else if (fetchFile(n, keep) != null) {
                fetched++
                onProgress(n.name)
            }
        }
        for (id in state.pinned) {
            try {
                visit(id)
            } catch (e: ApiException) {
                if (e.status == 404) state = state.copy(pinned = state.pinned - id)
            }
        }
        save()
        cleanup(keep)
        fetched
    }

    private suspend fun fetchFile(n: FileNode, keep: MutableSet<Long>): File? {
        keep += n.id
        state = state.copy(nodes = state.nodes + (n.id to n))
        if (localFile(n) != null) return null
        val dir = File(root, "files/${n.id}")
        dir.deleteRecursively()
        val dest = File(dir, n.name)
        api.download(n.id, dest)
        state = state.copy(etags = state.etags + (n.id to n.etag))
        return dest
    }

    /** Deletes content no longer reachable from a pinned item. */
    private fun cleanup(keep: Set<Long>? = null) {
        val live = keep ?: return run {
            if (state.pinned.isEmpty()) {
                File(root, "files").deleteRecursively()
                File(root, "dirs").deleteRecursively()
                state = State()
                save()
            }
        }
        File(root, "files").listFiles()?.forEach { f -> if (f.name.toLongOrNull() !in live) f.deleteRecursively() }
        File(root, "dirs").listFiles()?.forEach { f -> if (f.nameWithoutExtension.toLongOrNull() !in live) f.delete() }
        state = state.copy(etags = state.etags.filterKeys { it in live }, nodes = state.nodes.filterKeys { it in live })
        save()
    }

    /** Removes every offline copy and listing (the account was deleted). */
    suspend fun clearAll() = io {
        root.deleteRecursively()
        state = State()
    }

    /** Walks the whole offline folder: call from a background thread. */
    fun usedBytes(): Long = File(root, "files").walkBottomUp().filter { it.isFile }.sumOf { it.length() }
}
