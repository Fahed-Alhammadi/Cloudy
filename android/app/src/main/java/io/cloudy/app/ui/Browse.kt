package io.cloudy.app.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.clickable
import android.app.Activity
import android.content.Context
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.StringRes
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Sort
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.outlined.CloudDone
import androidx.compose.material.icons.outlined.GridView
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.automirrored.outlined.ViewList
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult
import io.cloudy.app.R
import io.cloudy.app.Services
import io.cloudy.app.data.FileNode
import java.text.Collator
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.outlined.Circle

// ---------------------------------------------------------------- list / grid and sort order

/** How folders are shown on this phone: list or grid, and the sort order (folders always first). */
class ViewPrefs(context: Context) {
    private val prefs = context.getSharedPreferences("view", Context.MODE_PRIVATE)
    var grid: Boolean
        get() = prefs.getBoolean("grid", false)
        set(v) = prefs.edit().putBoolean("grid", v).apply()
    var sort: String
        get() = prefs.getString("sort", "name") ?: "name"
        set(v) = prefs.edit().putString("sort", v).apply()
}

val SORTS = listOf("name" to R.string.sort_name, "modified" to R.string.sort_modified, "size" to R.string.sort_size)

fun sortNodes(items: List<FileNode>, sort: String): List<FileNode> {
    val collator = Collator.getInstance() // the language's alphabet order (accents, Arabic…)
    val byKey: Comparator<FileNode> = when (sort) {
        "modified" -> compareByDescending { it.mtime }
        "size" -> compareByDescending { it.size }
        else -> Comparator { a, b -> collator.compare(a.name, b.name) }
    }
    return items.sortedWith(compareByDescending<FileNode> { it.isDir }.then(byKey))
}

/** Top-bar buttons: switch list/grid and pick the sort order. */
@Composable
fun ViewActions(grid: Boolean, sort: String, onGrid: (Boolean) -> Unit, onSort: (String) -> Unit) {
    var menu by remember { mutableStateOf(false) }
    IconButton(onClick = { onGrid(!grid) }) {
        if (grid) Icon(Icons.AutoMirrored.Outlined.ViewList, stringResource(R.string.view_list))
        else Icon(Icons.Outlined.GridView, stringResource(R.string.view_grid))
    }
    Box {
        IconButton(onClick = { menu = true }) { Icon(Icons.AutoMirrored.Outlined.Sort, stringResource(R.string.sort)) }
        DropdownMenu(menu, { menu = false }) {
            SORTS.forEach { (key, label) ->
                DropdownMenuItem({ Text(stringResource(label)) }, leadingIcon = { RadioButton(sort == key, null) },
                    onClick = { menu = false; onSort(key) })
            }
        }
    }
}

/** Tiles with image thumbnails; tap opens, long-press or ⋮ shows the actions. [selected] non-null = selection mode. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun NodeGrid(items: List<FileNode>, onOpen: (FileNode) -> Unit, onActions: (FileNode) -> Unit, selected: Set<Long>? = null) {
    // Bigger tiles on tablets (a 10-inch screen would otherwise show ten tiny columns).
    LazyVerticalGrid(GridCells.Adaptive(if (wideWindow()) 148.dp else 112.dp), Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 8.dp, top = 8.dp, end = 8.dp, bottom = 88.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items(items, key = { it.id }) { node ->
            val isSelected = selected?.contains(node.id) == true
            val isImage = node.mime.startsWith("image/") && node.size in 1..20_000_000
            val tileColor by animateColorAsState(if (isSelected) MaterialTheme.colorScheme.secondaryContainer else androidx.compose.ui.graphics.Color.Transparent, label = "tile")
            Column(Modifier.animateItem().clip(RoundedCornerShape(18.dp))
                .background(tileColor)
                .combinedClickable(onClick = { onOpen(node) }, onLongClick = { onActions(node) })
                // While selecting, TalkBack says whether each tile is ticked (the list rows have a checkbox for it).
                .then(if (selected != null) Modifier.semantics { this.selected = isSelected } else Modifier)
                .padding(4.dp)) {
                Box(Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(16.dp))
                    .background(iconFor(node).second.forTheme().copy(alpha = if (isSystemInDarkTheme()) 0.22f else 0.12f)),
                    contentAlignment = Alignment.Center) {
                    // Thumbnails for images (Coil downsamples and caches); other types show their icon.
                    if (isImage) {
                        val model: Any = Services.offline.localFile(node) ?: Services.api.downloadUrl(node.id, inline = true)
                        AsyncImage(model, node.name, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
                    } else FileIcon(node, Modifier.fillMaxSize(0.4f))
                    // Badges and the ⋮ button sit on small discs, so they stay readable on any photo.
                    val disc = MaterialTheme.colorScheme.surface.copy(alpha = 0.86f)
                    val pinned = Services.offline.isPinned(node.id)
                    if (node.favorite || pinned) Row(Modifier.align(Alignment.TopStart).padding(6.dp).clip(CircleShape).background(disc).padding(4.dp),
                        horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        if (node.favorite) Icon(Icons.Filled.Star, null, tint = FavoriteColor, modifier = Modifier.size(16.dp))
                        if (pinned) Icon(Icons.Outlined.CloudDone, stringResource(R.string.available_offline), tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(16.dp))
                    }
                    if (selected != null) Icon(
                        if (isSelected) Icons.Filled.CheckCircle else Icons.Outlined.Circle, null,
                        tint = if (isSelected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline,
                        modifier = Modifier.align(Alignment.TopEnd).padding(6.dp).clip(CircleShape).background(disc).size(24.dp),
                    // 48 dp to tap, a 28 dp disc to look at.
                    ) else Box(Modifier.align(Alignment.TopEnd).size(48.dp).clip(CircleShape).clickable(role = androidx.compose.ui.semantics.Role.Button) { onActions(node) },
                        contentAlignment = Alignment.Center) {
                        Box(Modifier.size(28.dp).clip(CircleShape).background(if (isImage) disc else androidx.compose.ui.graphics.Color.Transparent), contentAlignment = Alignment.Center) {
                            Icon(Icons.Outlined.MoreVert, stringResource(R.string.actions_for, node.name), tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
                        }
                    }
                }
                Text(node.name, Modifier.fillMaxWidth().padding(top = 4.dp), maxLines = 2, overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center, style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

// ---------------------------------------------------------------- search filters

private val DOCUMENT = Regex("pdf|^text/|json|xml|msword|officedocument|opendocument|rtf|presentation|spreadsheet")

enum class TypeFilter(@StringRes val label: Int, val matches: (FileNode) -> Boolean) {
    ALL(R.string.filter_all, { true }),
    FOLDERS(R.string.filter_folders, { it.isDir }),
    IMAGES(R.string.filter_images, { it.mime.startsWith("image/") }),
    VIDEOS(R.string.filter_videos, { it.mime.startsWith("video/") }),
    AUDIO(R.string.filter_audio, { it.mime.startsWith("audio/") }),
    DOCUMENTS(R.string.filter_documents, { !it.isDir && DOCUMENT.containsMatchIn(it.mime) }),
}

@Composable
fun TypeFilterRow(selected: TypeFilter, onSelect: (TypeFilter) -> Unit) {
    Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        TypeFilter.entries.forEach { f -> FilterChip(selected == f, { onSelect(f) }, label = { Text(stringResource(f.label)) }) }
    }
}

// ---------------------------------------------------------------- document scanner

/**
 * Google's document scanner (Play services): edge detection, cleanup, several pages → one PDF.
 * It runs in its own screen, so the app needs no camera permission. Returns a function that starts it.
 */
@Composable
fun rememberDocumentScanner(onPdf: (Uri) -> Unit): () -> Unit {
    val context = LocalContext.current
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { r ->
        if (r.resultCode == Activity.RESULT_OK) GmsDocumentScanningResult.fromActivityResultIntent(r.data)?.pdf?.uri?.let(onPdf)
    }
    val client = remember {
        GmsDocumentScanning.getClient(GmsDocumentScannerOptions.Builder()
            .setGalleryImportAllowed(true)
            .setResultFormats(GmsDocumentScannerOptions.RESULT_FORMAT_PDF)
            .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL)
            .build())
    }
    return {
        val activity = context.findActivity()
        if (activity != null) client.getStartScanIntent(activity)
            .addOnSuccessListener { launcher.launch(IntentSenderRequest.Builder(it).build()) }
            .addOnFailureListener { toast(context, context.getString(R.string.scan_unavailable, it.message ?: "")) }
    }
}
