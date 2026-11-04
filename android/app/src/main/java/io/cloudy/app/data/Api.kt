package io.cloudy.app.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.add
import kotlinx.serialization.encodeToString
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/** [twoFactor] is true when the server asks for (or rejected) a two-factor code. */
class ApiException(val status: Int, message: String, val twoFactor: Boolean = false) : Exception(message)

/** Client for the Cloudy JSON API. All calls run on the IO dispatcher. */
class Api(private val session: Session) {
    private companion object {
        const val CHUNK_FALLBACK = 8L * 1024 * 1024
        /** 409s of `PUT /api/uploads/:id` that mean "check the position and go on" (server/src/api/files.ts). */
        val RETRY_409 = setOf("Offset mismatch", "Chunk already in progress")
    }
    val json = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true }
    var onUnauthorized: () -> Unit = {}

    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.MINUTES)
        .writeTimeout(5, TimeUnit.MINUTES)
        .addInterceptor { chain ->
            val b = chain.request().newBuilder().header("X-Cloudy-Request", "1")
            val token = session.token
            if (token != null && chain.request().header("Authorization") == null) b.header("Authorization", "Bearer $token")
            chain.proceed(b.build())
        }
        .build()

    private val jsonType = "application/json".toMediaType()
    private val binType = "application/octet-stream".toMediaType()

    fun url(path: String, server: String = session.server) = server.trimEnd('/') + path

    // Chunks are never resent by OkHttp itself: after a lost answer, putChunk first asks the server how far it got.
    private val uploadHttp: OkHttpClient by lazy { http.newBuilder().retryOnConnectionFailure(false).build() }

    private suspend fun send(method: String, path: String, body: RequestBody? = null, headers: Map<String, String> = emptyMap(), server: String = session.server, client: OkHttpClient = http): String =
        withContext(Dispatchers.IO) {
            val req = Request.Builder().url(url(path, server)).method(method, body ?: if (method in listOf("POST", "PUT", "PATCH")) ByteArray(0).toRequestBody(null) else null)
            headers.forEach { (k, v) -> req.header(k, v) }
            val sentToken = session.token
            client.newCall(req.build()).execute().use { res ->
                val text = res.body?.string() ?: ""
                if (!res.isSuccessful) {
                    // Only when the rejected token is still the current one: a late answer to a request sent before
                    // logging out and in again must not sign the new session out.
                    if (res.code == 401 && !path.startsWith("/api/auth/") && sentToken != null && sentToken == session.token) onUnauthorized()
                    val body = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull()
                    val msg = body?.get("error")?.jsonPrimitive?.content
                    val twoFactor = body?.get("twoFactor")?.jsonPrimitive?.content == "true"
                    throw ApiException(res.code, msg ?: "HTTP ${res.code}", twoFactor)
                }
                text
            }
        }

    private suspend fun sendJson(method: String, path: String, body: JsonObject? = null): String =
        send(method, path, (body ?: JsonObject(emptyMap())).toString().toRequestBody(jsonType))

    private inline fun <reified T> decode(text: String): T = json.decodeFromString(text)
    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8").replace("+", "%20")

    // ---------------------------------------------------------------- auth
    suspend fun checkServer(server: String) { send("GET", "/status", server = server) }

    suspend fun login(server: String, user: String, password: String, device: String, code: String? = null): TokenResponse {
        val body = buildJsonObject {
            put("user", user); put("password", password); put("deviceName", device)
            if (!code.isNullOrBlank()) put("code", code.trim())
        }
        return decode(send("POST", "/api/auth/token", body.toString().toRequestBody(jsonType), server = server))
    }

    /** Revokes [token] (already removed from the session, so signing out never waits for the network). */
    suspend fun revoke(server: String, token: String) {
        runCatching { send("POST", "/api/auth/revoke", headers = mapOf("Authorization" to "Bearer $token"), server = server) }
    }
    suspend fun me(): User = decode(send("GET", "/api/me"))
    /** Saves the account's language (null = automatic), so the web app and emails follow it. */
    suspend fun setLanguage(code: String?) { sendJson("PATCH", "/api/me", buildJsonObject { put("language", code) }) }
    suspend fun appPasswords(): List<AppPassword> = decode(send("GET", "/api/me/app-passwords"))
    suspend fun revokeAppPassword(id: Long) { send("DELETE", "/api/me/app-passwords/$id") }
    /** Deletes the account and all its data on the server for good (needs the account password). */
    suspend fun deleteAccount(password: String) { sendJson("POST", "/api/me/delete", buildJsonObject { put("password", password) }) }

    // ---------------------------------------------------------------- files
    suspend fun node(id: Long): NodeListing = decode(send("GET", "/api/nodes/$id"))
    suspend fun mkdir(parentId: Long, name: String): FileNode = decode(sendJson("POST", "/api/nodes/$parentId/folders", buildJsonObject { put("name", name) }))
    suspend fun rename(id: Long, name: String): FileNode = decode(sendJson("PATCH", "/api/nodes/$id", buildJsonObject { put("name", name) }))
    suspend fun move(id: Long, parentId: Long): FileNode = decode(sendJson("PATCH", "/api/nodes/$id", buildJsonObject { put("parentId", parentId) }))
    suspend fun copy(id: Long, parentId: Long): FileNode = decode(sendJson("POST", "/api/nodes/$id/copy", buildJsonObject { put("parentId", parentId) }))
    suspend fun delete(id: Long) { send("DELETE", "/api/nodes/$id") }
    suspend fun setFavorite(id: Long, fav: Boolean) { send(if (fav) "POST" else "DELETE", "/api/nodes/$id/favorite") }
    suspend fun recent(): List<FileNode> = decode(send("GET", "/api/recent"))
    suspend fun favorites(): List<FileNode> = decode(send("GET", "/api/favorites"))
    suspend fun search(q: String): List<FileNode> = decode(send("GET", "/api/search?q=${enc(q)}"))
    suspend fun sharedWithMe(): List<FileNode> = decode(send("GET", "/api/shares/incoming"))
    suspend fun sharedByMe(): List<Share> = decode(send("GET", "/api/shares/outgoing"))
    suspend fun versions(id: Long): List<Version> = decode(send("GET", "/api/nodes/$id/versions"))
    suspend fun restoreVersion(id: Long, vid: Long) { send("POST", "/api/nodes/$id/versions/$vid/restore") }

    suspend fun trash(): List<TrashItem> = decode(send("GET", "/api/trash"))
    suspend fun restore(id: Long) { send("POST", "/api/trash/$id/restore") }
    suspend fun purge(id: Long) { send("DELETE", "/api/trash/$id") }
    suspend fun emptyTrash() { send("DELETE", "/api/trash") }

    // ---------------------------------------------------------------- shares
    suspend fun shares(nodeId: Long): List<Share> = decode(send("GET", "/api/nodes/$nodeId/shares"))
    /** [expiresAt]: last day the link works (YYYY-MM-DD); [canEdit]: visitors may upload (folders only). */
    suspend fun createLink(nodeId: Long, password: String?, expiresAt: String? = null, canEdit: Boolean = false): Share =
        decode(sendJson("POST", "/api/nodes/$nodeId/shares", buildJsonObject {
            put("type", "link")
            if (!password.isNullOrBlank()) put("password", password)
            if (expiresAt != null) put("expiresAt", "${expiresAt}T23:59:59")
            if (canEdit) put("canEdit", true)
        }))
    suspend fun shareWith(nodeId: Long, target: String, canEdit: Boolean): Share {
        val group = target.startsWith("group:")
        return decode(sendJson("POST", "/api/nodes/$nodeId/shares", buildJsonObject {
            put("type", if (group) "group" else "user")
            put("shareWith", target.removePrefix("group:"))
            put("canEdit", canEdit)
        }))
    }
    suspend fun deleteShare(id: Long) { send("DELETE", "/api/shares/$id") }
    suspend fun sharees(q: String): Sharees = decode(send("GET", "/api/sharees?q=${enc(q)}"))

    // ---------------------------------------------------------------- transfer
    fun downloadUrl(id: Long, inline: Boolean = false) = url("/api/nodes/$id/download" + if (inline) "?inline" else "")

    /** Streams a file (or a folder as ZIP) to [dest]. */
    suspend fun download(id: Long, dest: File, onProgress: (Long) -> Unit = {}) = downloadUrlTo(downloadUrl(id), dest, onProgress = onProgress)

    /** Text files: create and save (the server keeps the previous content as a version). */
    suspend fun createTextFile(parentId: Long, name: String): FileNode =
        decode(sendJson("POST", "/api/nodes/$parentId/files", buildJsonObject { put("name", name); put("content", "") }))
    suspend fun saveText(id: Long, text: String): FileNode =
        decode(send("PUT", "/api/nodes/$id/content", text.toRequestBody("text/plain; charset=utf-8".toMediaType())))

    /** Downloads a Cloudy server URL (sends our credentials, so never use it for other hosts). */
    suspend fun downloadUrlTo(absoluteUrl: String, dest: File, onProgress: (Long) -> Unit = {}) = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(absoluteUrl).build()
        http.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw ApiException(res.code, "Download failed (HTTP ${res.code})")
            dest.parentFile?.mkdirs()
            val tmp = File(dest.path + ".part")
            res.body!!.byteStream().use { input ->
                tmp.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    var total = 0L
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        total += n
                        onProgress(total)
                    }
                }
            }
            if (!tmp.renameTo(dest)) throw IOException("Could not save file")
        }
    }

    // ---- office previews (LibreOffice → PDF on the server)
    suspend fun office(): OfficeInfo = decode(send("GET", "/api/office"))
    fun previewUrl(id: Long) = url("/api/nodes/$id/preview")

    // ---- live updates (Server-Sent Events); blocks until the stream ends
    suspend fun streamEvents(onOpen: () -> Unit = {}, onEvent: (ChangeEvent) -> Unit) = withContext(Dispatchers.IO) {
        val client = http.newBuilder().readTimeout(70, TimeUnit.SECONDS).build() // server pings every 25 s
        val call = client.newCall(Request.Builder().url(url("/api/events")).header("Accept", "text/event-stream").build())
        val cancel = coroutineContext[Job]?.invokeOnCompletion { call.cancel() } // reads block: cancel closes the socket
        try {
            call.execute().use { res ->
                if (!res.isSuccessful) throw ApiException(res.code, "HTTP ${res.code}")
                onOpen()
                val src = res.body!!.source()
                var event = ""
                val data = StringBuilder()
                while (true) {
                    val line = src.readUtf8Line() ?: break
                    when {
                        line.isEmpty() -> {
                            if (event == "change" && data.isNotEmpty()) runCatching { onEvent(json.decodeFromString<ChangeEvent>(data.toString())) }
                            event = ""
                            data.clear()
                        }
                        line.startsWith("event:") -> event = line.substring(6).trim()
                        line.startsWith("data:") -> data.append(line.substring(5).trim())
                    }
                }
            }
        } finally {
            cancel?.dispose()
        }
    }

    suspend fun downloadText(id: Long): String = send("GET", "/api/nodes/$id/download?inline")

    /**
     * Resumable chunked upload; returns the new node id (0 when the last chunk landed but its answer was lost).
     * [resumeId]: an upload session from an earlier, interrupted attempt ([onSession] reports each new one), so a
     * big file that outlasts a background job continues where it stopped instead of starting over.
     * When the upload fails or is cancelled, the server's partial upload is deleted, unless [keepOnFailure] (the
     * photo backup keeps it to resume on its next run; the server drops sessions a day after their last chunk).
     */
    suspend fun upload(
        parentId: Long, name: String, size: Long, open: () -> InputStream, onProgress: (Long) -> Unit = {},
        resumeId: String? = null, onSession: (String) -> Unit = {}, keepOnFailure: Boolean = false,
    ): Long {
        val resumed = resumeId?.let { id -> runCatching { decode<UploadStatus>(send("GET", "/api/uploads/$id")) }.getOrNull()?.takeIf { it.size == size }?.let { id to it.received } }
        val sessionId: String
        val chunkSize: Long
        var offset: Long
        if (resumed != null) {
            sessionId = resumed.first; offset = resumed.second; chunkSize = CHUNK_FALLBACK
        } else {
            val s: UploadSession = decode(sendJson("POST", "/api/uploads", buildJsonObject {
                put("parentId", parentId); put("name", name); put("size", size)
            }))
            sessionId = s.id; offset = 0; chunkSize = s.chunkSize
            onSession(s.id)
        }
        try {
            return uploadChunks(sessionId, chunkSize, offset, size, open, onProgress)
        } catch (e: Throwable) {
            if (!keepOnFailure) withContext(kotlinx.coroutines.NonCancellable) { runCatching { send("DELETE", "/api/uploads/$sessionId") } }
            throw e
        }
    }

    private suspend fun uploadChunks(sessionId: String, chunkSize: Long, start: Long, size: Long, open: () -> InputStream, onProgress: (Long) -> Unit): Long {
        var offset = start
        return withContext(Dispatchers.IO) {
            open().use { input ->
                var skip = offset
                while (skip > 0) {
                    val k = input.skip(skip)
                    if (k <= 0) { if (input.read() < 0) throw IOException("File ended before the declared size") else skip-- } else skip -= k
                }
                val buf = ByteArray(chunkSize.toInt())
                while (true) {
                    var n = 0
                    while (n < buf.size) {
                        val r = input.read(buf, n, buf.size - n)
                        if (r < 0) break
                        n += r
                    }
                    val result = putChunk(sessionId, buf, n, offset, size)
                    offset = result.received
                    onProgress(offset)
                    if (result.done) return@withContext result.node?.id ?: 0L
                    if (n == 0) throw IOException("File ended before the declared size")
                }
                @Suppress("UNREACHABLE_CODE")
                error("unreachable")
            }
        }
    }

    /**
     * Sends one chunk, retrying transient failures. When an answer is lost the chunk may still have landed, so the
     * session's real position (`GET /api/uploads/:id`) decides whether to send it again or move on. Only network
     * errors, 502/503/504 and the two "try again" 409s are retried; any other 409 (e.g. "Target folder no longer
     * exists" after the last chunk) is a real failure.
     */
    private suspend fun putChunk(id: String, buf: ByteArray, n: Int, offset: Long, size: Long): ChunkResult {
        var attempt = 0
        var saw409 = false
        while (true) {
            try {
                return decode(send("PUT", "/api/uploads/$id", buf.toRequestBody(binType, 0, n), mapOf("Upload-Offset" to offset.toString()), client = uploadHttp))
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                val transient = e is IOException || (e is ApiException && e.status in setOf(502, 503, 504))
                val retry409 = e is ApiException && e.status == 409 && e.message in RETRY_409
                if (retry409) saw409 = true
                if (!(transient || retry409) || ++attempt > 5) throw e
                var status: UploadStatus? = null
                while (status == null) {
                    delay(1000L shl attempt.coerceAtMost(5))
                    try {
                        status = decode<UploadStatus>(send("GET", "/api/uploads/$id"))
                    } catch (g: ApiException) {
                        // Gone after the last chunk: it was stored, and its answer lost. Not after a 409, though: the
                        // server also drops the session when it refuses the finished file.
                        if (g.status == 404 && !saw409 && offset + n == size) return ChunkResult(size, true, null)
                        throw e
                    } catch (g: IOException) {
                        if (++attempt > 8) throw e // network still down: ask again (resending could not tell the difference)
                    }
                }
                when (status.received) {
                    offset -> continue // not received: send it again
                    offset + n -> return ChunkResult(status.received, status.received >= size, null)
                    else -> throw e
                }
            }
        }
    }

    // ---------------------------------------------------------------- calendar & contacts
    suspend fun calendars(): List<DavCollection> = decode(send("GET", "/api/calendars"))
    suspend fun createCalendar(name: String): DavCollection = decode(sendJson("POST", "/api/calendars", buildJsonObject { put("name", name) }))
    suspend fun events(calendarId: Long, startIso: String, endIso: String): List<CalEvent> =
        decode(send("GET", "/api/calendars/$calendarId/events?start=${enc(startIso)}&end=${enc(endIso)}"))
    suspend fun createEvent(calendarId: Long, e: EventInput) { send("POST", "/api/calendars/$calendarId/events", json.encodeToString(e).toRequestBody(jsonType)) }
    suspend fun updateEvent(calendarId: Long, uri: String, e: EventInput) { send("PUT", "/api/calendars/$calendarId/events/${enc(uri)}", json.encodeToString(e).toRequestBody(jsonType)) }
    suspend fun deleteEvent(calendarId: Long, uri: String) { send("DELETE", "/api/calendars/$calendarId/events/${enc(uri)}") }

    suspend fun addressBooks(): List<DavCollection> = decode(send("GET", "/api/addressbooks"))
    suspend fun contacts(bookId: Long): List<Contact> = decode(send("GET", "/api/addressbooks/$bookId/contacts"))
    private fun contactBody(c: Contact) = buildJsonObject {
        put("givenName", c.givenName); put("familyName", c.familyName); put("org", c.org); put("title", c.title)
        put("address", c.address); put("birthday", c.birthday); put("note", c.note)
        putJsonArray("emails") { c.emails.forEach { add(it) } }
        putJsonArray("phones") { c.phones.forEach { add(it) } }
    }
    suspend fun saveContact(bookId: Long, c: Contact): Contact =
        if (c.uri.isEmpty()) decode(sendJson("POST", "/api/addressbooks/$bookId/contacts", contactBody(c)))
        else decode(sendJson("PUT", "/api/addressbooks/$bookId/contacts/${enc(c.uri)}", contactBody(c)))
    /** Imports a .vcf or .csv file (raw bytes) into an address book. */
    suspend fun importContacts(bookId: Long, bytes: ByteArray): ImportResult =
        decode(send("POST", "/api/addressbooks/$bookId/import", bytes.toRequestBody(binType)))
    suspend fun exportContacts(bookId: Long): String = send("GET", "/api/addressbooks/$bookId/export")
    suspend fun deleteContact(bookId: Long, uri: String) { send("DELETE", "/api/addressbooks/$bookId/contacts/${enc(uri)}") }
}
