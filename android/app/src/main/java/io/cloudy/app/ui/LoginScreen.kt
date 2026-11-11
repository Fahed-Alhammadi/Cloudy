package io.cloudy.app.ui

import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.draw.clip
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.background
import android.os.Build
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.foundation.Image
import androidx.compose.ui.res.painterResource
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import io.cloudy.app.R
import io.cloudy.app.Services
import androidx.compose.ui.res.stringResource
import android.content.Intent
import android.net.Uri
import androidx.compose.material3.TextButton
import io.cloudy.app.data.PrivateHost
import io.cloudy.app.work.BackupSettings
import io.cloudy.app.work.Jobs
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.LaunchedEffect
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.IOException

/**
 * Runs [work], trying again a few times when the connection itself failed (not when the server answered): on the
 * very first use a phone may still be showing its "allow network access" dialog, and the user's answer arrives
 * seconds later.
 */
suspend fun <T> retryingConnection(attempts: Int = 4, work: suspend () -> T): T {
    var attempt = 0
    while (true) {
        try { return work() } catch (e: IOException) {
            if (++attempt >= attempts) throw e
            delay(attempt * 1500L)
        }
    }
}

@Composable
fun LoginScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    // Everything typed survives rotation and process death (the password too: it stays in this app's saved state).
    var server by rememberSaveable { mutableStateOf(Services.session.lastServer.ifEmpty { "https://" }) }
    var user by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var code by rememberSaveable { mutableStateOf("") }
    var needCode by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }

    fun submit() {
        var url = server.trim().trimEnd('/')
        if (!url.startsWith("http://") && !url.startsWith("https://")) url = "https://$url"
        // Plain http:// would send the password and the device token in the clear: only on the local network.
        if (url.startsWith("http://") && !PrivateHost.isPrivateHost(runCatching { java.net.URI(url).host ?: "" }.getOrDefault(""))) {
            error = context.getString(R.string.login_https_required)
            return
        }
        busy = true
        error = null
        scope.launch {
            try {
                val r = retryingConnection {
                    Services.api.checkServer(url)
                    Services.api.login(url, user.trim(), password, "${Build.MANUFACTURER} ${Build.MODEL}", if (needCode) code else null)
                }
                // Another account (or server: node ids are per server) signed in here before: its offline copies go.
                // Photo backup is turned off only for another user; the same user at a new address keeps it.
                if (Services.session.isOtherUser(r.user.id)) BackupSettings(context).enabled = false
                if (Services.session.isOtherAccount(url, r.user.id)) Services.offline.clearAll()
                Services.session.signIn(url, r.token, r.user)
                Jobs.schedule(context)
            } catch (e: io.cloudy.app.data.ApiException) {
                if (e.twoFactor && !needCode) needCode = true else error = e.message
            } catch (e: Exception) {
                error = context.getString(R.string.login_cannot_reach, e.message ?: "")
            } finally {
                busy = false
            }
        }
    }

    // Reach the server as soon as its address is typed: some phones ask whether the app may use the network on its
    // first connection, and this way that question comes before "Log in" instead of failing the first attempt.
    LaunchedEffect(server) {
        val url = server.trim().trimEnd('/')
        val host = url.substringAfter("://", "").substringBefore('/')
        if (host.length < 4 || !(host.contains('.') || host.contains(':'))) return@LaunchedEffect
        delay(1200)
        runCatching { Services.api.checkServer(if (url.contains("://")) url else "https://$url") }
    }

    Scaffold { pad ->
        Column(
            Modifier.fillMaxSize().padding(pad).imePadding().verticalScroll(rememberScrollState()).padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Column(Modifier.widthIn(max = 420.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                // The mark, the name and one line on what this is: the first thing a new user reads.
                Column(Modifier.fillMaxWidth().padding(bottom = 10.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Image(painterResource(R.drawable.ic_cloudy_logo), null, modifier = Modifier.size(72.dp))
                    Text("Cloudy", style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 12.dp))
                    Text(stringResource(R.string.login_tagline), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center, modifier = Modifier.padding(top = 6.dp))
                }
                OutlinedTextField(server, { server = it }, label = { Text(stringResource(R.string.login_server)) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next))
                OutlinedTextField(user, { user = it }, label = { Text(stringResource(R.string.username)) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next))
                PasswordField(password, { password = it }, stringResource(R.string.login_password), Modifier.fillMaxWidth(),
                    imeAction = ImeAction.Go,
                    keyboardActions = androidx.compose.foundation.text.KeyboardActions(onGo = { if (!busy) submit() }))
                if (needCode) {
                    OutlinedTextField(code, { code = it }, label = { Text(stringResource(R.string.login_code)) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                        supportingText = { Text(stringResource(R.string.login_code_hint)) },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Go),
                        keyboardActions = androidx.compose.foundation.text.KeyboardActions(onGo = { if (!busy) submit() }))
                }
                // The error opens in place (and is announced by TalkBack) instead of making the form jump.
                androidx.compose.animation.AnimatedVisibility(error != null) {
                    val shown = remember { arrayOf("") }
                    error?.let { shown[0] = it }
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.errorContainer).padding(horizontal = 14.dp, vertical = 12.dp)
                        .semantics { liveRegion = androidx.compose.ui.semantics.LiveRegionMode.Polite }, verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.ErrorOutline, null, tint = MaterialTheme.colorScheme.onErrorContainer, modifier = Modifier.size(20.dp))
                        Text(shown[0], color = MaterialTheme.colorScheme.onErrorContainer, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(start = 10.dp))
                    }
                }
                Button(onClick = ::submit, enabled = !busy && user.isNotBlank() && password.isNotEmpty() && server.length > 8, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) {
                    if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) else Text(stringResource(R.string.login_button), style = MaterialTheme.typography.titleMedium)
                }
                // Password reset by email happens on the web (the link in the email opens the browser anyway).
                TextButton(enabled = server.length > 8, onClick = {
                    var url = server.trim().trimEnd('/')
                    if (!url.startsWith("http://") && !url.startsWith("https://")) url = "https://$url"
                    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("$url/#/forgot"))) }
                }, modifier = Modifier.align(Alignment.End)) { Text(stringResource(R.string.login_forgot)) }
                Text(stringResource(R.string.login_token_note),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline)
                // Cloudy is a client for your own server: new users land here without one, so point them at the install guide.
                TextButton(onClick = { openUrl(context, INSTALL_URL) }, modifier = Modifier.align(Alignment.CenterHorizontally)) {
                    Text(stringResource(R.string.login_no_server))
                }
            }
        }
    }
}
