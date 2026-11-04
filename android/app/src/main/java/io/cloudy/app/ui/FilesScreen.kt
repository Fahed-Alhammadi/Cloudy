package io.cloudy.app.ui

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
import androidx.compose.material.icons.outlined.NoteAdd
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

/** [nameFor] can rename an item (e.g. a scan saved under the name the user typed). */
suspend fun uploadUris(context: Context, parentId: Long, uris: List<Uri>, state: UploadState, nameFor: (Uri) -> String? = { null }): Int {
    var ok = 0
    for (uri in uris) {
        // Content-provider queries and copies can take seconds (cloud-backed pickers): never on the UI thread.
        val (queried, knownSize) = try { withContext(Dispatchers.IO) { queryName(context, uri) } } catch (e: Exception) { uri.lastPathSegment.orEmpty() to -1L }
        val name = nameFor(uri) ?: queried
        state.name = name
        state.progress = 0f
        var temp: File? = null
        try {
            // Unknown size: copy to cache first so the server gets an exact length.
            var source: () -> java.io.InputStream = { context.contentResolver.openInputStream(uri) ?: throw IOException(context.getString(R.string.cannot_read, name)) }
            var size = knownSize
            if (size < 0) {
                val open = source
                val t = withContext(Dispatchers.IO) { File(context.cacheDir, "up-${System.nanoTime()}") }.also { temp = it }
                size = withContext(Dispatchers.IO) { open().use { i -> t.outputStream().use { i.copyTo(it) } }; t.length() }
                source = { t.inputStream() }
            }
            Services.api.upload(parentId, name, size, source, { sent -> state.progress = if (size > 0) sent.toFloat() / size else 1f })
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

    fun start(context: Context, parentId: Long, uris: List<Uri>, nameFor: (Uri) -> String? = { null }) {
        if (uris.isEmpty()) return
        val app = context.applicationContext
        state.remaining += uris.size
        Services.appScope.launch {
            val n = queue.withLock { uploadUris(app, parentId, uris, state, nameFor) }
            finished.tryEmit(parentId)
            toast(app, app.getString(R.string.uploaded_n_of_m, n, uris.size))
        }
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

    suspend fun load() {
        try {
            val l = Services.api.node(folderId)
            listing = l
            ListCache.putFolder(l)
            offlineMode = false
            error = null
            withContext(Dispatchers.IO) { if (Services.offline.hasCachedListing(folderId)) Services.offline.cacheListing(l) }
        } catch (e: ApiException) {
            error = e.message
            if (e.status == 404) listing = null // deleted (or unshared) meanwhile: say so instead of the old contents
        } catch (e: IOException) {
            val cached = withContext(Dispatchers.IO) { Services.offline.cachedListing(folderId) }
            if (cached != null) { listing = cached; offlineMode = true } else error = context.getString(R.string.offline_error, e.message ?: "")
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
    val title = known?.let { n -> if (n.parentId == null) stringResource(R.string.tab_files) else n.name } ?: ""
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    if (known?.parentId != null) IconButton(onClick = { nav.popBackStack() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) }
                },
                actions = {
                    IconButton(onClick = { nav.navigate("search") }) { Icon(Icons.Outlined.Search, stringResource(R.string.search)) }
                    ViewActions(grid, sort, onGrid = { grid = it; viewPrefs.grid = it }, onSort = { sort = it; viewPrefs.sort = it })
                },
            )
        },
        floatingActionButton = {
            if (canEdit && !selecting) Box {
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
                    DropdownMenuItem({ Text(stringResource(R.string.new_text_file)) }, leadingIcon = { Icon(Icons.Outlined.NoteAdd, null) }, onClick = {
                        menuOpen = false; newTextFile = true
                    })
                }
            }
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            if (offlineMode) Text(stringResource(R.string.offline_mode), Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
                color = MaterialTheme.colorScheme.outline, style = MaterialTheme.typography.labelMedium)
            if (listing?.perm == "read") Text(stringResource(R.string.read_only_folder), Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                color = MaterialTheme.colorScheme.outline, style = MaterialTheme.typography.labelMedium)
            uploads.name?.let { name ->
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                    Text(stringResource(R.string.uploading_name, name, uploads.remaining), style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    LinearProgressIndicator(progress = { uploads.progress }, modifier = Modifier.fillMaxWidth().padding(top = 4.dp))
                }
            }
            if (sharedUris.value.isNotEmpty() && canEdit) {
                ListItem(
                    headlineContent = { Text(stringResource(R.string.upload_shared_here, sharedUris.value.size)) },
                    leadingContent = { Icon(Icons.Outlined.UploadFile, null) },
                    trailingContent = {
                        Row {
                            TextButton(onClick = { sharedUris.value = emptyList() }) { Text(stringResource(R.string.dismiss)) }
                            TextButton(onClick = { val u = sharedUris.value; sharedUris.value = emptyList(); startUpload(u) }) { Text(stringResource(R.string.upload)) }
                        }
                    },
                )
            }
            PullToRefreshBox(isRefreshing = refreshing, onRefresh = { scope.launch { refreshing = true; load(); refreshing = false } }) {
                val l = listing
                when {
                    error != null && l == null -> EmptyState(Icons.Outlined.CloudOff, error!!)
                    l == null -> Loading()
                    l.children.isNullOrEmpty() -> EmptyState(Icons.Outlined.FolderOpen, stringResource(if (canEdit) R.string.empty_folder_tap else R.string.empty_folder))
                    else -> NodeList(sortNodes(l.children!!, sort), nav, canModify = { canEdit }, reload = reload, scope = scope, grid = grid,
                        onSelecting = { selecting = it })
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
    grid: Boolean = false,
    onSelecting: (Boolean) -> Unit = {},
) {
    val context = LocalContext.current
    val haptics = LocalHapticFeedback.current
    // The open actions sheet (and its dialog, see NodeActions) survives rotation.
    var sheetFor by rememberSaveable(stateSaver = jsonSaver<FileNode>()) { mutableStateOf<FileNode?>(null) }
    // Selected ids survive rotation; files that disappear (deleted on another device) drop out by themselves.
    var selectedIds by rememberSaveable { mutableStateOf(listOf<Long>()) }
    val selected = remember(selectedIds, items) { items.filter { it.id in selectedIds } }
    val selecting = selected.isNotEmpty()
    var bulk by rememberSaveable { mutableStateOf<String?>(null) }
    LaunchedEffect(selecting) { onSelecting(selecting) }
    BackHandler(selecting) { selectedIds = emptyList() }

    fun toggle(n: FileNode) { selectedIds = if (n.id in selectedIds) selectedIds - n.id else selectedIds + n.id }
    fun longPress(n: FileNode) {
        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
        if (selecting) toggle(n) else sheetFor = n
    }
    val open: (FileNode) -> Unit = { if (selecting) toggle(it) else openNode(nav, it) }
    /** Runs [action] on each node, then clears the selection and reloads; failures are counted, not fatal. */
    fun bulkAct(nodes: List<FileNode>, action: suspend (FileNode) -> Unit) {
        selectedIds = emptyList()
        scope.launch {
            val failed = nodes.count { n -> runCatching { action(n) }.isFailure }
            if (failed > 0) toast(context, context.getString(R.string.n_failed, failed))
            reload()
        }
    }
    val modifiable = selected.filter(canModify)

    Box(Modifier.fillMaxSize()) {
        if (grid) NodeGrid(items, onOpen = open, onActions = { longPress(it) }, selected = if (selecting) selectedIds.toSet() else null)
        else LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = if (selecting) 80.dp else 0.dp)) {
            items(items, key = { it.id }) { node ->
                val isSelected = node.id in selectedIds
                ListItem(
                    modifier = Modifier.combinedClickable(onClick = { open(node) }, onLongClick = { longPress(node) }),
                    colors = if (isSelected) ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.secondaryContainer) else ListItemDefaults.colors(),
                    leadingContent = { if (selecting) Checkbox(isSelected, onCheckedChange = { toggle(node) }) else FileTile(node) },
                    headlineContent = { Text(node.name, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium) },
                    supportingContent = {
                        Text(subtitle(node) ?: listOfNotNull(formatWhen(node.mtime).ifEmpty { null }, if (node.isDir) null else formatSize(node.size)).joinToString(" · "),
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                    },
                    trailingContent = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            if (node.favorite) Icon(Icons.Filled.Star, null, tint = androidx.compose.ui.graphics.Color(0xFFE5A50A), modifier = Modifier.size(16.dp))
                            if (Services.offline.isPinned(node.id)) Icon(Icons.Outlined.CloudDone, stringResource(R.string.available_offline), tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(16.dp))
                            if (node.shared) Icon(Icons.Outlined.Share, stringResource(R.string.shared), tint = MaterialTheme.colorScheme.outline, modifier = Modifier.size(16.dp))
                            if (!selecting) IconButton(onClick = { sheetFor = node }) { Icon(Icons.Outlined.MoreVert, stringResource(R.string.actions_for, node.name)) }
                        }
                    },
                )
            }
        }
        if (selecting) SelectionBar(
            count = selected.size,
            modifier = Modifier.align(Alignment.BottomCenter),
            onClose = { selectedIds = emptyList() },
            onSelectAll = { selectedIds = items.map { it.id } },
            onSend = {
                val files = selected.filter { !it.isDir }
                if (files.isEmpty()) toast(context, context.getString(R.string.send_files_only))
                else scope.launch { runCatching { sendManyToApp(context, files) }.onFailure { toast(context, it.message ?: context.getString(R.string.failed)) } }
            },
            onFavorite = { bulkAct(selected.filter { !it.favorite }) { Services.api.setFavorite(it.id, true) } },
            onMove = if (modifiable.isEmpty()) null else ({ bulk = "move" }),
            onDelete = if (modifiable.isEmpty()) null else ({ bulk = "delete" }),
        )
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
    val me by Services.session.user.collectAsStateWithLifecycle()
    val isOwner = node.owner == me?.id
    var dialog by rememberSaveable { mutableStateOf<String?>(null) }
    val saveAs = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(node.mime.ifEmpty { "application/octet-stream" })) { uri ->
        if (uri != null) scope.launch {
            try {
                val tmp = File(context.cacheDir, "save-${node.id}")
                Services.api.download(node.id, tmp)
                withContext(Dispatchers.IO) {
                    context.contentResolver.openOutputStream(uri)?.use { out -> tmp.inputStream().use { it.copyTo(out) } }
                    tmp.delete()
                }
                toast(context, context.getString(R.string.saved))
            } catch (e: Exception) { toast(context, e.message ?: context.getString(R.string.failed)) }
        }
    }

    fun act(block: suspend () -> Unit) {
        onClose()
        scope.launch {
            try { block() } catch (e: Exception) { toast(context, e.message ?: context.getString(R.string.failed)) }
            reload()
        }
    }

    if (dialog == null) ModalBottomSheet(onDismissRequest = onClose) {
        Text(node.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp), maxLines = 2)
        HorizontalDivider()
        @Composable
        fun Item(label: Int, icon: androidx.compose.ui.graphics.vector.ImageVector, danger: Boolean = false, onClick: () -> Unit) =
            ListItem(
                modifier = Modifier.clickable(onClick = onClick),
                leadingContent = { Icon(icon, null, tint = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant) },
                headlineContent = { Text(stringResource(label), color = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface) },
            )
        val failed = stringResource(R.string.failed)
        onSelect?.let { select -> Item(R.string.select, Icons.Outlined.CheckCircle) { onClose(); select() } }
        if (!node.isDir) Item(R.string.send_to, Icons.AutoMirrored.Outlined.Send) { onClose(); scope.launch { runCatching { sendToApp(context, node) }.onFailure { toast(context, it.message ?: failed) } } }
        if (!node.isDir) Item(R.string.open_with, Icons.AutoMirrored.Outlined.OpenInNew) { onClose(); scope.launch { runCatching { openExternally(context, node) }.onFailure { toast(context, it.message ?: failed) } } }
        Item(if (node.isDir) R.string.save_as_zip else R.string.save_to_device, Icons.Outlined.Download) { onClose(); saveAs.launch(node.name + if (node.isDir) ".zip" else "") }
        if (Services.offline.isPinned(node.id)) Item(R.string.remove_offline, Icons.Outlined.CloudOff) { act { Services.offline.unpin(node.id) } }
        else Item(R.string.make_offline, Icons.Outlined.DownloadForOffline) { act { Services.offline.pin(node); toast(context, context.getString(R.string.available_offline)) } }
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
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.share_link)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.link_anyone, node.name))
                OutlinedTextField(password, { password = it }, label = { Text(stringResource(R.string.link_password)) }, singleLine = true)
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
            TextButton(enabled = !busy, onClick = {
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
                            leadingContent = { Icon(if (link) Icons.Outlined.Link else Icons.Outlined.PersonAdd, null) },
                            headlineContent = { Text(if (link) stringResource(R.string.public_link) else (sh.shareWith ?: ""), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                            supportingContent = {
                                Text(listOfNotNull(
                                    if (sh.canEdit) stringResource(R.string.share_can_edit) else if (link) null else stringResource(R.string.share_read_only),
                                    if (sh.hasPassword) stringResource(R.string.share_password) else null,
                                    sh.expiresAt?.let { stringResource(R.string.share_expires, formatDate(it)) },
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
    var suggestions by remember { mutableStateOf<List<Pair<String, String>>>(emptyList()) }
    LaunchedEffect(target) {
        delay(250) // one lookup per pause in typing, not per letter
        if (target.length >= 1) runCatching { Services.api.sharees(target.removePrefix("group:")) }.onSuccess { s ->
            suggestions = s.users.map { it.id to it.displayName } + s.groups.map { "group:${it.id}" to context.getString(R.string.group_name, it.id) }
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.share_people)) },
        text = {
            Column {
                OutlinedTextField(target, { target = it }, label = { Text(stringResource(R.string.username_or_group)) }, singleLine = true)
                suggestions.take(5).forEach { (id, label) ->
                    Text("$label ($id)", Modifier.fillMaxWidth().clickable { target = id }.padding(vertical = 8.dp))
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
fun NodeListScreen(nav: NavController, kind: String) {
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
        TopAppBar(title = { Text(title) }, navigationIcon = { IconButton(onClick = { nav.popBackStack() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) } })
    }) { pad ->
        Box(Modifier.padding(pad)) {
            val list = items
            when {
                error != null && list == null -> EmptyState(Icons.Outlined.CloudOff, error!!)
                list == null -> Loading()
                list.isEmpty() -> EmptyState(Icons.Outlined.FolderOpen, stringResource(R.string.nothing_here))
                else -> NodeList(list, nav, canModify = { it.owner == me?.id }, reload = { scope.launch { load() } }, scope = scope, subtitle = { n ->
                    when (kind) {
                        "shared-in" -> context.getString(if (n.canEdit == true) R.string.from_owner_can_edit else R.string.from_owner, n.ownerName ?: n.owner)
                        "shared-out" -> context.getString(R.string.with_targets, outgoing[n.id] ?: "")
                        else -> null
                    }
                })
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
            title = { OutlinedTextField(q, { q = it }, placeholder = { Text(stringResource(R.string.search_files)) }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(end = 8.dp).focusRequester(focus)) },
            navigationIcon = { IconButton(onClick = { nav.popBackStack() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) } },
        )
    }) { pad ->
        Column(Modifier.padding(pad)) {
            TypeFilterRow(filter) { filter = it }
            val shown = results.filter(filter.matches)
            when {
                q.isNotBlank() && searched != q.trim() && shown.isEmpty() -> Loading()
                error != null && q.isNotBlank() -> EmptyState(Icons.Outlined.CloudOff, error!!)
                q.isNotBlank() && shown.isEmpty() -> EmptyState(Icons.Outlined.Search, stringResource(R.string.no_matches))
                // Results include files shared with you: only your own can be renamed, moved or deleted (as in Recent).
                else -> NodeList(shown, nav, canModify = { it.owner == me?.id }, reload = { reloadKey++ }, scope = scope, subtitle = { it.path })
            }
        }
    }
}

@Suppress("unused")
private val keepWidth = Modifier.width(0.dp)
