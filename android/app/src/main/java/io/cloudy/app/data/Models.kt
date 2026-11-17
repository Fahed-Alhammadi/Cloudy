package io.cloudy.app.data

import kotlinx.serialization.Serializable

@Serializable
data class User(
    val id: String,
    val displayName: String = "",
    val email: String = "",
    val isAdmin: Boolean = false,
    val quotaBytes: Long? = null,
    val used: Long = 0,
    val rootId: Long = 0,
    /** Preferred language code (en, ar, de, fr, es); null = follow the phone. Shared with the web app. */
    val language: String? = null,
    /** Days deleted files stay in the trash (`/api/me` only). */
    val trashDays: Int? = null,
    /** The server makes small previews of pictures and PDFs (`/api/nodes/{id}/thumb`, server 1.19+, `/api/me` only). */
    val thumbnails: Boolean = false,
)

/** An app password / device token (Settings → App passwords on the web, More → Devices here). */
@Serializable
data class AppPassword(
    val id: Long,
    val name: String,
    val createdAt: String = "",
    val lastUsedAt: String? = null,
    /** The token this phone is signed in with. */
    val current: Boolean = false,
)

@Serializable
data class TokenResponse(val token: String, val user: User)

@Serializable
data class FileNode(
    val id: Long,
    val name: String,
    val isDir: Boolean,
    val size: Long = 0,
    val mime: String = "",
    val etag: String = "",
    val mtime: String = "",
    val owner: String = "",
    val parentId: Long? = null,
    val favorite: Boolean = false,
    val shared: Boolean = false,
    // Present on "shared with you" and search results.
    val canEdit: Boolean? = null,
    val ownerName: String? = null,
    val shareId: Long? = null,
    val shareType: String? = null,
    val path: String? = null,
)

@Serializable
data class Crumb(val id: Long, val name: String)

@Serializable
data class NodeListing(
    val node: FileNode,
    val perm: String,
    val breadcrumb: List<Crumb>,
    val children: List<FileNode>? = null,
)

@Serializable
data class TrashItem(
    val id: Long,
    val name: String,
    val isDir: Boolean,
    val size: Long = 0,
    val mime: String = "",
    val deletedAt: String = "",
    val originalPath: String? = null,
)

@Serializable
data class Share(
    val id: Long,
    val nodeId: Long,
    val type: String,
    val shareWith: String? = null,
    val canEdit: Boolean = false,
    val token: String? = null,
    val url: String? = null,
    val hasPassword: Boolean = false,
    val expiresAt: String? = null,
    val node: FileNode? = null,
)

@Serializable
data class UploadSession(val id: String, val chunkSize: Long, val received: Long = 0, val size: Long = 0)

/** `GET /api/uploads/{id}`: how far an upload session got (to resume it). */
@Serializable
data class UploadStatus(val received: Long, val size: Long)

@Serializable
data class UploadedNode(val id: Long, val name: String, val size: Long)

@Serializable
data class ChunkResult(val received: Long, val done: Boolean, val node: UploadedNode? = null)

@Serializable
data class Version(val id: Long, val size: Long, val mtime: String)

@Serializable
data class Sharees(val users: List<Sharee> = emptyList(), val groups: List<ShareeGroup> = emptyList())

@Serializable
data class Sharee(val id: String, val displayName: String = "")

@Serializable
data class ShareeGroup(val id: String)

/** Live update from `GET /api/events`: folders whose listing changed; `shares` = shared-with-me changed. */
@Serializable
data class ChangeEvent(val folders: List<Long> = emptyList(), val shares: Boolean = false)

/** `GET /api/office`: extensions the server can show as PDF previews (`/api/nodes/{id}/preview`). */
@Serializable
data class OfficeInfo(val enabled: Boolean = false, val extensions: List<String> = emptyList())

/** `POST /api/addressbooks/{id}/import` result. */
