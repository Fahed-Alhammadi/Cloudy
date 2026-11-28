package io.cloudy.app.data

import android.content.Context
import androidx.compose.runtime.mutableStateOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
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
    /** The pinned ids once more, as Compose state: lists showing the "available offline" mark redraw when they change. */
    private val pinnedSeen = mutableStateOf<Set<Long>>(emptySet())
    @Volatile private var state: State = State()
        set(v) { field = v; pinnedSeen.value = v.pinned }
    private val stateLock = Any()
    private val lock = Mutex()
    // state.json grows with the pinned folders (thousands of files), so it is no longer read on the UI thread while
    // the app starts. Until it is loaded nothing counts as offline; [ready] waits for it.
    private val loading = CoroutineScope(Dispatchers.IO).launch {
        runCatching { json.decodeFromString<State>(stateFile.readText()) }.getOrNull()?.let { read -> update { read } }
    }

    /** Changes the state in one step: pinning and unpinning don't wait for a running download, and nothing is lost. */
    private fun update(change: (State) -> State) = synchronized(stateLock) { state = change(state) }

    /** Written next to the file and renamed: a stop in the middle of writing can't leave half a file (and no pins). */
    private fun save() {
        root.mkdirs()
        val tmp = File(root, "state.json.tmp")
        tmp.writeText(json.encodeToString(state))
        if (!tmp.renameTo(stateFile)) stateFile.writeText(tmp.readText())
    }

    /** Returns once the saved state is in memory. */
    suspend fun ready() = loading.join()

    fun isPinned(id: Long) = id in pinnedSeen.value
    val pinned: Set<Long> get() = state.pinned

    // The in-memory check comes first, so files that aren't offline never touch the disk (called while drawing lists).
    fun localFile(node: FileNode): File? =
        if (state.etags[node.id] != node.etag) null else File(root, "files/${node.id}/${SafeName.segment(node.name)}").takeIf { it.exists() }

    /** The node as last seen online, if its content is on the device: lets the app open it without network. */
    fun savedNode(id: Long): FileNode? = state.nodes[id]?.takeIf { localFile(it) != null }

    fun hasCachedListing(id: Long): Boolean = File(root, "dirs/$id.json").exists()

    fun cachedListing(id: Long): NodeListing? =
        runCatching { json.decodeFromString<NodeListing>(File(root, "dirs/$id.json").readText()) }.getOrNull()

    fun cacheListing(listing: NodeListing) {
        File(root, "dirs").mkdirs()
        File(root, "dirs/${listing.node.id}.json").writeText(json.encodeToString(listing))
    }

    suspend fun pin(node: FileNode) {
        ready()
        update { it.copy(pinned = it.pinned + node.id) } // marked at once, also while another download is running
        io { save() }
        sync()
    }

    suspend fun unpin(id: Long) {
        ready()
        update { it.copy(pinned = it.pinned - id) } // at once: a running download of it stops at its next file
        io {
            save()
            cleanup()
        }
    }

    private suspend fun <T> io(block: suspend () -> T): T = withContext(Dispatchers.IO) {
        ready()
        lock.withLock { block() }
    }

    /** Downloads everything pinned that changed on the server. Returns the number of files fetched. */
    suspend fun sync(onProgress: (String) -> Unit = {}): Int = io {
        var fetched = 0
        val keep = mutableSetOf<Long>()
        // False once the server refused something for a reason other than "gone" (a proxy's 502 while the server
        // restarts, a 500): what is on the server is then not known, and nothing is removed from the device this
        // time. Every copy that was not reached used to be deleted, so one bad answer emptied a pinned folder.
        var complete = true
        // What has been downloaded is written down every few seconds and when the run is cut short. It used to be
        // saved only at the very end, so after a stop (the background job's time limit, the app closed) every file
        // was downloaded again.
        var savedAt = System.nanoTime()
        fun fetchedOne(name: String) {
            fetched++
            onProgress(name)
            if (System.nanoTime() - savedAt > 5_000_000_000L) { save(); savedAt = System.nanoTime() }
        }
        /** One item; a failure skips only that item, so one bad file no longer stops the files after it. */
        suspend fun each(block: suspend () -> Unit) {
            try {
                block()
            } catch (e: ApiException) {
                if (e.status != 404) complete = false // 404: deleted since the listing, its copy goes with the clean-up
            }
        }
        /** [pin]: the pinned item this belongs to. */
        suspend fun visit(id: Long, pin: Long) {
            val listing = api.node(id)
            val n = listing.node
            keep += n.id
            update { it.copy(nodes = it.nodes + (n.id to n)) }
            if (n.isDir) {
                cacheListing(listing)
                for (c in listing.children.orEmpty()) {
                    // Unpinned meanwhile: leave the rest of it (this run then removes nothing; the next one tidies up).
                    if (pin !in state.pinned) { complete = false; return }
                    each { if (c.isDir) visit(c.id, pin) else if (fetchFile(c, keep) != null) fetchedOne(c.name) }
                }
            } else if (fetchFile(n, keep) != null) {
                fetchedOne(n.name)
            }
        }
        try {
            for (id in state.pinned) {
                if (id !in state.pinned) continue // unpinned while the ones before it were fetched
                try {
                    visit(id, id)
                } catch (e: ApiException) {
                    if (e.status == 404) update { it.copy(pinned = it.pinned - id) } else complete = false
                }
            }
        } finally {
            save() // also when cancelled or the connection is lost
        }
        if (complete) cleanup(keep)
        fetched
    }

    private suspend fun fetchFile(n: FileNode, keep: MutableSet<Long>): File? {
        keep += n.id
        update { it.copy(nodes = it.nodes + (n.id to n)) }
        if (localFile(n) != null) return null
        // The new version goes to a side folder first: if the download fails (network lost), the previous copy
        // stays and can still be opened offline.
        val tmp = File(root, "tmp/${n.id}")
        tmp.deleteRecursively()
        api.download(n.id, File(tmp, SafeName.segment(n.name)))
        val dir = File(root, "files/${n.id}")
        dir.deleteRecursively()
        dir.parentFile?.mkdirs()
        if (!tmp.renameTo(dir)) throw java.io.IOException("Could not save ${n.name}")
        update { it.copy(etags = it.etags + (n.id to n.etag)) }
        return File(dir, SafeName.segment(n.name))
    }

    /** Deletes content no longer reachable from a pinned item. */
    private fun cleanup(keep: Set<Long>? = null) {
        val live = keep ?: return run {
            if (state.pinned.isEmpty()) {
                File(root, "files").deleteRecursively()
                File(root, "dirs").deleteRecursively()
                update { if (it.pinned.isEmpty()) State() else it } // something pinned meanwhile keeps its pin
                save()
            }
        }
        File(root, "tmp").deleteRecursively() // downloads that were interrupted
        File(root, "files").listFiles()?.forEach { f -> if (f.name.toLongOrNull() !in live) f.deleteRecursively() }
        File(root, "dirs").listFiles()?.forEach { f -> if (f.nameWithoutExtension.toLongOrNull() !in live) f.delete() }
        update { it.copy(etags = it.etags.filterKeys { id -> id in live }, nodes = it.nodes.filterKeys { id -> id in live }) }
        save()
    }

    /** Removes every offline copy and listing (the account was deleted). */
    suspend fun clearAll() = io {
        root.deleteRecursively()
        update { State() }
    }

    /** Walks the whole offline folder: call from a background thread. */
    fun usedBytes(): Long = File(root, "files").walkBottomUp().filter { it.isFile }.sumOf { it.length() }
}
