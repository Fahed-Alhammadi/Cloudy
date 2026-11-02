package io.cloudy.app

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.core.content.IntentCompat
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
        enableEdgeToEdge()
        Services.api.onUnauthorized = { runOnUiThread { Services.session.signOut() } }
        handleShare(intent)
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
