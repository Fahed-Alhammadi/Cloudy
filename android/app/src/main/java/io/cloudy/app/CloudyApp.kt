package io.cloudy.app

import android.app.Application
import android.content.Context
import android.os.StrictMode
import kotlinx.coroutines.launch
import coil.ImageLoader
import coil.ImageLoaderFactory
import io.cloudy.app.data.Api
import io.cloudy.app.data.Lang
import io.cloudy.app.data.Offline
import io.cloudy.app.data.Session
import io.cloudy.app.work.Jobs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/** Process-wide singletons. */
object Services {
    lateinit var session: Session
    lateinit var api: Api
    lateinit var offline: Offline
    /** For work that must outlive a screen (e.g. saving the language while the activity restarts). */
    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
}

class CloudyApp : Application(), ImageLoaderFactory {
    // Below Android 13 the in-app language is applied by wrapping contexts (workers' texts use this one).
    override fun attachBaseContext(base: Context) = super.attachBaseContext(Lang.wrap(base))

    override fun onCreate() {
        super.onCreate()
        // Debug builds log any disk or network access on the UI thread (the cause of ANRs in Play's Android vitals).
        if (BuildConfig.DEBUG) StrictMode.setThreadPolicy(StrictMode.ThreadPolicy.Builder().detectDiskReads().detectDiskWrites().detectNetwork().penaltyLog().build())
        Services.session = Session(this)
        Services.api = Api(Services.session)
        Services.offline = Offline(this, Services.api)
        // A rejected token (revoked under Devices on the web, account deleted) signs out, also when only a background
        // job (photo backup, offline sync) is running; set here so it never holds on to an old activity.
        val main = android.os.Handler(mainLooper)
        Services.api.onUnauthorized = { main.post { if (Services.session.token != null) Services.session.signOut() } }
        if (Services.session.isLoggedIn) Jobs.schedule(this) // runs in the background
        // Load the small settings files now, off the UI thread, so screens never wait for the disk on first use.
        Services.appScope.launch(Dispatchers.IO) { listOf("view", "lang", "backup", "applock").forEach { getSharedPreferences(it, MODE_PRIVATE).all } }
    }

    // Coil uses our authenticated HTTP client so image previews work.
    override fun newImageLoader(): ImageLoader =
        ImageLoader.Builder(this).okHttpClient { Services.api.http }.crossfade(true).build()
}
