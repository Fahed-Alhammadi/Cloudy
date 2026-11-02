package io.cloudy.app.data

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** Persists the server address, device token and signed-in user in app-private storage. */
class Session(context: Context) {
    private val prefs = context.getSharedPreferences("session", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    var server: String = prefs.getString("server", "") ?: ""
        private set
    var token: String? = prefs.getString("token", null)
        private set

    private val _user = MutableStateFlow(prefs.getString("user", null)?.let { runCatching { json.decodeFromString<User>(it) }.getOrNull() })
    val user: StateFlow<User?> = _user

    val isLoggedIn get() = token != null && _user.value != null

    fun signIn(server: String, token: String, user: User) {
        this.server = server
        this.token = token
        prefs.edit().putString("server", server).putString("token", token).putString("user", json.encodeToString(user)).apply()
        _user.value = user
    }

    fun updateUser(user: User) {
        prefs.edit().putString("user", json.encodeToString(user)).apply()
        _user.value = user
    }

    fun signOut() {
        ListCache.clear()
        token = null
        prefs.edit().remove("token").remove("user").apply()
        _user.value = null
    }

    /** Last server address, pre-filled on the login screen. */
    val lastServer: String get() = prefs.getString("server", "") ?: ""

    /** Whether the first-launch screen (permissions) was shown. Existing signed-in installs never need it. */
    var welcomed: Boolean
        get() = prefs.getBoolean("welcomed", false) || isLoggedIn
        set(v) { prefs.edit().putBoolean("welcomed", v).apply() }
}
