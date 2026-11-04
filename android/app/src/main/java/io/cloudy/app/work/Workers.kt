package io.cloudy.app.work

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import io.cloudy.app.R
import io.cloudy.app.Services
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
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
}

object Jobs {
    /** Safe to call from the UI thread: reading the settings and WorkManager's database happens in the background. */
    fun schedule(context: Context) {
        val app = context.applicationContext
        Services.appScope.launch(Dispatchers.IO) { scheduleNow(app) }
    }

    private fun scheduleNow(context: Context) {
        val wm = WorkManager.getInstance(context)
        val settings = BackupSettings(context)
        if (settings.enabled) {
            val c = Constraints.Builder()
                .setRequiredNetworkType(if (settings.wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
                .setRequiresBatteryNotLow(true) // background uploads wait while the battery is low; "Back up now" doesn't
                .build()
            wm.enqueueUniquePeriodicWork("backup", ExistingPeriodicWorkPolicy.UPDATE,
                PeriodicWorkRequestBuilder<BackupWorker>(15, TimeUnit.MINUTES).setConstraints(c).build())
        } else {
            wm.cancelUniqueWork("backup")
            wm.cancelUniqueWork("backup-now")
        }
        wm.enqueueUniquePeriodicWork("offline", ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<OfflineWorker>(1, TimeUnit.HOURS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.UNMETERED).build()).build())
    }

    fun backupNow(context: Context) {
        WorkManager.getInstance(context).enqueueUniqueWork("backup-now", ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<BackupWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build())
    }

    fun mediaPermissions(): Array<String> =
        if (Build.VERSION.SDK_INT >= 33) arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO)
        else arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)

    fun hasMediaPermission(context: Context) =
        mediaPermissions().all { ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }
}

class OfflineWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        // Nothing pinned: no network and no disk work (this runs every hour).
        if (!Services.session.isLoggedIn || Services.offline.pinned.isEmpty()) return Result.success()
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
    private data class Item(val uri: Uri, val name: String, val size: Long, val added: Long)

    override suspend fun doWork(): Result {
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
        try {
            val rootId = Services.session.user.value?.rootId ?: return Result.success()
            val root = api.node(rootId)
            val folder = root.children.orEmpty().firstOrNull { it.isDir && it.name == settings.folder }
                ?: api.mkdir(rootId, settings.folder)
            val existing = api.node(folder.id).children.orEmpty().associate { it.name to it.size }.toMutableMap()

            // ">=": several photos can share the last run's second (bursts, screenshots); the name and size check
            // below skips the ones already uploaded.
            val items = query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, settings.lastAdded) +
                (if (settings.includeVideos) query(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, settings.lastAdded) else emptyList())
            for (item in items.sortedBy { it.added }) {
                if (isStopped || !settings.enabled) break
                var name = item.name
                val prev = existing[name]
                if (prev != null && prev != item.size) {
                    // Another file has that name (e.g. IMG_0001.jpg from an older phone): keep both.
                    val dot = name.lastIndexOf('.')
                    val suffix = "_" + ContentUris.parseId(item.uri)
                    name = if (dot > 0) name.substring(0, dot) + suffix + name.substring(dot) else name + suffix
                }
                if (existing[name] == item.size) {
                    settings.lastAdded = item.added
                    continue
                }
                // A big video can outlast the job's time limit: its upload session is kept and continued next time.
                val key = "${folder.id}|${item.uri}|${item.size}|"
                val resume = settings.pending.takeIf { it.startsWith(key) }?.removePrefix(key)
                api.upload(folder.id, name, item.size, { ctx.contentResolver.openInputStream(item.uri) ?: throw java.io.IOException("Cannot read $name") },
                    resumeId = resume, onSession = { settings.pending = key + it }, keepOnFailure = true)
                settings.pending = ""
                existing[name] = item.size
                settings.lastAdded = item.added
                uploaded++
            }
            settings.lastResult = ctx.getString(R.string.backup_result_uploaded, uploaded)
            return Result.success()
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e // stopped by the system (time limit, constraints): WorkManager runs it again
        } catch (e: Exception) {
            if (e is io.cloudy.app.data.ApiException && e.status == 401) return Result.success() // signed out
            settings.lastResult = ctx.getString(R.string.backup_result_failed, e.message ?: "")
            return Result.retry()
        } finally {
            settings.lastRun = System.currentTimeMillis()
        }
    }

    private fun query(collection: Uri, since: Long): List<Item> {
        val out = mutableListOf<Item>()
        val cols = arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DATE_ADDED)
        applicationContext.contentResolver.query(collection, cols, "${MediaStore.MediaColumns.DATE_ADDED} >= ?", arrayOf(since.toString()),
            "${MediaStore.MediaColumns.DATE_ADDED} ASC")?.use { c ->
            while (c.moveToNext()) {
                val id = c.getLong(0)
                val name = c.getString(1) ?: "media_$id"
                val size = c.getLong(2)
                if (size <= 0) continue
                out += Item(ContentUris.withAppendedId(collection, id), name, size, c.getLong(3))
            }
        }
        return out
    }
}
