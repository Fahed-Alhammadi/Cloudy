package io.cloudy.app.ui

import android.content.Context
import android.content.ContextWrapper
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.PhoneAndroid
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import androidx.navigation.NavController
import io.cloudy.app.R
import io.cloudy.app.Services
import io.cloudy.app.data.AppLock
import io.cloudy.app.data.AppPassword
import io.cloudy.app.data.Lang
import kotlinx.coroutines.launch

/** The activity behind a Compose context (needed for the biometric prompt and the language switch). */
tailrec fun Context.findActivity(): FragmentActivity? = when (this) {
    is FragmentActivity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

/** Shown instead of the app while the app lock is on; asks for the fingerprint / face / screen lock at once. */
@Composable
fun LockScreen() {
    val activity = LocalContext.current.findActivity()
    val title = stringResource(R.string.locked_title)
    val subtitle = stringResource(R.string.unlock_subtitle)
    LaunchedEffect(Unit) { activity?.let { AppLock.unlock(it, title, subtitle) } }
    Scaffold { pad ->
        Box(Modifier.padding(pad).fillMaxSize(), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Icon(Icons.Filled.Lock, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(56.dp))
                Text(title, style = MaterialTheme.typography.titleLarge)
                Text(subtitle, color = MaterialTheme.colorScheme.outline, textAlign = TextAlign.Center)
                Button(onClick = { activity?.let { AppLock.unlock(it, title, subtitle) } }) { Text(stringResource(R.string.unlock)) }
            }
        }
    }
}

/**
 * Picks the app language (or the phone's). The choice is also saved to the account so Cloudy on the web
 * and its emails use it; the screen restarts in the new language.
 */
@Composable
fun LanguageDialog(onDismiss: () -> Unit) {
    val context = LocalContext.current
    val activity = context.findActivity()
    val current = remember { Lang.current(context) }
    fun choose(code: String?) {
        onDismiss()
        if (code == current || activity == null) return
        val userId = Services.session.user.value?.id
        if (userId != null) {
            Lang.savedToAccount(context, userId, code)
            // App scope: the activity is about to restart.
            Services.appScope.launch { runCatching { Services.api.setLanguage(code) } }
        }
        Lang.apply(activity, code)
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.language)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                @Composable
                fun Option(code: String?, label: String) =
                    ListItem(modifier = Modifier.clickable { choose(code) },
                        leadingContent = { RadioButton(selected = current == code, onClick = { choose(code) }) },
                        headlineContent = { Text(label) })
                Option(null, stringResource(R.string.language_system))
                Lang.CODES.forEach { Option(it, Lang.NAMES.getValue(it)) }
                Text(stringResource(R.string.language_note), Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline)
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) } },
    )
}

/** More → Devices & app passwords: every token signed in to the account, revocable (except this phone's). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DevicesScreen(nav: NavController) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var items by remember { mutableStateOf<List<AppPassword>?>(null) }
    var revoking by remember { mutableStateOf<AppPassword?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    suspend fun load() {
        runCatching { Services.api.appPasswords() }
            .onSuccess { items = it; loadError = null }
            .onFailure { if (items == null) loadError = it.message ?: context.getString(R.string.failed) else toast(context, it.message ?: context.getString(R.string.failed)) }
    }
    LaunchedEffect(Unit) { load() }

    Scaffold(topBar = {
        TopAppBar(title = { Text(stringResource(R.string.devices)) },
            navigationIcon = { IconButton(onClick = { nav.popBackStack() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) } })
    }) { pad ->
        Column(Modifier.padding(pad)) {
            Text(stringResource(R.string.devices_intro), Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline)
            val list = items
            when {
                list == null && loadError != null -> EmptyState(Icons.Outlined.CloudOff, loadError!!) { loadError = null; scope.launch { load() } }
                list == null -> Loading()
                list.isEmpty() -> EmptyState(Icons.Outlined.Devices, stringResource(R.string.no_devices))
                else -> LazyColumn {
                    items(list, key = { it.id }) { p ->
                        ListItem(
                            leadingContent = { Icon(if (p.current) Icons.Outlined.PhoneAndroid else Icons.Outlined.Devices, null) },
                            headlineContent = { Text(if (p.current) "${p.name} · ${stringResource(R.string.this_device)}" else p.name) },
                            supportingContent = {
                                Text(listOf(
                                    stringResource(R.string.device_added, formatDate(p.createdAt)),
                                    p.lastUsedAt?.let { stringResource(R.string.device_last_used, formatDate(it)) } ?: stringResource(R.string.device_never_used),
                                ).joinToString("\n"))
                            },
                            // This phone signs out with More → Log out instead.
                            trailingContent = { if (!p.current) TextButton(onClick = { revoking = p }) { Text(stringResource(R.string.revoke), color = MaterialTheme.colorScheme.error) } },
                        )
                    }
                }
            }
        }
    }
    revoking?.let { p ->
        ConfirmDialog(stringResource(R.string.revoke_title), stringResource(R.string.revoke_text, p.name), stringResource(R.string.revoke), { revoking = null }) {
            revoking = null
            scope.launch {
                runCatching { Services.api.revokeAppPassword(p.id) }.onFailure { toast(context, it.message ?: context.getString(R.string.failed)) }
                load()
            }
        }
    }
}
