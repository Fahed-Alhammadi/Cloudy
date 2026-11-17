package io.cloudy.app.ui

import android.content.Context
import android.content.ContextWrapper
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.PhoneAndroid
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import androidx.navigation.NavController
import io.cloudy.app.R
import io.cloudy.app.Services
import io.cloudy.app.data.ApiException
import io.cloudy.app.data.AppLock
import io.cloudy.app.data.AppPassword
import kotlinx.coroutines.launch

/** The activity behind a Compose context (needed for the biometric prompt). */
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
 * More → Change password: the current one, then the new one twice (8+ characters, as on the web). This phone stays
 * signed in (its device token isn't the password); the server signs out the browsers signed in to the account.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChangePasswordScreen(nav: NavController) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var current by rememberSaveable { mutableStateOf("") }
    var new by rememberSaveable { mutableStateOf("") }
    var repeat by rememberSaveable { mutableStateOf("") }
    var currentError by rememberSaveable { mutableStateOf<String?>(null) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val tooShort = new.isNotEmpty() && new.length < 8
    val mismatch = repeat.isNotEmpty() && repeat != new
    val canSave = current.isNotEmpty() && new.length >= 8 && repeat == new && !busy
    fun save() {
        if (!canSave) return
        busy = true; error = null; currentError = null
        scope.launch {
            try {
                Services.api.changePassword(current, new)
                toast(context, context.getString(R.string.password_changed))
                nav.popBackStack()
            } catch (e: Exception) {
                when ((e as? ApiException)?.status) {
                    403 -> currentError = context.getString(R.string.current_password_wrong)
                    429 -> error = context.getString(R.string.too_many_attempts)
                    else -> error = e.message ?: context.getString(R.string.failed)
                }
            } finally {
                busy = false
            }
        }
    }

    Scaffold(topBar = {
        TopAppBar(title = { Text(stringResource(R.string.change_password)) },
            navigationIcon = { IconButton(onClick = { nav.popBackStack() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) } })
    }) { pad ->
        Column(Modifier.padding(pad).imePadding().fillMaxWidth().verticalScroll(rememberScrollState()).readableWidth().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)) {
            PasswordField(current, { current = it; currentError = null; error = null }, stringResource(R.string.current_password), Modifier.fillMaxWidth(),
                enabled = !busy, isError = currentError != null, supportingText = currentError?.let { { Text(it) } }, imeAction = ImeAction.Next)
            PasswordField(new, { new = it; error = null }, stringResource(R.string.new_password), Modifier.fillMaxWidth(),
                enabled = !busy, isError = tooShort, supportingText = { Text(stringResource(R.string.password_min_hint)) }, imeAction = ImeAction.Next)
            PasswordField(repeat, { repeat = it; error = null }, stringResource(R.string.repeat_new_password), Modifier.fillMaxWidth(),
                enabled = !busy, isError = mismatch, supportingText = if (mismatch) { { Text(stringResource(R.string.passwords_dont_match)) } } else null,
                imeAction = ImeAction.Done, keyboardActions = KeyboardActions(onDone = { save() }))
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
            Text(stringResource(R.string.change_password_note), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline)
            Button(onClick = { save() }, enabled = canSave, modifier = Modifier.align(Alignment.End)) {
                if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text(stringResource(R.string.change_password))
            }
        }
    }
}

/** More → Devices: every token signed in to the account, revocable (except this phone's). */
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
