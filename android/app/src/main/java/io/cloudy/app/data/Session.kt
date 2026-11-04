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
    // Read by OkHttp's threads on every request.
    @Volatile var token: String? = prefs.getString("token", null)
        private set

    private val _user = MutableStateFlow(prefs.getString("user", null)?.let { runCatching { json.decodeFromString<User>(it) }.getOrNull() })
    val user: StateFlow<User?> = _user

    val isLoggedIn get() = token != null && _user.value != null

    private fun accountKey(server: String, userId: String) = "${normalize(server)}|$userId"

    /** The same server however it was typed: scheme and host in lower case, no default port, no trailing slash. */
    private fun normalize(server: String): String = runCatching {
        val u = java.net.URI(server.trim())
        val scheme = u.scheme.lowercase()
        val port = u.port.takeIf { it != -1 && !(scheme == "https" && it == 443) && !(scheme == "http" && it == 80) }
        "$scheme://${u.host.lowercase()}${port?.let { ":$it" } ?: ""}${(u.rawPath ?: "").trimEnd('/')}"
    }.getOrDefault(server.trim().trimEnd('/').lowercase())

    /**
     * True when a different account (or server) than the last one signed in on this phone: what that account kept
     * here (offline copies, photo backup) must not carry over to the new one.
     */
    fun isOtherAccount(server: String, userId: String): Boolean =
        prefs.getString("account", null)?.let { stored ->
            accountKey(stored.substringBeforeLast('|'), stored.substringAfterLast('|')) != accountKey(server, userId)
        } ?: false

    /** True when a different user than the last one signed in on this phone (on any server address). */
    fun isOtherUser(userId: String): Boolean =
        prefs.getString("account", null).let { it != null && it.substringAfterLast('|') != userId }

    fun signIn(server: String, token: String, user: User) {
        this.server = server
        this.token = token
        prefs.edit().putString("server", server).putString("token", token).putString("user", json.encodeToString(user))
            .putString("account", accountKey(server, user.id)).apply()
        _user.value = user
    }

    fun updateUser(user: User) {
        prefs.edit().putString("user", json.encodeToString(user)).apply()
        _user.value = user
    }

    /** Forgets the token on this phone; returns it so the caller can revoke it on the server in the background. */
    fun signOut(): String? {
        val old = token
        ListCache.clear()
        token = null
        prefs.edit().remove("token").remove("user").apply()
        _user.value = null
        return old
    }

    /** Last server address, pre-filled on the login screen. */
    val lastServer: String get() = prefs.getString("server", "") ?: ""

    /** Whether the first-launch screen (permissions) was shown. Existing signed-in installs never need it. */
    var welcomed: Boolean
        get() = prefs.getBoolean("welcomed", false) || isLoggedIn
        set(v) { prefs.edit().putBoolean("welcomed", v).apply() }
}
