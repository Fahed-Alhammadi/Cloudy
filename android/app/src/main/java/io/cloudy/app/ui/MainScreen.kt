package io.cloudy.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material3.ListItemDefaults
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import android.net.Uri
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import io.cloudy.app.data.AppLock
import io.cloudy.app.data.Lang
import io.cloudy.app.data.Live
import io.cloudy.app.data.Office
import io.cloudy.app.R
import androidx.compose.ui.res.stringResource
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.Fingerprint
import androidx.compose.material.icons.outlined.Language
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.automirrored.outlined.HelpOutline
import androidx.compose.material.icons.outlined.Feedback
import androidx.compose.material.icons.outlined.StarRate
import androidx.compose.material.icons.outlined.AccessTime
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.CloudDone
import androidx.compose.material.icons.outlined.Contacts
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.People
import androidx.compose.material.icons.outlined.PersonRemove
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material.icons.outlined.Star
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import io.cloudy.app.BuildConfig
import io.cloudy.app.Services
import io.cloudy.app.work.BackupSettings
import io.cloudy.app.work.Jobs
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import androidx.compose.runtime.produceState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import java.text.DateFormat
import java.util.Date

private const val NAV_MS = 180

private data class Tab(val route: String, val label: Int, val icon: androidx.compose.ui.graphics.vector.ImageVector)

@Composable
fun MainScreen(sharedUris: MutableState<List<Uri>>) {
    val nav = rememberNavController()
    val rootId = Services.session.user.value?.rootId ?: 0
    val tabs = listOf(
        Tab("files/$rootId", R.string.tab_files, Icons.Outlined.Folder),
        Tab("calendar", R.string.tab_calendar, Icons.Outlined.CalendarMonth),
        Tab("contacts", R.string.tab_contacts, Icons.Outlined.Contacts),
        Tab("more", R.string.more, Icons.Outlined.Menu),
    )
    // Live updates while the app is visible; office file types once per session.
    val lifecycleOwner = LocalLifecycleOwner.current
    val activity = LocalContext.current.findActivity()
    LaunchedEffect(lifecycleOwner) {
        // A language chosen for the account (on the web, or before this phone signed in) applies here too.
        runCatching { Services.api.me() }.onSuccess { me -> activity?.let { Lang.followAccount(it, me.id, me.language) } }
        Office.load(Services.api)
        lifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) { Live.run(Services.api) }
    }
    val entry by nav.currentBackStackEntryAsState()
    val route = entry?.destination?.route
    val currentFolder = entry?.arguments?.getLong("id")
    val showBar = route == "calendar" || route == "contacts" || route == "more" || (route == "files/{id}" && currentFolder == rootId)

    Scaffold(bottomBar = {
        if (showBar) NavigationBar {
            tabs.forEach { t ->
                val selected = if (t.route.startsWith("files/")) route == "files/{id}" else route == t.route
                NavigationBarItem(selected = selected, icon = { Icon(t.icon, null) }, label = { Text(stringResource(t.label)) }, onClick = {
                    nav.navigate(t.route) {
                        popUpTo(nav.graph.findStartDestination().id) { saveState = true }
                        launchSingleTop = true
                        restoreState = true
                    }
                })
            }
        }
    }) { pad ->
        // Short transitions: the library default is a 700 ms cross-fade, which makes every tap feel slow.
        NavHost(nav, startDestination = "files/$rootId", modifier = Modifier.padding(bottom = pad.calculateBottomPadding()),
            enterTransition = { fadeIn(tween(NAV_MS)) + slideInHorizontally(tween(NAV_MS)) { it / 12 } },
            exitTransition = { fadeOut(tween(NAV_MS / 2)) },
            popEnterTransition = { fadeIn(tween(NAV_MS)) },
            popExitTransition = { fadeOut(tween(NAV_MS / 2)) + slideOutHorizontally(tween(NAV_MS)) { it / 12 } },
        ) {
            composable("files/{id}", arguments = listOf(navArgument("id") { type = NavType.LongType })) {
                FolderScreen(nav, it.arguments!!.getLong("id"), sharedUris)
            }
            composable("preview/{id}", arguments = listOf(navArgument("id") { type = NavType.LongType })) {
                PreviewScreen(nav, it.arguments!!.getLong("id"))
            }
            composable("list/{kind}") { NodeListScreen(nav, it.arguments!!.getString("kind")!!) }
            composable("search") { SearchScreen(nav) }
            composable("trash") { TrashScreen(nav) }
            composable("calendar") { CalendarScreen() }
            composable("contacts") { ContactsScreen() }
            composable("more") { MoreScreen(nav) }
            composable("backup") { BackupScreen(nav) }
            composable("devices") { DevicesScreen(nav) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MoreScreen(nav: NavController) {
    val context = LocalContext.current
    // Observed, so the storage numbers refreshed by /api/me below show without leaving the screen.
    val u by Services.session.user.collectAsStateWithLifecycle()
    var confirmLogout by remember { mutableStateOf(false) }
    var deleteAccount by rememberSaveable { mutableStateOf(false) }
    var chooseLanguage by remember { mutableStateOf(false) }
    var lockOn by remember { mutableStateOf(AppLock.isEnabled(context)) }
    LaunchedEffect(Unit) {
        runCatching { Services.api.me() }.onSuccess { me ->
            val known = Services.session.user.value ?: return@onSuccess // signed out meanwhile
            Services.session.updateUser(me.copy(rootId = me.rootId.takeIf { r -> r > 0 } ?: known.rootId))
        }
    }

    Scaffold(topBar = { TopAppBar(title = { Text(stringResource(R.string.more)) }) }) { pad ->
        Column(Modifier.padding(pad).verticalScroll(rememberScrollState()).padding(bottom = 16.dp)) {
            val itemColors = ListItemDefaults.colors(containerColor = Color.Transparent)
            @Composable
            fun Group(content: @Composable () -> Unit) =
                Column(Modifier.padding(horizontal = 16.dp, vertical = 6.dp).fillMaxWidth().clip(RoundedCornerShape(24.dp))
                    .background(MaterialTheme.colorScheme.surfaceContainerLowest)) { content() }
            // Each entry has its own color, like Android's Settings: a pastel circle with the glyph in the deeper shade.
            @Composable
            fun Badge(icon: androidx.compose.ui.graphics.vector.ImageVector, color: Color, bg: Color? = null) {
                val tint = if (bg != null) color else color.forTheme()
                Box(Modifier.size(36.dp).clip(CircleShape).background(bg ?: tint.copy(alpha = if (isSystemInDarkTheme()) 0.22f else 0.14f)),
                    contentAlignment = Alignment.Center) { Icon(icon, null, tint = tint, modifier = Modifier.size(20.dp)) }
            }
            @Composable
            fun Entry(label: Int, icon: androidx.compose.ui.graphics.vector.ImageVector, color: Color, route: String) =
                ListItem(modifier = Modifier.clickable { nav.navigate(route) }, colors = itemColors, leadingContent = { Badge(icon, color) },
                    headlineContent = { Text(stringResource(label)) },
                    trailingContent = { Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null, tint = MaterialTheme.colorScheme.outline) })

            Group {
                Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Avatar(u?.displayName ?: "", 56.dp)
                    Column(Modifier.padding(start = 16.dp).weight(1f)) {
                        Text(u?.displayName ?: "", style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("${u?.id} · ${Services.session.server.substringAfter("://")}", style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                val used = u?.used ?: 0
                val quota = u?.quotaBytes
                Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp)) {
                    if (quota != null && quota > 0) LinearProgressIndicator(progress = { (used.toFloat() / quota).coerceIn(0f, 1f) },
                        modifier = Modifier.fillMaxWidth().height(8.dp).clip(RoundedCornerShape(4.dp)), drawStopIndicator = {}, gapSize = 0.dp)
                    Text(if (quota != null) stringResource(R.string.storage_used_of, formatSize(used), formatSize(quota)) else stringResource(R.string.storage_used, formatSize(used)),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
                }
            }
            Group {
                Entry(R.string.recent, Icons.Outlined.AccessTime, SettingColor.Blue, "list/recent")
                Entry(R.string.favorites, Icons.Outlined.Star, SettingColor.Orange, "list/favorites")
                Entry(R.string.shared_with_you, Icons.Outlined.People, SettingColor.Green, "list/shared-in")
                Entry(R.string.shared_by_you, Icons.Outlined.Share, SettingColor.Teal, "list/shared-out")
                Entry(R.string.available_offline, Icons.Outlined.CloudDone, SettingColor.Purple, "list/offline")
                Entry(R.string.deleted_files, Icons.Outlined.Delete, SettingColor.Gray, "trash")
            }
            Group {
                Entry(R.string.photo_backup, Icons.Outlined.PhotoCamera, SettingColor.Pink, "backup")
            }
            Text(stringResource(R.string.section_security), Modifier.padding(start = 32.dp, top = 14.dp, bottom = 2.dp),
                style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
            Group {
                ListItem(
                    modifier = Modifier.clickable { chooseLanguage = true }, colors = itemColors,
                    leadingContent = { Badge(Icons.Outlined.Language, SettingColor.Blue) },
                    headlineContent = { Text(stringResource(R.string.language)) },
                    supportingContent = { Text(Lang.current(context)?.let { Lang.NAMES[it] } ?: stringResource(R.string.language_system)) },
                )
                val lockAvailable = remember { AppLock.isAvailable(context) }
                val confirmTitle = stringResource(R.string.app_lock_turn_on)
                ListItem(
                    modifier = Modifier.toggleRow(lockOn, enabled = lockAvailable || lockOn) { on ->
                        if (!on) { AppLock.setEnabled(context, false); lockOn = false }
                        // Turning it on asks once, so nobody locks themselves out by accident.
                        else context.findActivity()?.let { AppLock.confirm(it, confirmTitle) { AppLock.setEnabled(context, true); lockOn = true } }
                    },
                    colors = itemColors,
                    leadingContent = { Badge(Icons.Outlined.Fingerprint, SettingColor.Green) },
                    headlineContent = { Text(stringResource(R.string.app_lock)) },
                    supportingContent = { Text(stringResource(if (lockAvailable || lockOn) R.string.app_lock_summary else R.string.app_lock_unavailable)) },
                    trailingContent = { Switch(lockOn, onCheckedChange = null, enabled = lockAvailable || lockOn) },
                )
                Entry(R.string.devices, Icons.Outlined.Devices, SettingColor.Indigo, "devices")
            }
            Text(stringResource(R.string.section_support), Modifier.padding(start = 32.dp, top = 14.dp, bottom = 2.dp),
                style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
            Group {
                // Web pages open in the browser (no arrow: they leave the app).
                @Composable
                fun Link(label: Int, icon: androidx.compose.ui.graphics.vector.ImageVector, color: Color, open: () -> Unit) =
                    ListItem(modifier = Modifier.clickable(onClick = open), colors = itemColors, leadingContent = { Badge(icon, color) },
                        headlineContent = { Text(stringResource(label)) })
                Link(R.string.help, Icons.AutoMirrored.Outlined.HelpOutline, SettingColor.Blue) { openUrl(context, HELP_URL) }
                Link(R.string.send_feedback, Icons.Outlined.Feedback, SettingColor.Green) { openUrl(context, FEEDBACK_URL) }
                Link(R.string.rate_app, Icons.Outlined.StarRate, SettingColor.Pink) { openStoreListing(context) }
            }
            Group {
                ListItem(
                    modifier = Modifier.clickable { confirmLogout = true }, colors = itemColors,
                    leadingContent = { Badge(Icons.AutoMirrored.Outlined.Logout, MaterialTheme.colorScheme.error, MaterialTheme.colorScheme.errorContainer) },
                    headlineContent = { Text(stringResource(R.string.log_out), color = MaterialTheme.colorScheme.error) },
                )
                ListItem(
                    modifier = Modifier.clickable { deleteAccount = true }, colors = itemColors,
                    leadingContent = { Badge(Icons.Outlined.PersonRemove, MaterialTheme.colorScheme.error, MaterialTheme.colorScheme.errorContainer) },
                    headlineContent = { Text(stringResource(R.string.delete_account), color = MaterialTheme.colorScheme.error) },
                )
            }
            // Adding up the offline folder reads the disk: done in the background, shown when ready.
            val offlineBytes by produceState<Long?>(null) { value = withContext(Dispatchers.IO) { Services.offline.usedBytes() } }
            Text(listOfNotNull(stringResource(R.string.version, BuildConfig.VERSION_NAME),
                offlineBytes?.let { stringResource(R.string.offline_storage, formatSize(it)) }).joinToString("\n"),
                Modifier.fillMaxWidth().padding(16.dp), textAlign = TextAlign.Center,
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline)
        }
    }
    if (chooseLanguage) LanguageDialog { chooseLanguage = false }
    if (deleteAccount) DeleteAccountDialog { deleteAccount = false }
    if (confirmLogout) ConfirmDialog(stringResource(R.string.log_out), stringResource(R.string.log_out_text), stringResource(R.string.log_out), { confirmLogout = false }) {
        confirmLogout = false
        // Signed out at once; the token is revoked in the background (no waiting for a slow or missing network).
        val server = Services.session.server
        Services.session.signOut()?.let { token -> Services.appScope.launch { Services.api.revoke(server, token) } }
    }
}

/**
 * Deletes the account and everything in it (App Store / Google Play rule: users can delete their account in the app).
 * Same wording and flow as the web and iPhone apps: explain what goes, confirm with the password, then sign out and
 * remove what this phone kept (offline copies, photo backup).
 */
@Composable
fun DeleteAccountDialog(onDismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var password by rememberSaveable { mutableStateOf("") }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val done = stringResource(R.string.delete_account_done)
    val unsupported = stringResource(R.string.delete_account_unsupported)
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(stringResource(R.string.delete_account_title)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text(stringResource(R.string.delete_account_text))
                PasswordField(
                    password, { password = it; error = null }, stringResource(R.string.delete_account_password),
                    Modifier.fillMaxWidth().padding(top = 16.dp), enabled = !busy,
                    isError = error != null, supportingText = error?.let { { Text(it) } },
                )
            }
        },
        confirmButton = {
            TextButton(enabled = password.isNotEmpty() && !busy, onClick = {
                busy = true
                scope.launch {
                    try {
                        Services.api.deleteAccount(password)
                        BackupSettings(context).enabled = false
                        Jobs.schedule(context) // cancels the backup job
                        Services.offline.clearAll()
                        Services.session.signOut()
                        toast(context, done)
                    } catch (e: Exception) {
                        // Servers before 1.12 have no self-service deletion.
                        error = if ((e as? io.cloudy.app.data.ApiException)?.status == 404) unsupported else e.message ?: e.toString()
                    } finally {
                        busy = false
                    }
                }
            }) { Text(stringResource(R.string.delete_account), color = MaterialTheme.colorScheme.error) }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text(stringResource(R.string.cancel)) } },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BackupScreen(nav: NavController) {
    val context = LocalContext.current
    val settings = remember { BackupSettings(context) }
    // The switch stays on while the "existing photos" question is open; both survive rotation.
    var enabled by rememberSaveable { mutableStateOf(settings.enabled) }
    var wifiOnly by remember { mutableStateOf(settings.wifiOnly) }
    var videos by remember { mutableStateOf(settings.includeVideos) }
    var folder by remember { mutableStateOf(settings.folder) }
    var askExisting by rememberSaveable { mutableStateOf(false) }

    fun apply() {
        settings.enabled = enabled; settings.wifiOnly = wifiOnly; settings.includeVideos = videos
        settings.folder = folder.trim().ifEmpty { "Camera Uploads" }
        Jobs.schedule(context)
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        if (granted.values.all { it }) askExisting = true
        else { enabled = false; toast(context, context.getString(R.string.backup_permission_needed)) }
    }

    Scaffold(topBar = {
        TopAppBar(title = { Text(stringResource(R.string.photo_backup)) }, navigationIcon = { IconButton(onClick = { nav.popBackStack() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) } })
    }) { pad ->
        Column(Modifier.padding(pad).padding(horizontal = 8.dp)) {
            ListItem(headlineContent = { Text(stringResource(R.string.backup_auto)) }, supportingContent = { Text(stringResource(R.string.backup_auto_summary)) },
                modifier = Modifier.toggleRow(enabled) { on ->
                    if (on) {
                        enabled = true
                        if (Jobs.hasMediaPermission(context)) askExisting = true else permission.launch(Jobs.mediaPermissions())
                    } else { enabled = false; apply() }
                },
                trailingContent = { Switch(enabled, onCheckedChange = null) })
            ListItem(headlineContent = { Text(stringResource(R.string.backup_videos)) }, modifier = Modifier.toggleRow(videos) { videos = it; apply() },
                trailingContent = { Switch(videos, onCheckedChange = null) })
            ListItem(headlineContent = { Text(stringResource(R.string.backup_wifi)) }, modifier = Modifier.toggleRow(wifiOnly) { wifiOnly = it; apply() },
                trailingContent = { Switch(wifiOnly, onCheckedChange = null) })
            OutlinedTextField(folder, { folder = it; apply() }, label = { Text(stringResource(R.string.backup_folder)) }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp))
            Button(enabled = enabled, onClick = { apply(); Jobs.backupNow(context); toast(context, context.getString(R.string.backup_started)) }, modifier = Modifier.padding(16.dp)) { Text(stringResource(R.string.backup_now)) }
            if (settings.lastRun > 0) Text(stringResource(R.string.backup_last_run, DateFormat.getDateTimeInstance().format(Date(settings.lastRun)), settings.lastResult),
                Modifier.padding(horizontal = 16.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline)
        }
    }
    if (askExisting) AlertDialog(
        onDismissRequest = {},
        title = { Text(stringResource(R.string.backup_existing_title)) },
        text = { Text(stringResource(R.string.backup_existing_text)) },
        confirmButton = { TextButton(onClick = { askExisting = false; settings.lastAdded = 0; apply(); Jobs.backupNow(context) }) { Text(stringResource(R.string.backup_upload_all)) } },
        dismissButton = { TextButton(onClick = { askExisting = false; settings.lastAdded = System.currentTimeMillis() / 1000; apply() }) { Text(stringResource(R.string.backup_only_new)) } },
    )
}
