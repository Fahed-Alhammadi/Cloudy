package io.cloudy.app.work

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import io.cloudy.app.R
import io.cloudy.app.Services
import io.cloudy.app.data.ApiException
import io.cloudy.app.data.SourceException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import java.util.concurrent.TimeUnit

/** Photo backup settings, stored in app preferences. */
class BackupSettings(context: Context) {
    private val prefs = context.getSharedPreferences("backup", Context.MODE_PRIVATE)
    var enabled: Boolean
        get() = prefs.getBoolean("enabled", false)
        set(v) = prefs.edit().putBoolean("enabled", v).apply()
    var wifiOnly: Boolean
        get() = prefs.getBoolean("wifiOnly", true)
        set(v) = prefs.edit().putBoolean("wifiOnly", v).apply()
    var includeVideos: Boolean
        get() = prefs.getBoolean("videos", true)
        set(v) = prefs.edit().putBoolean("videos", v).apply()
    var folder: String
        get() = prefs.getString("folder", "Camera Uploads") ?: "Camera Uploads"
        set(v) = prefs.edit().putString("folder", v).apply()
    /** MediaStore DATE_ADDED (seconds) of the newest item already uploaded. */
    var lastAdded: Long
        get() = prefs.getLong("lastAdded", 0)
        set(v) = prefs.edit().putLong("lastAdded", v).apply()
    var lastRun: Long
        get() = prefs.getLong("lastRun", 0)
        set(v) = prefs.edit().putLong("lastRun", v).apply()
    var lastResult: String
        get() = prefs.getString("lastResult", "") ?: ""
        set(v) = prefs.edit().putString("lastResult", v).apply()
    /** "<folder id>|<media uri>|<size>|<upload id>" of an upload that was interrupted, to resume it on the next run. */
    var pending: String
        get() = prefs.getString("pending", "") ?: ""
        set(v) = prefs.edit().putString("pending", v).apply()
    /**
     * Photos and videos that could not be uploaded for a reason of their own (unreadable, refused by the server):
     * "i<id>" or "v<id>" (MediaStore image or video) → when it was last tried, in milliseconds. The backup goes on
     * without them and tries each again once a day.
     */
    var failed: Map<String, Long>
        get() = (prefs.getString("failed", "") ?: "").split(',').mapNotNull { e ->
            val at = e.substringAfter('=', "").toLongOrNull() ?: return@mapNotNull null
            e.substringBefore('=') to at
        }.toMap()
        set(v) = prefs.edit().putString("failed", v.entries.joinToString(",") { "${it.key}=${it.value}" }).apply()
}

object Jobs {
    // One after the other, in the order asked for: "apply the settings" always comes before "back up now".
    private val inOrder = Dispatchers.IO.limitedParallelism(1)

    /** Safe to call from the UI thread: reading the settings and WorkManager's database happens in the background. */
    fun schedule(context: Context) {
        val app = context.applicationContext
        Services.appScope.launch(inOrder) { scheduleNow(app) }
    }

    private fun network(settings: BackupSettings) = if (settings.wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED

    // The same network rule as the scheduled backup. It used to run on any connection, so "Back up now" and "Upload
    // all" used mobile data although "Only on Wi-Fi" was on.
    private fun nowRequest(settings: BackupSettings) = OneTimeWorkRequestBuilder<BackupWorker>()
        .setConstraints(Constraints.Builder().setRequiredNetworkType(network(settings)).build())
        .setInputData(Data.Builder().putBoolean(BackupWorker.ASKED_FOR, true).build()).build()

    private fun scheduleNow(context: Context) {
        val wm = WorkManager.getInstance(context)
        val settings = BackupSettings(context)
        if (settings.enabled) {
            val c = Constraints.Builder()
                .setRequiredNetworkType(network(settings))
                .setRequiresBatteryNotLow(true) // background uploads wait while the battery is low; "Back up now" doesn't
                .build()
            wm.enqueueUniquePeriodicWork("backup", ExistingPeriodicWorkPolicy.UPDATE,
                PeriodicWorkRequestBuilder<BackupWorker>(15, TimeUnit.MINUTES).setConstraints(c).build())
            // A "Back up now" that is still waiting for its network follows a change of "Only on Wi-Fi" too (one that
            // is already uploading goes on).
            val waiting = runCatching { wm.getWorkInfosForUniqueWork("backup-now").get() }.getOrNull().orEmpty()
            if (waiting.any { it.state == WorkInfo.State.ENQUEUED && it.constraints.requiredNetworkType != network(settings) })
                wm.enqueueUniqueWork("backup-now", ExistingWorkPolicy.REPLACE, nowRequest(settings))
        } else {
            wm.cancelUniqueWork("backup")
            wm.cancelUniqueWork("backup-now")
        }
        wm.enqueueUniquePeriodicWork("offline", ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<OfflineWorker>(1, TimeUnit.HOURS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.UNMETERED).build()).build())
    }

    /** Starts a backup run now, or as soon as the network the settings allow is there. Safe to call from the UI thread. */
    fun backupNow(context: Context) {
        val app = context.applicationContext
        Services.appScope.launch(inOrder) {
            val settings = BackupSettings(app)
            if (settings.enabled) WorkManager.getInstance(app).enqueueUniqueWork("backup-now", ExistingWorkPolicy.KEEP, nowRequest(settings))
        }
    }

    /** "Back up now" will not start yet: only Wi-Fi is allowed, and the phone is on mobile data (or has no network). */
    fun waitsForWifi(context: Context): Boolean = BackupSettings(context).wifiOnly &&
        runCatching { context.getSystemService(ConnectivityManager::class.java).isActiveNetworkMetered }.getOrDefault(false)

    fun mediaPermissions(): Array<String> =
        if (Build.VERSION.SDK_INT >= 33) arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO)
        else arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)

    fun hasMediaPermission(context: Context) =
        mediaPermissions().all { ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }
}

class OfflineWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        // Nothing pinned: no network and no disk work (this runs every hour).
        if (!Services.session.isLoggedIn) return Result.success()
        Services.offline.ready() // the job can be the first thing in a new process: the pinned list is still loading
        if (Services.offline.pinned.isEmpty()) return Result.success()
        return try {
            Services.offline.sync()
            Result.success()
        } catch (e: io.cloudy.app.data.ApiException) {
            if (e.status == 401) Result.success() else Result.retry() // signed out: nothing to retry
        } catch (e: java.io.IOException) {
            Result.retry()
        }
    }
}

/** Uploads photos/videos added to the device since the last run. */
class BackupWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    /** [key]: the item's name in [BackupSettings.failed]. */
    private data class Item(val uri: Uri, val key: String, val name: String, val size: Long, val added: Long)

    companion object {
        /** Input flag of a run the user asked for ("Back up now"): it also tries the items that failed before. */
        const val ASKED_FOR = "now"
        /** One run at a time in the whole app, see [doWork]. */
        private val running = Mutex()
        private const val RETRY_FAILED_MS = 24 * 60 * 60 * 1000L
        /** So many failures one after the other are hardly the photos' fault: the run stops and continues later. */
        private const val MAX_FAILED_IN_A_ROW = 20
    }

    override suspend fun doWork(): Result {
        // The scheduled run and "Back up now" can start at the same moment. Each used to work from its own list of
        // what is on the server, so every photo was uploaded twice. Now the second waits for the first and then
        // looks again (and usually finds nothing left to do).
        val waited = !running.tryLock()
        if (waited) running.lock()
        try {
            return backUp(waited)
        } finally {
            running.unlock()
        }
    }

    private suspend fun backUp(waited: Boolean): Result {
        val ctx = applicationContext
        val settings = BackupSettings(ctx)
        if (!settings.enabled || !Services.session.isLoggedIn) return Result.success()
        if (!Jobs.hasMediaPermission(ctx)) {
            // Access was taken away in the system settings: say so on the Photo backup screen.
            settings.lastResult = ctx.getString(R.string.backup_permission_needed)
            settings.lastRun = System.currentTimeMillis()
            return Result.success()
        }
        val api = Services.api
        var uploaded = 0
        var quiet = false
        try {
            val rootId = Services.session.user.value?.rootId ?: return Result.success()
            val root = api.node(rootId)
            val folder = root.children.orEmpty().firstOrNull { it.isDir && it.name == settings.folder }
                ?: api.mkdir(rootId, settings.folder)
            val existing = api.node(folder.id).children.orEmpty().associate { it.name to it.size }.toMutableMap()

            val kinds = listOfNotNull("i" to MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                if (settings.includeVideos) "v" to MediaStore.Video.Media.EXTERNAL_CONTENT_URI else null)
            // Items that failed earlier: tried again when a day has passed (or when the user taps "Back up now"),
            // left alone until then.
            val failed = settings.failed.toMutableMap()
            val now = System.currentTimeMillis()
            val askedFor = inputData.getBoolean(ASKED_FOR, false) && runAttemptCount == 0
            val due = failed.filterValues { at -> askedFor || now - at >= RETRY_FAILED_MS || at > now }.keys
            val since = settings.lastAdded
            var mark = since
            val items = LinkedHashMap<String, Item>()
            for ((kind, collection) in kinds) {
                val ids = due.filter { it.startsWith(kind) }.mapNotNull { it.drop(1).toLongOrNull() }
                val again = ids.chunked(500).flatMap { query(kind, collection, "${MediaStore.MediaColumns._ID} IN (${it.joinToString(",")})", null) }
                (ids.map { kind + it } - again.map { it.key }.toSet()).forEach { failed -= it } // deleted from the phone since
                // ">=": several photos can share the last run's second (bursts, screenshots); the name and size check
                // below skips the ones already uploaded.
                val new = query(kind, collection, "${MediaStore.MediaColumns.DATE_ADDED} >= ?", arrayOf(mark.toString()))
                (again + new).forEach { items[it.key] = it }
            }
            var failedNow = 0
            var failedInARow = 0
            var lastProblem = ""
            /** The next run starts after [item] (never earlier than before: retried items are older). */
            fun done(item: Item) {
                if (item.added > mark) { mark = item.added; settings.lastAdded = mark }
            }
            // New items first, oldest first, as always (an interrupted big upload is then first in line and continues
            // where it stopped); after them the older ones that get another try.
            for (item in items.values.sortedWith(compareBy<Item>({ it.added < since }, { it.added }))) {
                if (isStopped || !settings.enabled) break
                if (item.key in failed && item.key !in due) { done(item); continue } // failed less than a day ago
                var name = item.name
                val prev = existing[name]
                if (prev != null && prev != item.size) {
                    // Another file has that name (e.g. IMG_0001.jpg from an older phone): keep both.
                    val dot = name.lastIndexOf('.')
                    val suffix = "_" + ContentUris.parseId(item.uri)
                    name = if (dot > 0) name.substring(0, dot) + suffix + name.substring(dot) else name + suffix
                }
                if (existing[name] == item.size) {
                    if (failed.remove(item.key) != null) settings.failed = failed
                    done(item)
                    continue
                }
                // A big video can outlast the job's time limit: its upload session is kept and continued next time.
                val key = "${folder.id}|${item.uri}|${item.size}|"
                val resume = settings.pending.takeIf { it.startsWith(key) }?.removePrefix(key)
                try {
                    api.upload(folder.id, name, item.size, { ctx.contentResolver.openInputStream(item.uri) ?: throw java.io.IOException("Cannot read $name") },
                        resumeId = resume, onSession = { settings.pending = key + it }, keepOnFailure = true)
                    if (settings.pending.startsWith(key)) settings.pending = ""
                    existing[name] = item.size
                    if (failed.remove(item.key) != null) settings.failed = failed
                    uploaded++
                    failedInARow = 0
                } catch (e: Exception) {
                    // No connection, server down, stopped by the system: the run ends and comes back to this item.
                    if (e is kotlinx.coroutines.CancellationException || !ownProblem(e)) throw e
                    // This item's own problem. It used to end the run and was first again the next time, so one bad
                    // photo held up every photo after it for good. Now it is noted and the rest goes on.
                    if (settings.pending.startsWith(key)) settings.pending = ""
                    failed[item.key] = System.currentTimeMillis()
                    settings.failed = failed
                    lastProblem = "${item.name}: ${e.message ?: e.javaClass.simpleName}"
                    failedNow++
                    failedInARow++
                }
                done(item)
                if (failedInARow >= MAX_FAILED_IN_A_ROW) break
            }
            if (failed.size != settings.failed.size) settings.failed = failed
            // After waiting for another run there is usually nothing left: keep that run's result on the screen.
            quiet = waited && uploaded == 0 && failedNow == 0
            val unsent = failed.keys.count { k -> kinds.any { k.startsWith(it.first) } }
            if (!quiet) settings.lastResult = when {
                unsent == 0 -> ctx.getString(R.string.backup_result_uploaded, uploaded)
                lastProblem.isEmpty() -> ctx.getString(R.string.backup_result_some_failed, uploaded, unsent)
                else -> ctx.getString(R.string.backup_result_some_failed_why, uploaded, unsent, lastProblem)
            }
            return if (failedInARow >= MAX_FAILED_IN_A_ROW) Result.retry() else Result.success()
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e // stopped by the system (time limit, constraints): WorkManager runs it again
        } catch (e: Exception) {
            if (e is ApiException && e.status == 401) return Result.success() // signed out
            settings.lastResult = ctx.getString(R.string.backup_result_failed, e.message ?: "")
            return Result.retry()
        } finally {
            if (!quiet) settings.lastRun = System.currentTimeMillis()
        }
    }

    /**
     * Whether [e] is the photo's own problem (it cannot be read, the server refuses its name or size) and not the
     * connection's, the server's or the account's. Storage that is full (507) is the account's: counted as each
     * photo's own, a full account marked the whole backlog as failed, and after space was freed nothing was tried
     * again for a day. Anything unexpected (an answer that is not the server's, as a Wi-Fi sign-in page gives) ends
     * the run as well.
     */
    private fun ownProblem(e: Exception): Boolean = when (e) {
        is ApiException -> e.status in 400..499 && e.status !in setOf(401, 408, 429)
        is SourceException, is SecurityException, is java.io.FileNotFoundException -> true // this item cannot be read
        else -> false
    }

    private fun query(kind: String, collection: Uri, where: String, args: Array<String>?): List<Item> {
        val out = mutableListOf<Item>()
        val cols = arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DATE_ADDED)
        applicationContext.contentResolver.query(collection, cols, where, args, "${MediaStore.MediaColumns.DATE_ADDED} ASC")?.use { c ->
            while (c.moveToNext()) {
                val id = c.getLong(0)
                val name = c.getString(1) ?: "media_$id"
                val size = c.getLong(2)
                if (size <= 0) continue
                out += Item(ContentUris.withAppendedId(collection, id), kind + id, name, size, c.getLong(3))
            }
        }
        return out
    }
}
