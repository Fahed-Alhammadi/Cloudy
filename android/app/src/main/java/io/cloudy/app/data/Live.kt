package io.cloudy.app.data

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.isActive

/**
 * Live updates: one Server-Sent Events stream while the app is visible. Screens collect [events]
 * and reload when their folder is listed, so changes from other devices show up without refreshing.
 */
object Live {
    /**
     * Folder id in [ChangeEvent.folders] meaning "anything may have changed": sent when the stream connects again
     * (after a network drop, or when the app returns from the background), because the server doesn't replay the
     * changes made while no stream was open.
     */
    const val ANY = -1L

    private val _events = MutableSharedFlow<ChangeEvent>(extraBufferCapacity = 32)
    val events: SharedFlow<ChangeEvent> = _events
    /** A stream was open before in this process (the screens shown since then may be out of date). */
    @Volatile private var connectedBefore = false

    /** Whether [e] may concern the listing of [folderId]. */
    fun affects(e: ChangeEvent, folderId: Long) = folderId in e.folders || ANY in e.folders

    /** Runs until cancelled (call while the UI is started); reconnects after network errors. */
    suspend fun run(api: Api) {
        var wait = 5_000L
        while (currentCoroutineContext().isActive) {
            try {
                api.streamEvents(onOpen = {
                    wait = 5_000L
                    if (connectedBefore) _events.tryEmit(ChangeEvent(folders = listOf(ANY), shares = true))
                    connectedBefore = true
                }) { _events.tryEmit(it) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                if (e.status == 401 || e.status == 404) return // logged out, or a server without live updates
            } catch (_: Exception) {
                // network error: retry below
            }
            // Up to a minute between attempts while the server stays unreachable (radio and battery).
            delay(wait)
            wait = (wait * 2).coerceAtMost(60_000L)
        }
    }
}

/** Office file types the server shows as read-only PDF previews (loaded after login). */
object Office {
    @Volatile var extensions: Set<String> = emptySet()

    fun canPreview(node: FileNode): Boolean =
        !node.isDir && node.name.substringAfterLast('.', "").lowercase() in extensions

    suspend fun load(api: Api) {
        extensions = runCatching { api.office().extensions.toSet() }.getOrDefault(extensions)
    }
}
