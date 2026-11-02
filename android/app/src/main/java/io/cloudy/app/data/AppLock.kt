package io.cloudy.app.data

import android.content.Context
import android.os.SystemClock
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Optional app lock (More → App lock): fingerprint, face or the phone's screen lock, asked when the app
 * starts and when it comes back after [TIMEOUT_MS] in the background. Purely local; the token stays.
 */
object AppLock {
    private const val TIMEOUT_MS = 60_000L
    // Weak biometrics or the screen lock: the only combination every Android version from 8 supports.
    private const val AUTHENTICATORS = BIOMETRIC_WEAK or DEVICE_CREDENTIAL

    private val _locked = MutableStateFlow(false)
    val locked: StateFlow<Boolean> = _locked
    /** elapsedRealtime when the app went to the background; 0 = it hasn't since the process started. */
    private var backgroundSince = 0L
    private var prompting = false

    private fun prefs(context: Context) = context.getSharedPreferences("applock", Context.MODE_PRIVATE)

    fun isEnabled(context: Context) = prefs(context).getBoolean("enabled", false)
    fun setEnabled(context: Context, on: Boolean) = prefs(context).edit().putBoolean("enabled", on).apply()

    /** The phone has a screen lock or biometrics set up (otherwise the lock can't be turned on). */
    fun isAvailable(context: Context) =
        BiometricManager.from(context).canAuthenticate(AUTHENTICATORS) == BiometricManager.BIOMETRIC_SUCCESS

    /** Activity started: lock on a cold start or after a long enough break (not after rotation). */
    fun onStart(context: Context) {
        if (!isEnabled(context)) { _locked.value = false; return }
        if (prompting) return // the system's own lock screen (screen-lock PIN) stopped us for a moment
        if (backgroundSince == 0L || SystemClock.elapsedRealtime() - backgroundSince > TIMEOUT_MS) _locked.value = true
    }

    fun onStop() {
        backgroundSince = SystemClock.elapsedRealtime()
        // A prompt that disappears without a callback (activity recreated under it) must not block the next one.
        prompting = false
    }

    /** Asks for the fingerprint / face / screen lock and unlocks on success. */
    fun unlock(activity: FragmentActivity, title: String, subtitle: String) {
        if (prompting) return
        prompting = true
        val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) { prompting = false; _locked.value = false }
            override fun onAuthenticationError(code: Int, msg: CharSequence) { prompting = false }
        })
        prompt.authenticate(BiometricPrompt.PromptInfo.Builder().setTitle(title).setSubtitle(subtitle).setAllowedAuthenticators(AUTHENTICATORS).build())
    }

    /** Confirms with the lock before turning it on, so nobody locks themselves out by accident. */
    fun confirm(activity: FragmentActivity, title: String, onSuccess: () -> Unit) {
        BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = onSuccess()
        }).authenticate(BiometricPrompt.PromptInfo.Builder().setTitle(title).setAllowedAuthenticators(AUTHENTICATORS).build())
    }
}
