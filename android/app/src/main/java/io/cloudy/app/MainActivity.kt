package io.cloudy.app

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.core.content.IntentCompat
import androidx.core.os.BundleCompat
import androidx.core.view.WindowCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.cloudy.app.data.AppLock
import io.cloudy.app.data.Lang
import io.cloudy.app.ui.CloudyTheme
import io.cloudy.app.ui.LockScreen
import io.cloudy.app.ui.LoginScreen
import io.cloudy.app.ui.MainScreen
import io.cloudy.app.ui.WelcomeScreen

// FragmentActivity (a ComponentActivity) because the app lock's BiometricPrompt needs one.
class MainActivity : FragmentActivity() {
    /** Files handed to us via "Share to Cloudy"; the Files screen offers to upload them. */
    val sharedUris = mutableStateOf<List<Uri>>(emptyList())

    override fun attachBaseContext(base: Context) = super.attachBaseContext(Lang.wrap(base))

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Edge-to-edge: bar colors/icons come from the theme (themes.xml says why not enableEdgeToEdge()).
        WindowCompat.setDecorFitsSystemWindows(window, false)
        // A share is handled once: after rotation the pending files come from the saved state (the intent would
        // offer the same files again after they were uploaded), and reopening from Recents doesn't repeat it.
        if (savedInstanceState != null) {
            sharedUris.value = BundleCompat.getParcelableArrayList(savedInstanceState, "shared", Uri::class.java).orEmpty()
        } else if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY == 0) handleShare(intent)
        setContent {
            CloudyTheme {
                val user by Services.session.user.collectAsStateWithLifecycle()
                val locked by AppLock.locked.collectAsStateWithLifecycle()
                var welcomed by remember { mutableStateOf(Services.session.welcomed) }
                when {
                    user == null || Services.session.token == null -> if (welcomed) LoginScreen() else WelcomeScreen { welcomed = true }
                    locked -> LockScreen()
                    else -> MainScreen(sharedUris)
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        if (Services.session.isLoggedIn) AppLock.onStart(this)
        // With the app lock on, the task switcher shows no preview of the content (and screenshots are off below 13).
        val lockOn = AppLock.isEnabled(this)
        if (Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(!lockOn)
        else if (lockOn) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE) else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putParcelableArrayList("shared", ArrayList(sharedUris.value))
    }

    override fun onStop() {
        super.onStop()
        AppLock.onStop()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleShare(intent)
    }

    private fun handleShare(intent: Intent?) {
        // Only content:// URIs from other apps: a file:// URI could point at our own private files (the session token).
        val ok = { u: Uri -> u.scheme == ContentResolver.SCHEME_CONTENT && u.authority != "$packageName.files" }
        when (intent?.action) {
            Intent.ACTION_SEND -> IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.takeIf(ok)?.let { sharedUris.value = listOf(it) }
            Intent.ACTION_SEND_MULTIPLE -> IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.filter(ok)?.takeIf { it.isNotEmpty() }?.let { sharedUris.value = it }
        }
    }
}
