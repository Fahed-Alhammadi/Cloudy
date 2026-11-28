package io.cloudy.app.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.Crossfade
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.height
import androidx.compose.material.icons.outlined.People
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.ClipData
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.DriveFileMove
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.CloudDone
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.CreateNewFolder
import androidx.compose.material.icons.automirrored.outlined.NoteAdd
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.DownloadForOffline
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.LinkOff
import androidx.compose.material.icons.outlined.ManageAccounts
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.PersonAdd
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material.icons.outlined.Star
import androidx.compose.material.icons.outlined.StarOutline
import androidx.compose.material.icons.outlined.UploadFile
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.navigation.NavController
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import io.cloudy.app.R
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.cloudy.app.Services
import io.cloudy.app.data.ApiException
import io.cloudy.app.data.SafeName
import androidx.compose.ui.res.stringResource
import androidx.compose.material.icons.outlined.DocumentScanner
import androidx.compose.material3.Switch
import android.app.DatePickerDialog
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import io.cloudy.app.data.FileNode
import io.cloudy.app.data.NodeListing
import io.cloudy.app.data.Live
import io.cloudy.app.data.ListCache
import io.cloudy.app.data.Share
import io.cloudy.app.data.Sharees
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.withLock
import java.io.File
import java.io.IOException
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material3.ListItemDefaults
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback

/** Upload progress shown above the file list. */
class UploadState {
    var name by mutableStateOf<String?>(null)
    var progress by mutableStateOf(0f)
    var remaining by mutableIntStateOf(0)
}

fun queryName(context: Context, uri: Uri): Pair<String, Long> {
    var name = uri.lastPathSegment ?: "file"
    var size = -1L
    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
        if (c.moveToFirst()) {
            c.getString(0)?.let { name = it }
            if (!c.isNull(1)) size = c.getLong(1)
        }
    }
    return name to size
}

/**
 * One thing to upload. [name] replaces the item's own name (e.g. a scan saved under the name the user typed).
 * [copy]: its content, already copied into the app's cache (see [Uploads.startShared]); deleted after the upload.
 */
class UploadItem(val uri: Uri, val name: String? = null, val copy: File? = null)

suspend fun uploadUris(context: Context, parentId: Long, items: List<UploadItem>, state: UploadState): Int {
    var ok = 0
    for (item in items) {
        val uri = item.uri
        var temp: File? = item.copy
        // Content-provider queries and copies can take seconds (cloud-backed pickers): never on the UI thread.
        val (queried, knownSize) = try {
            withContext(Dispatchers.IO) { item.copy?.let { (item.name ?: uri.lastPathSegment ?: "file") to it.length() } ?: queryName(context, uri) }
        } catch (e: Exception) { uri.lastPathSegment.orEmpty() to -1L }
        val name = item.name ?: queried
        state.name = name
        state.progress = 0f
        try {
            // Unknown size: copy to cache first so the server gets an exact length.
            var source: () -> java.io.InputStream = item.copy?.let { c -> { c.inputStream() } }
                ?: { context.contentResolver.openInputStream(uri) ?: throw IOException(context.getString(R.string.cannot_read, name)) }
            var size = knownSize
            if (size < 0) {
                val open = source
                val t = withContext(Dispatchers.IO) { File(context.cacheDir, "up-${System.nanoTime()}") }.also { temp = it }
                size = withContext(Dispatchers.IO) { open().use { i -> t.outputStream().use { i.copyTo(it) } }; t.length() }
                source = { t.inputStream() }
            }
            // keepBoth: a second "image.jpg" shared from another app, or a second scan in the same minute, is added
            // next to the first. It used to replace it without a question.
            Services.api.upload(parentId, name, size, source, { sent -> state.progress = if (size > 0) sent.toFloat() / size else 1f }, keepBoth = true)
            ok++
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            toast(context, "$name: ${e.message}")
        } finally {
            temp?.let { withContext(Dispatchers.IO + kotlinx.coroutines.NonCancellable) { it.delete() } }
            state.remaining--
        }
    }
    if (state.remaining <= 0) state.name = null
    return ok
}

/**
 * Uploads started from the Files screens. They run in the app's scope, one batch after the other, so going back,
 * opening another folder or rotating the phone doesn't stop them; every folder screen shows the progress.
 */
object Uploads {
    val state = UploadState()
    /** Folder ids whose upload batch finished (their screens reload, also without live updates). */
    val finished = kotlinx.coroutines.flow.MutableSharedFlow<Long>(extraBufferCapacity = 8)
    private val queue = kotlinx.coroutines.sync.Mutex()
    /** Names this process's folder of copies in the cache; whatever an earlier process left there is removed. */
    private val session = System.nanoTime().toString()
    private val copies = java.util.concurrent.atomic.AtomicLong()

    /** [nameFor] can rename an item (e.g. a scan saved under the name the user typed). */
    fun start(context: Context, parentId: Long, uris: List<Uri>, nameFor: (Uri) -> String? = { null }) {
        if (uris.isEmpty()) return
        val app = context.applicationContext
        state.remaining += uris.size
        Services.appScope.launch { run(app, parentId, uris.map { UploadItem(it, nameFor(it)) }) }
    }

    /**
     * Files another app handed over ("Share to Cloudy"). Android lets us read them only as long as the screen that
     * received them is open: after Back, the rest of a batch failed with permission errors. So their content is
     * copied into the cache right away and the uploads read the copies. Files picked in the app don't need this.
     */
    fun startShared(context: Context, parentId: Long, uris: List<Uri>) {
        if (uris.isEmpty()) return
        val app = context.applicationContext
        state.remaining += uris.size
        Services.appScope.launch { run(app, parentId, withContext(Dispatchers.IO) { copyShared(app, uris) }) }
    }

    private suspend fun run(app: Context, parentId: Long, items: List<UploadItem>) {
        val n = queue.withLock { uploadUris(app, parentId, items, state) }
        finished.tryEmit(parentId)
        toast(app, app.getString(R.string.uploaded_n_of_m, n, items.size))
    }

    private fun copyShared(app: Context, uris: List<Uri>): List<UploadItem> {
        val all = File(app.cacheDir, "shared")
        all.listFiles()?.forEach { if (it.name != session) it.deleteRecursively() }
        val dir = File(all, session).apply { mkdirs() }
        val out = ArrayList<UploadItem>()
        // A group at a time is opened first and copied after: an open file stays readable when the permission ends,
        // and opening takes a moment where copying videos can take long.
        for (group in uris.chunked(50)) {
            val opened = group.map { uri ->
                Triple(uri, runCatching { queryName(app, uri).first }.getOrNull(), runCatching { app.contentResolver.openInputStream(uri) }.getOrNull())
            }
            for ((uri, name, input) in opened) {
                // The banner already names what is being prepared, unless it is busy showing another batch.
                if (name != null && !queue.isLocked) { state.name = name; state.progress = 0f }
                val copy = File(dir, copies.incrementAndGet().toString())
                val ok = input != null && runCatching { input.use { i -> copy.outputStream().use { i.copyTo(it) } } }.isSuccess
                if (!ok) copy.delete()
                // No copy (unreadable, or no room for it): the upload tries the original and says what is wrong.
                out += UploadItem(uri, name, copy.takeIf { ok })
            }
        }
        return out
    }
}

/** The file on the device for handing to another app: the offline copy, or a download into the cache. */
internal suspend fun localCopy(context: Context, node: FileNode): Uri {
    val offline = withContext(Dispatchers.IO) { Services.offline.localFile(node) }
    val file = offline ?: File(context.cacheDir, "open/${node.id}-${SafeName.etag(node.etag)}/${SafeName.segment(node.name)}").also {
        if (!withContext(Dispatchers.IO) { it.exists() }) {
            if (node.size > 5_000_000) toast(context, context.getString(R.string.downloading_name, node.name))
            withContext(Dispatchers.IO) {
                it.parentFile?.parentFile?.listFiles()?.filter { d -> d.name.startsWith("${node.id}-") }?.forEach { d -> d.deleteRecursively() }
            }
            Services.api.download(node.id, it)
        }
    }
    return FileProvider.getUriForFile(context, "${context.packageName}.files", file)
}

/** Sends the file itself (not a link) to another app: WhatsApp, Telegram, email, Bluetooth… */
suspend fun sendToApp(context: Context, node: FileNode) {
    val uri = localCopy(context, node)
    val intent = Intent(Intent.ACTION_SEND).setType(node.mime.ifEmpty { "application/octet-stream" })
        .putExtra(Intent.EXTRA_STREAM, uri)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        .apply { clipData = ClipData.newRawUri(node.name, uri) } // grants read access to the chosen app
    context.startActivity(Intent.createChooser(intent, context.getString(R.string.send_name, node.name)))
}

/** Downloads (or reuses the offline copy) and opens a file in another app. */
suspend fun openExternally(context: Context, node: FileNode) {
    val uri = localCopy(context, node)
    val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, node.mime.ifEmpty { "*/*" }).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    try {
        context.startActivity(Intent.createChooser(intent, context.getString(R.string.open_with)))
    } catch (_: ActivityNotFoundException) {
        toast(context, context.getString(R.string.no_app_can_open))
    }
}

// ---------------------------------------------------------------- folder screen

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FolderScreen(nav: NavController, folderId: Long, sharedUris: MutableState<List<Uri>>) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    // Last known contents show at once; load() refreshes them.
    var listing by remember { mutableStateOf(ListCache.folder(folderId)) }
    var offlineMode by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var menuOpen by remember { mutableStateOf(false) }
    // Open dialogs survive rotation (TextPrompt keeps what was typed).
    var newFolder by rememberSaveable { mutableStateOf(false) }
    var newTextFile by rememberSaveable { mutableStateOf(false) }
    var scanned by rememberSaveable { mutableStateOf<Uri?>(null) } // a scanned PDF waiting for its name
    var selecting by remember { mutableStateOf(false) }
    val viewPrefs = remember { ViewPrefs(context) }
    var grid by remember { mutableStateOf(viewPrefs.grid) }
    var sort by remember { mutableStateOf(viewPrefs.sort) }
    val uploads = Uploads.state

    /** The server can't be reached: show the folder as it was saved for offline use, if it was. */
    suspend fun unreachable(why: String?) {
        val cached = withContext(Dispatchers.IO) { Services.offline.cachedListing(folderId) }
        if (cached != null) { listing = cached; offlineMode = true } else error = context.getString(R.string.offline_error, why ?: "")
    }
    suspend fun load() {
        try {
            val l = Services.api.node(folderId)
            listing = l
            ListCache.putFolder(l)
            offlineMode = false
            error = null
            withContext(Dispatchers.IO) { if (Services.offline.hasCachedListing(folderId)) Services.offline.cacheListing(l) }
        } catch (e: ApiException) {
            // 502, 503 and 504 come from a reverse proxy while the server behind it restarts or is down: the server
            // can't be reached, the same as without a network. They used to show an error instead of the offline copy.
            if (e.status in 502..504) unreachable(e.message)
            else {
                error = e.message
                if (e.status == 404) listing = null // deleted (or unshared) meanwhile: say so instead of the old contents
            }
        } catch (e: IOException) {
            unreachable(e.message)
        }
    }
    LaunchedEffect(folderId) { load() }
    // Live updates: reload when this folder changes on any device (short delay batches bursts like uploads).
    LaunchedEffect(folderId) { Live.events.filter { Live.affects(it, folderId) }.collectLatest { delay(400); load() } }
    LaunchedEffect(folderId) { Uploads.finished.filter { it == folderId }.collect { load() } }
    val reload: () -> Unit = { scope.launch { load() } }
    val canEdit = listing?.perm != "read" && !offlineMode

    fun startUpload(uris: List<Uri>, nameFor: (Uri) -> String? = { null }) = Uploads.start(context, folderId, uris, nameFor)
    val pickFiles = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { startUpload(it) }
    val pickMedia = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia()) { startUpload(it) }
    val scan = rememberDocumentScanner { scanned = it }

    val known = listing?.node ?: ListCache.node(folderId)
    // The Files tab keeps its title also before anything has loaded (first start without a connection).
    val isRoot = folderId == Services.session.user.value?.rootId
    val title = known?.let { n -> if (n.parentId == null) stringResource(R.string.tab_files) else n.name } ?: if (isRoot) stringResource(R.string.tab_files) else ""
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    if (!isRoot) IconButton(onClick = { nav.popBackStack() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) }
                },
                actions = {
                    IconButton(onClick = { nav.navigate("search") }) { Icon(Icons.Outlined.Search, stringResource(R.string.search)) }
                    ViewActions(grid, sort, onGrid = { grid = it; viewPrefs.grid = it }, onSort = { sort = it; viewPrefs.sort = it })
                },
            )
        },
        floatingActionButton = {
            AnimatedVisibility(canEdit && !selecting, enter = scaleIn() + fadeIn(), exit = scaleOut() + fadeOut()) { Box {
                FloatingActionButton(onClick = { menuOpen = true }, modifier = Modifier.sideInsets()) { Icon(Icons.Filled.Add, stringResource(R.string.add)) }
                DropdownMenu(menuOpen, { menuOpen = false }) {
                    DropdownMenuItem({ Text(stringResource(R.string.upload_media)) }, leadingIcon = { Icon(Icons.Outlined.PhotoLibrary, null) }, onClick = {
                        menuOpen = false; pickMedia.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
                    })
                    DropdownMenuItem({ Text(stringResource(R.string.upload_files)) }, leadingIcon = { Icon(Icons.Outlined.UploadFile, null) }, onClick = {
                        menuOpen = false; pickFiles.launch(arrayOf("*/*"))
                    })
                    DropdownMenuItem({ Text(stringResource(R.string.scan_document)) }, leadingIcon = { Icon(Icons.Outlined.DocumentScanner, null) }, onClick = {
                        menuOpen = false; scan()
                    })
                    DropdownMenuItem({ Text(stringResource(R.string.new_folder)) }, leadingIcon = { Icon(Icons.Outlined.CreateNewFolder, null) }, onClick = {
                        menuOpen = false; newFolder = true
                    })
                    DropdownMenuItem({ Text(stringResource(R.string.new_text_file)) }, leadingIcon = { Icon(Icons.AutoMirrored.Outlined.NoteAdd, null) }, onClick = {
                        menuOpen = false; newTextFile = true
                    })
                }
            } }
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            if (offlineMode) Text(stringResource(R.string.offline_mode), Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
                color = MaterialTheme.colorScheme.outline, style = MaterialTheme.typography.labelMedium)
            if (listing?.perm == "read") Text(stringResource(R.string.read_only_folder), Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                color = MaterialTheme.colorScheme.outline, style = MaterialTheme.typography.labelMedium)
            AnimatedVisibility(uploads.name != null, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
                // The last name stays while the banner closes (uploads.name is already null then).
                val last = remember { arrayOf<Any>("", 1) }
                uploads.name?.let { last[0] = it; last[1] = uploads.remaining }
                val lastName = last[0] as String
                // A new file starts its bar at zero (keyed by name) instead of sweeping back from the last one's end.
                val progress by androidx.compose.runtime.key(lastName) { animateFloatAsState(uploads.progress, label = "upload") }
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp).clip(RoundedCornerShape(16.dp))
                    .background(MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.5f)).padding(horizontal = 14.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.UploadFile, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(22.dp))
                    Column(Modifier.padding(start = 12.dp).weight(1f)) {
                        Text(stringResource(R.string.uploading_name, lastName, last[1] as Int), style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth().padding(top = 6.dp).clip(RoundedCornerShape(2.dp)), drawStopIndicator = {}, gapSize = 0.dp)
                    }
                }
            }
            if (sharedUris.value.isNotEmpty() && canEdit) {
                ListItem(
                    headlineContent = { Text(stringResource(R.string.upload_shared_here, sharedUris.value.size)) },
                    leadingContent = { Icon(Icons.Outlined.UploadFile, null) },
                    trailingContent = {
                        Row {
                            TextButton(onClick = { sharedUris.value = emptyList() }) { Text(stringResource(R.string.dismiss)) }
                            TextButton(onClick = { val u = sharedUris.value; sharedUris.value = emptyList(); Uploads.startShared(context, folderId, u) }) { Text(stringResource(R.string.upload)) }
                        }
                    },
                )
            }
            PullToRefreshBox(isRefreshing = refreshing, onRefresh = { scope.launch { refreshing = true; load(); refreshing = false } }) {
                val l = listing
                when {
                    error != null && l == null -> EmptyState(Icons.Outlined.CloudOff, error!!, onRetry = reload)
                    l == null -> Loading()
                    l.children.isNullOrEmpty() -> EmptyState(Icons.Outlined.FolderOpen, stringResource(if (canEdit) R.string.empty_folder_tap else R.string.empty_folder))
                    else -> {
                        // Sorted once per listing and order, not on every redraw (upload progress redraws this often).
                        val sorted = remember(l.children, sort) { sortNodes(l.children, sort) }
                        NodeList(sorted, nav, canModify = { canEdit }, reload = reload, scope = scope, grid = grid, onSelecting = { selecting = it })
                    }
                }
            }
        }
    }
    if (newFolder) TextPrompt(stringResource(R.string.new_folder), stringResource(R.string.new_folder), confirm = stringResource(R.string.create), onDismiss = { newFolder = false }) { name ->
        newFolder = false
        scope.launch { runCatching { Services.api.mkdir(folderId, name) }.onFailure { toast(context, it.message ?: context.getString(R.string.failed)) }; load() }
    }
    scanned?.let { pdf ->
        val stamp = rememberSaveable { LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH.mm")) }
        TextPrompt(stringResource(R.string.scan_save_title), stringResource(R.string.scan_default_name, stamp), confirm = stringResource(R.string.upload),
            onDismiss = { scanned = null }) { name ->
            scanned = null
            startUpload(listOf(pdf)) { if (name.endsWith(".pdf", ignoreCase = true)) name else "$name.pdf" }
        }
    }
    if (newTextFile) TextPrompt(stringResource(R.string.new_text_file), "Notes.txt", confirm = stringResource(R.string.create), onDismiss = { newTextFile = false }) { name ->
        newTextFile = false
        val fileName = if ('.' in name) name else "$name.txt"
        scope.launch {
            runCatching { Services.api.createTextFile(folderId, fileName) }
                .onSuccess { load(); nav.navigate("preview/${it.id}") }
                .onFailure { toast(context, it.message ?: context.getString(R.string.failed)) }
        }
    }
}

// ---------------------------------------------------------------- shared list + actions

fun openNode(nav: NavController, node: FileNode) {
    when {
        node.isDir -> nav.navigate("files/${node.id}")
        else -> nav.navigate("preview/${node.id}")
    }
}

/**
 * Files as a list or grid. Tap opens; long-press (or ⋮) shows the actions, whose first entry "Select" starts
 * multi-select: then taps tick files and the bar at the bottom acts on all of them. [onSelecting] lets the screen
 * hide its + button meanwhile.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun NodeList(
    items: List<FileNode>,
    nav: NavController,
    canModify: (FileNode) -> Boolean,
    reload: () -> Unit,
    scope: CoroutineScope,
    subtitle: (FileNode) -> String? = { null },
    /** A small picture of the person before the subtitle (the owner on "Shared with you"). */
    subtitlePerson: ((FileNode) -> Triple<String, String, String?>?)? = null,
    grid: Boolean = false,
    onSelecting: (Boolean) -> Unit = {},
) {
    val context = LocalContext.current
    val haptics = LocalHapticFeedback.current
    // The open actions sheet (and its dialog, see NodeActions) survives rotation.
    var sheetFor by rememberSaveable(stateSaver = jsonSaver<FileNode>()) { mutableStateOf<FileNode?>(null) }
    // Selected ids survive rotation; files that disappear (deleted on another device) drop out by themselves.
    var selectedIds by rememberSaveable { mutableStateOf(listOf<Long>()) }
    // As a set: looking every row up in the list made "Select all" slow in a big folder (rows × selected).
    val selectedSet = remember(selectedIds) { selectedIds.toHashSet() }
    val selected = remember(selectedSet, items) { items.filter { it.id in selectedSet } }
    val selecting = selected.isNotEmpty()
    var bulk by rememberSaveable { mutableStateOf<String?>(null) }
    LaunchedEffect(selecting) { onSelecting(selecting) }
    BackHandler(selecting) { selectedIds = emptyList() }

    fun toggle(n: FileNode) { selectedIds = if (n.id in selectedSet) selectedIds - n.id else selectedIds + n.id }
    fun longPress(n: FileNode) {
        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
        if (selecting) toggle(n) else sheetFor = n
    }
    val open: (FileNode) -> Unit = { if (selecting) toggle(it) else openNode(nav, it) }
    /** Runs [action] on each node, then clears the selection and reloads; failures are counted, not fatal. */
    fun bulkAct(nodes: List<FileNode>, action: suspend (FileNode) -> Unit) {
        selectedIds = emptyList()
        // In the app's scope: in the screen's own, rotating the phone or leaving the folder stopped it half-way.
        // reload() does nothing once the screen is gone.
        val app = context.applicationContext
        Services.appScope.launch {
            val failed = nodes.count { n -> runCatching { action(n) }.isFailure }
            if (failed > 0) toast(app, app.getString(R.string.n_failed, failed))
            reload()
        }
    }
    val modifiable = selected.filter(canModify)
    // What the bar showed last, for the moment it slides away (the selection is already empty then).
    val lastCount = remember { IntArray(2) { 1 } }
    if (selected.isNotEmpty()) { lastCount[0] = selected.size; lastCount[1] = if (modifiable.isEmpty()) 0 else 1 }
    val barCanModify = lastCount[1] == 1

    Box(Modifier.fillMaxSize()) {
        // Switching between list and grid cross-fades; rows glide to their new place when files come, go or are re-sorted.
        AnimatedContent(grid, transitionSpec = { (fadeIn(tween(220, delayMillis = 60)) + scaleIn(tween(220, delayMillis = 60), initialScale = 0.98f)) togetherWith fadeOut(tween(90)) },
            label = "list or grid") { asGrid ->
        if (asGrid) NodeGrid(items, onOpen = open, onActions = { longPress(it) }, selected = if (selecting) selectedSet else null)
        // Room at the end so the last row's ⋮ is never stuck under the + button or the selection bar.
        else LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 88.dp)) {
            items(items, key = { it.id }) { node ->
                val isSelected = node.id in selectedSet
                val rowColor by animateColorAsState(if (isSelected) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surface, label = "row")
                ListItem(
                    modifier = Modifier.animateItem().combinedClickable(onClick = { open(node) }, onLongClick = { longPress(node) }),
                    colors = ListItemDefaults.colors(containerColor = rowColor),
                    leadingContent = {
                        // Same footprint for the tile and the checkbox, so names don't shift when selection starts.
                        Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
                            Crossfade(selecting, label = "tile or checkbox") { on -> if (on) Checkbox(isSelected, onCheckedChange = { toggle(node) }) else FileTile(node) }
                        }
                    },
                    headlineContent = { Text(node.name, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium) },
                    supportingContent = {
                        val text = subtitle(node) ?: listOfNotNull(formatWhen(node.mtime).ifEmpty { null }, if (node.isDir) null else formatSize(node.size)).joinToString(" · ")
                        val person = subtitlePerson?.invoke(node)
                        if (person == null) Text(text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        else Row(verticalAlignment = Alignment.CenterVertically) {
                            Avatar(person.first, 18.dp, person.second, person.third)
                            Text(text, Modifier.padding(start = 6.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    },
                    trailingContent = {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            if (node.favorite) Icon(Icons.Filled.Star, null, tint = FavoriteColor, modifier = Modifier.size(18.dp))
                            if (Services.offline.isPinned(node.id)) Icon(Icons.Outlined.CloudDone, stringResource(R.string.available_offline), tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
                            if (node.shared) Icon(Icons.Outlined.People, stringResource(R.string.shared), tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
                            if (!selecting) IconButton(onClick = { sheetFor = node }) { Icon(Icons.Outlined.MoreVert, stringResource(R.string.actions_for, node.name), tint = MaterialTheme.colorScheme.onSurfaceVariant) }
                        }
                    },
                )
            }
        }
        }
        AnimatedVisibility(selecting, Modifier.align(Alignment.BottomCenter), enter = slideInVertically { it } + fadeIn(), exit = slideOutVertically { it } + fadeOut()) { SelectionBar(
            // The count stays while the bar slides away (the selection is already empty then).
            count = selected.size.takeIf { it > 0 } ?: lastCount[0],
            onClose = { selectedIds = emptyList() },
            onSelectAll = { selectedIds = items.map { it.id } },
            onSend = {
                val files = selected.filter { !it.isDir }
                if (files.isEmpty()) toast(context, context.getString(R.string.send_files_only))
                else scope.launch { runCatching { sendManyToApp(context, files) }.onFailure { toast(context, it.message ?: context.getString(R.string.failed)) } }
            },
            onFavorite = { bulkAct(selected.filter { !it.favorite }) { Services.api.setFavorite(it.id, true) } },
            onMove = if (!barCanModify) null else ({ if (modifiable.isNotEmpty()) bulk = "move" }),
            onDelete = if (!barCanModify) null else ({ if (modifiable.isNotEmpty()) bulk = "delete" }),
        ) }
    }
    sheetFor?.let { node -> NodeActions(node, nav, canModify(node), reload, scope, onSelect = { selectedIds = listOf(node.id) }) { sheetFor = null } }
    when (bulk) {
        "delete" -> ConfirmDialog(stringResource(R.string.delete), stringResource(R.string.delete_n_confirm, modifiable.size), stringResource(R.string.delete),
            onDismiss = { bulk = null }) { bulk = null; bulkAct(modifiable) { Services.api.delete(it.id) } }
        "move" -> FolderPicker(stringResource(R.string.move_copy_n, modifiable.size), modifiable.map { it.id }.toSet(), onDismiss = { bulk = null }) { dest, copy ->
            bulk = null
            bulkAct(modifiable) { if (copy) Services.api.copy(it.id, dest) else Services.api.move(it.id, dest) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NodeActions(node: FileNode, nav: NavController, canModify: Boolean, reload: () -> Unit, scope: CoroutineScope, onSelect: (() -> Unit)? = null, onClose: () -> Unit) {
    val context = LocalContext.current
    val app = context.applicationContext // for work that goes on after this screen is gone
    val me by Services.session.user.collectAsStateWithLifecycle()
    val isOwner = node.owner == me?.id
    var dialog by rememberSaveable { mutableStateOf<String?>(null) }
    // The sheet stays open while the system "Save" screen is up and closes when it answers: this launcher lives in the
    // sheet, so closing the sheet first unregistered it and the answer was lost — the picker had already created the
    // file, which then stayed empty (0 KB).
    val saveAs = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(node.mime.ifEmpty { "application/octet-stream" })) { uri ->
        onClose()
        // App scope, like uploads: leaving the screen mid-download must not leave an empty file behind either.
        if (uri != null) Services.appScope.launch {
            val tmp = File(app.cacheDir, "save-${node.id}")
            try {
                Services.api.download(node.id, tmp)
                withContext(Dispatchers.IO) {
                    val out = app.contentResolver.openOutputStream(uri) ?: error(app.getString(R.string.failed))
                    out.use { o -> tmp.inputStream().use { it.copyTo(o) } }
                }
                toast(app, app.getString(R.string.saved))
            } catch (e: Exception) {
                // Don't leave the empty file the picker created behind.
                withContext(Dispatchers.IO + kotlinx.coroutines.NonCancellable) {
                    runCatching { android.provider.DocumentsContract.deleteDocument(app.contentResolver, uri) }
                }
                if (e !is kotlinx.coroutines.CancellationException) toast(app, e.message ?: app.getString(R.string.failed))
            } finally {
                withContext(Dispatchers.IO + kotlinx.coroutines.NonCancellable) { tmp.delete() }
            }
        }
    }

    fun act(block: suspend () -> Unit) {
        onClose()
        // In the app's scope: in the screen's own, rotating the phone or leaving the folder stopped the action (making
        // a folder available offline ended half-way). reload() does nothing once the screen is gone.
        Services.appScope.launch {
            try { block() } catch (e: Exception) { toast(app, e.message ?: app.getString(R.string.failed)) }
            reload()
        }
    }

    if (dialog == null) ModalBottomSheet(onDismissRequest = onClose) {
        Row(Modifier.padding(start = 24.dp, end = 24.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            FileTile(node, 44.dp)
            Column(Modifier.padding(start = 14.dp)) {
                Text(node.name, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                val details = listOfNotNull(formatWhen(node.mtime).ifEmpty { null }, if (node.isDir) null else formatSize(node.size)).joinToString(" · ")
                if (details.isNotEmpty()) Text(details, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        @Composable
        fun Item(label: Int, icon: androidx.compose.ui.graphics.vector.ImageVector, danger: Boolean = false, onClick: () -> Unit) =
            ListItem(
                modifier = Modifier.clickable(onClick = onClick), colors = ListItemDefaults.colors(containerColor = androidx.compose.ui.graphics.Color.Transparent),
                leadingContent = { Icon(icon, null, tint = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant) },
                headlineContent = { Text(stringResource(label), color = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface) },
            )
        val failed = stringResource(R.string.failed)
        onSelect?.let { select -> Item(R.string.select, Icons.Outlined.CheckCircle) { onClose(); select() } }
        if (!node.isDir) Item(R.string.send_to, Icons.AutoMirrored.Outlined.Send) { onClose(); scope.launch { runCatching { sendToApp(context, node) }.onFailure { if (it is kotlinx.coroutines.CancellationException) throw it; toast(context, it.message ?: failed) } } }
        if (!node.isDir) Item(R.string.open_with, Icons.AutoMirrored.Outlined.OpenInNew) { onClose(); scope.launch { runCatching { openExternally(context, node) }.onFailure { if (it is kotlinx.coroutines.CancellationException) throw it; toast(context, it.message ?: failed) } } }
        Item(if (node.isDir) R.string.save_as_zip else R.string.save_to_device, Icons.Outlined.Download) { saveAs.launch(node.name + if (node.isDir) ".zip" else "") }
        if (Services.offline.isPinned(node.id)) Item(R.string.remove_offline, Icons.Outlined.CloudOff) { act { Services.offline.unpin(node.id) } }
        else Item(R.string.make_offline, Icons.Outlined.DownloadForOffline) { act { Services.offline.pin(node); toast(app, app.getString(R.string.available_offline)) } }
        if (isOwner) {
            Item(R.string.share_link, Icons.Outlined.Link) { dialog = "link" }
            Item(R.string.share_people, Icons.Outlined.PersonAdd) { dialog = "people" }
            if (node.shared) Item(R.string.manage_sharing, Icons.Outlined.ManageAccounts) { dialog = "shares" }
        }
        Item(if (node.favorite) R.string.remove_favorite else R.string.add_favorite, if (node.favorite) Icons.Outlined.StarOutline else Icons.Outlined.Star) {
            act { Services.api.setFavorite(node.id, !node.favorite) }
        }
        if (canModify) {
            Item(R.string.rename, Icons.Outlined.Edit) { dialog = "rename" }
            Item(R.string.move_or_copy, Icons.AutoMirrored.Outlined.DriveFileMove) { dialog = "move" }
            Item(R.string.delete, Icons.Outlined.Delete, danger = true) { dialog = "delete" }
        }
        node.shareId?.takeIf { node.shareType == "user" }?.let { sid ->
            Item(R.string.leave_share, Icons.Outlined.Delete, danger = true) { act { Services.api.deleteShare(sid) } }
        }
        Spacer(Modifier.heightIn(min = 24.dp))
    }

    when (dialog) {
        "rename" -> TextPrompt(stringResource(R.string.rename), node.name, confirm = stringResource(R.string.rename), onDismiss = onClose) { name -> act { Services.api.rename(node.id, name) } }
        "delete" -> ConfirmDialog(stringResource(R.string.delete), stringResource(R.string.delete_confirm, node.name), stringResource(R.string.delete), onClose) { act { Services.api.delete(node.id) } }
        "move" -> FolderPicker(stringResource(R.string.move_copy_title, node.name), setOf(node.id), onDismiss = onClose) { dest, copy -> act { if (copy) Services.api.copy(node.id, dest) else Services.api.move(node.id, dest) } }
        "link" -> LinkDialog(node, onClose)
        "people" -> PeopleDialog(node, onClose)
        "shares" -> SharesDialog(node) { act {} }
    }
}

@Composable
fun FolderPicker(title: String, exclude: Set<Long>, onDismiss: () -> Unit, onPick: (Long, Boolean) -> Unit) {
    val rootId = Services.session.user.value?.rootId ?: return
    var current by remember { mutableStateOf(rootId) }
    var listing by remember { mutableStateOf<NodeListing?>(null) }
    LaunchedEffect(current) { listing = runCatching { Services.api.node(current) }.getOrNull() }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        text = {
            Column {
                val files = stringResource(R.string.tab_files)
                Text(listing?.breadcrumb?.joinToString(" / ") { it.name.ifEmpty { files } } ?: "…", style = MaterialTheme.typography.labelLarge)
                LazyColumn(Modifier.heightIn(max = 320.dp)) {
                    listing?.node?.parentId?.let { parent ->
                        item { ListItem(modifier = Modifier.clickable { current = parent }, headlineContent = { Text("..") }, leadingContent = { Icon(Icons.Outlined.Folder, null) }) }
                    }
                    items(listing?.children.orEmpty().filter { it.isDir && it.id !in exclude }, key = { it.id }) { d ->
                        ListItem(modifier = Modifier.clickable { current = d.id }, headlineContent = { Text(d.name) }, leadingContent = { FileIcon(d, Modifier.size(24.dp)) })
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = { onPick(current, false) }) { Text(stringResource(R.string.move_here)) } },
        dismissButton = {
            Row {
                TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) }
                TextButton(onClick = { onPick(current, true) }) { Text(stringResource(R.string.copy_here)) }
            }
        },
    )
}

@Composable
fun LinkDialog(node: FileNode, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var password by rememberSaveable { mutableStateOf("") }
    var expires by rememberSaveable { mutableStateOf<LocalDate?>(null) } // last day the link works
    var allowUpload by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    // The server refuses link passwords under 4 characters (1.19+); said here, before sending. A blank one
    // means no password (it is not sent).
    val passwordTooShort = password.isNotBlank() && password.length < 4
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.share_link)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.link_anyone, node.name))
                OutlinedTextField(password, { password = it }, label = { Text(stringResource(R.string.link_password)) }, singleLine = true,
                    isError = passwordTooShort,
                    supportingText = if (passwordTooShort) { { Text(stringResource(R.string.link_password_short)) } } else null)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = {
                        val d = expires ?: LocalDate.now().plusDays(7)
                        DatePickerDialog(context, { _, y, m, dd -> expires = LocalDate.of(y, m + 1, dd) }, d.year, d.monthValue - 1, d.dayOfMonth)
                            .apply { datePicker.minDate = System.currentTimeMillis() }.show()
                    }) {
                        Text(expires?.let { stringResource(R.string.link_expires_on, it.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM))) }
                            ?: stringResource(R.string.link_expires_never))
                    }
                    if (expires != null) IconButton(onClick = { expires = null }) { Icon(Icons.Outlined.LinkOff, stringResource(R.string.link_remove_expiry)) }
                }
                // Public upload into shared folders (a "file drop"); files can't take uploads.
                if (node.isDir) SwitchRow(stringResource(R.string.link_allow_upload), allowUpload) { allowUpload = it }
            }
        },
        confirmButton = {
            TextButton(enabled = !busy && !passwordTooShort, onClick = {
                busy = true
                scope.launch {
                    try {
                        val s = Services.api.createLink(node.id, password, expires?.toString(), allowUpload && node.isDir)
                        shareText(context, Services.api.url(s.url ?: ""))
                        onDismiss()
                    } catch (e: Exception) { toast(context, e.message ?: context.getString(R.string.failed)); busy = false }
                }
            }) { Text(stringResource(R.string.create_and_share)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) } },
    )
}

/** Lists a node's links and user/group shares, so they can be re-sent or stopped. */
@Composable
fun SharesDialog(node: FileNode, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var shares by remember { mutableStateOf<List<Share>?>(null) }
    var stopping by remember { mutableStateOf<Share?>(null) }
    suspend fun load() { shares = runCatching { Services.api.shares(node.id) }.getOrElse { toast(context, it.message ?: context.getString(R.string.failed)); emptyList() } }
    LaunchedEffect(node.id) { load() }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.sharing_title, node.name), maxLines = 1, overflow = TextOverflow.Ellipsis) },
        text = {
            val list = shares
            when {
                list == null -> Loading()
                list.isEmpty() -> Text(stringResource(R.string.not_shared_anymore))
                else -> Column(Modifier.verticalScroll(rememberScrollState())) {
                    list.forEach { sh ->
                        val link = sh.type == "link"
                        ListItem(
                            leadingContent = {
                                when (sh.type) {
                                    "user" -> Avatar(sh.shareWithName ?: sh.shareWith ?: "", 40.dp, sh.shareWith, sh.shareWithAvatar)
                                    "group" -> Icon(Icons.Outlined.Groups, null)
                                    else -> Icon(Icons.Outlined.Link, null)
                                }
                            },
                            headlineContent = {
                                Text(when (sh.type) {
                                    "link" -> stringResource(R.string.public_link)
                                    "group" -> stringResource(R.string.group_name, sh.shareWith ?: "")
                                    else -> sh.shareWithName?.ifBlank { null } ?: sh.shareWith ?: "" // the name; the dialog is too narrow for "Name (id)"
                                }, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            },
                            supportingContent = {
                                Text(listOfNotNull(
                                    if (sh.canEdit) stringResource(R.string.share_can_edit) else if (link) null else stringResource(R.string.share_read_only),
                                    if (sh.hasPassword) stringResource(R.string.share_password) else null,
                                    sh.expiresAt?.let { stringResource(R.string.share_expires, formatWhen(it)) }, // the day is enough here
                                ).joinToString(" · ").ifEmpty { stringResource(R.string.share_anyone) })
                            },
                            trailingContent = {
                                Row {
                                    if (link && sh.url != null) IconButton(onClick = { shareText(context, Services.api.url(sh.url)) }) { Icon(Icons.Outlined.Share, stringResource(R.string.send_link)) }
                                    IconButton(onClick = { stopping = sh }) { Icon(Icons.Outlined.LinkOff, stringResource(R.string.stop_sharing), tint = MaterialTheme.colorScheme.error) }
                                }
                            },
                        )
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.done)) } },
    )
    stopping?.let { sh ->
        ConfirmDialog(stringResource(R.string.stop_sharing),
            if (sh.type == "link") stringResource(R.string.stop_link_text) else stringResource(R.string.stop_user_text, sh.shareWith ?: "", node.name),
            stringResource(R.string.stop_sharing), { stopping = null }) {
            stopping = null
            scope.launch {
                runCatching { Services.api.deleteShare(sh.id) }.onFailure { toast(context, it.message ?: context.getString(R.string.failed)) }
                load()
            }
        }
    }
}

@Composable
fun PeopleDialog(node: FileNode, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var target by rememberSaveable { mutableStateOf("") }
    var canEdit by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var suggestions by remember { mutableStateOf<Sharees?>(null) }
    LaunchedEffect(target) {
        delay(250) // one lookup per pause in typing, not per letter
        if (target.length >= 1) runCatching { Services.api.sharees(target.removePrefix("group:")) }.onSuccess { s ->
            suggestions = s
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.share_people)) },
        text = {
            Column {
                OutlinedTextField(target, { target = it }, label = { Text(stringResource(R.string.username_or_group)) }, singleLine = true)
                // People with their picture, then groups; five at most.
                val people = suggestions?.users.orEmpty().take(5)
                people.forEach { u ->
                    Row(Modifier.fillMaxWidth().clickable { target = u.id }.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Avatar(u.displayName.ifBlank { u.id }, 32.dp, u.id, u.avatar)
                        Text(if (u.displayName.isBlank()) u.id else "${u.displayName} (${u.id})", Modifier.padding(start = 12.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                suggestions?.groups.orEmpty().take(5 - people.size).forEach { g ->
                    Row(Modifier.fillMaxWidth().clickable { target = "group:${g.id}" }.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(32.dp), contentAlignment = Alignment.Center) { Icon(Icons.Outlined.Groups, null) }
                        Text(stringResource(R.string.group_name, g.id), Modifier.padding(start = 12.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                Row(Modifier.fillMaxWidth().toggleable(canEdit, role = androidx.compose.ui.semantics.Role.Checkbox) { canEdit = it },
                    verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(canEdit, onCheckedChange = null, Modifier.padding(12.dp)); Text(stringResource(R.string.can_edit))
                }
            }
        },
        confirmButton = {
            TextButton(enabled = target.isNotBlank() && !busy, onClick = {
                busy = true // a second tap would share twice
                scope.launch {
                    try { Services.api.shareWith(node.id, target.trim(), canEdit); toast(context, context.getString(R.string.shared_toast)); onDismiss() }
                    catch (e: Exception) { toast(context, e.message ?: context.getString(R.string.failed)) }
                    busy = false
                }
            }) { Text(stringResource(R.string.share)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) } },
    )
}

// ---------------------------------------------------------------- list screens

@OptIn(ExperimentalMaterial3Api::class)
@Composable
/** A list of files from anywhere (Recent, Shared, Favorites…). As a bottom-bar tab ([isTab]) it has no Back button. */
fun NodeListScreen(nav: NavController, kind: String, isTab: Boolean = false) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var items by remember { mutableStateOf(ListCache.list(kind)) }
    var error by remember { mutableStateOf<String?>(null) }
    val me by Services.session.user.collectAsStateWithLifecycle()
    val title = mapOf("recent" to R.string.recent, "favorites" to R.string.favorites, "shared-in" to R.string.shared_with_you,
        "shared-out" to R.string.shared_by_you, "offline" to R.string.available_offline)[kind]?.let { stringResource(it) } ?: kind
    val linkWord = stringResource(R.string.link_word)
    var outgoing by remember { mutableStateOf<Map<Long, String>>(emptyMap()) }

    suspend fun load() {
        try {
            items = when (kind) {
                "recent" -> Services.api.recent()
                "favorites" -> Services.api.favorites()
                "shared-in" -> Services.api.sharedWithMe()
                "shared-out" -> Services.api.sharedByMe().also { list ->
                    outgoing = list.groupBy { it.nodeId }.mapValues { (_, s) -> s.joinToString { if (it.type == "link") linkWord else it.shareWith ?: "" } }
                }.mapNotNull { it.node }.distinctBy { it.id }
                "offline" -> coroutineScope {
                    Services.offline.ready()
                    Services.offline.pinned.map { id ->
                        async { runCatching { Services.api.node(id).node }.getOrNull() ?: Services.offline.savedNode(id) }
                    }.awaitAll().filterNotNull()
                }
                else -> emptyList()
            }.also { ListCache.putList(kind, it) }
            error = null
        } catch (e: Exception) { if (items == null) error = e.message }
    }
    LaunchedEffect(kind) { load() }
    LaunchedEffect(kind) {
        if (kind != "offline") Live.events.filter { it.folders.isNotEmpty() || it.shares }.collectLatest { delay(400); load() }
    }
    Scaffold(topBar = {
        TopAppBar(title = { Text(title) }, navigationIcon = {
            if (!isTab) IconButton(onClick = { nav.popBackStack() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) }
        })
    }) { pad ->
        Box(Modifier.padding(pad)) {
            val list = items
            when {
                error != null && list == null -> EmptyState(Icons.Outlined.CloudOff, error!!) { scope.launch { load() } }
                list == null -> Loading()
                list.isEmpty() -> EmptyState(Icons.Outlined.FolderOpen, stringResource(R.string.nothing_here))
                else -> NodeList(list, nav, canModify = { it.owner == me?.id }, reload = { scope.launch { load() } }, scope = scope, subtitle = { n ->
                    when (kind) {
                        "shared-in" -> context.getString(if (n.canEdit == true) R.string.from_owner_can_edit else R.string.from_owner, n.ownerName ?: n.owner)
                        "shared-out" -> context.getString(R.string.with_targets, outgoing[n.id] ?: "")
                        else -> null
                    }
                }, subtitlePerson = if (kind == "shared-in") { n -> Triple(n.ownerName ?: n.owner, n.owner, n.ownerAvatar) } else null)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SearchScreen(nav: NavController) {
    val scope = rememberCoroutineScope()
    var q by rememberSaveable { mutableStateOf("") }
    var results by remember { mutableStateOf<List<FileNode>>(emptyList()) }
    // The query [results] belong to: while a newer one runs, "No matches" isn't claimed for it yet.
    var searched by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableIntStateOf(0) }
    var filter by rememberSaveable { mutableStateOf(TypeFilter.ALL) }
    val me by Services.session.user.collectAsStateWithLifecycle()
    val focus = remember { FocusRequester() }
    val filesLabel = stringResource(R.string.tab_files) // where files at the top level are
    LaunchedEffect(Unit) { focus.requestFocus() } // open the keyboard right away
    LaunchedEffect(q, reloadKey) {
        val query = q.trim()
        if (query.isEmpty()) { results = emptyList(); searched = null; error = null; return@LaunchedEffect }
        kotlinx.coroutines.delay(250)
        try { results = Services.api.search(query); error = null }
        catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e; error = e.message; results = emptyList() }
        searched = query
    }
    Scaffold(topBar = {
        TopAppBar(
            title = { SearchField(q, { q = it }, stringResource(R.string.search_files), Modifier.padding(end = 12.dp).height(48.dp).focusRequester(focus)) },
            navigationIcon = { IconButton(onClick = { nav.popBackStack() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) } },
        )
    }) { pad ->
        // imePadding: edge-to-edge, so the results must end above the keyboard themselves (the last ones were under it).
        Column(Modifier.padding(pad).consumeWindowInsets(pad).imePadding()) {
            TypeFilterRow(filter) { filter = it }
            val shown = results.filter(filter.matches)
            when {
                q.isNotBlank() && searched != q.trim() && shown.isEmpty() -> Loading()
                error != null && q.isNotBlank() -> EmptyState(Icons.Outlined.CloudOff, error!!)
                q.isNotBlank() && shown.isEmpty() -> EmptyState(Icons.Outlined.Search, stringResource(R.string.no_matches))
                // Results include files shared with you: only your own can be renamed, moved or deleted (as in Recent).
                else -> NodeList(shown, nav, canModify = { it.owner == me?.id }, reload = { reloadKey++ }, scope = scope,
                    subtitle = { it.path?.trim('/')?.ifEmpty { null } ?: filesLabel })
            }
        }
    }
}

@Suppress("unused")
private val keepWidth = Modifier.width(0.dp)
