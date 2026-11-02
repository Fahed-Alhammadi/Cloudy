package io.cloudy.app.ui

import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.foundation.Image
import androidx.compose.ui.res.painterResource
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.DocumentScanner
import androidx.compose.material.icons.outlined.Fingerprint
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material.icons.outlined.Wifi
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleResumeEffect
import io.cloudy.app.R
import io.cloudy.app.Services
import io.cloudy.app.work.Jobs

/**
 * First launch: explains what the app uses on this phone and lets the user answer the permission dialogs now, so
 * the first sign-in, photo backup and scan work right away. Everything can be changed later in the system settings.
 */
@Composable
fun WelcomeScreen(onDone: () -> Unit) {
    val context = LocalContext.current
    var photos by remember { mutableStateOf(Jobs.hasMediaPermission(context)) }
    var photosDenied by remember { mutableStateOf(false) }
    var online by remember { mutableStateOf(isOnline(context)) }
    LifecycleResumeEffect(Unit) {
        photos = Jobs.hasMediaPermission(context)
        online = isOnline(context)
        onPauseOrDispose {}
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        photos = granted.values.all { it }
        photosDenied = !photos
    }

    Scaffold { pad ->
        Column(
            Modifier.fillMaxSize().padding(pad).verticalScroll(rememberScrollState()).padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(Modifier.widthIn(max = 480.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Image(painterResource(R.drawable.ic_cloudy_logo), null, modifier = Modifier.size(64.dp))
                    Text(stringResource(R.string.welcome_title), style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                    Text(stringResource(R.string.welcome_intro), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                }
                PermissionRow(Icons.Outlined.Wifi, SettingColor.Blue, stringResource(R.string.welcome_network), stringResource(R.string.welcome_network_text)) {
                    if (online) Granted() else Text(stringResource(R.string.welcome_offline), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error)
                }
                PermissionRow(Icons.Outlined.PhotoLibrary, SettingColor.Green, stringResource(R.string.welcome_photos), stringResource(R.string.welcome_photos_text)) {
                    when {
                        photos -> Granted()
                        photosDenied -> OutlinedButton(onClick = {
                            runCatching { context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))) }
                        }) { Text(stringResource(R.string.welcome_settings)) }
                        else -> Button(onClick = { permission.launch(Jobs.mediaPermissions()) }) { Text(stringResource(R.string.welcome_allow)) }
                    }
                }
                PermissionRow(Icons.Outlined.DocumentScanner, SettingColor.Orange, stringResource(R.string.welcome_scanner), stringResource(R.string.welcome_scanner_text)) { Granted() }
                PermissionRow(Icons.Outlined.Fingerprint, SettingColor.Teal, stringResource(R.string.welcome_lock), stringResource(R.string.welcome_lock_text)) { Granted() }
                Text(stringResource(R.string.welcome_footer), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline)
                Button(onClick = { Services.session.welcomed = true; onDone() }, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.welcome_continue))
                }
            }
        }
    }
}

@Composable
private fun PermissionRow(icon: ImageVector, color: Color, title: String, text: String, trailing: @Composable () -> Unit) {
    val tint = color.forTheme()
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Box(Modifier.size(40.dp).clip(RoundedCornerShape(12.dp)).background(tint.copy(alpha = 0.15f)), contentAlignment = Alignment.Center) {
            Icon(icon, null, tint = tint, modifier = Modifier.size(22.dp))
        }
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.width(12.dp))
        Box(Modifier.padding(top = 4.dp)) { trailing() }
    }
}

@Composable
private fun Granted() {
    Icon(Icons.Outlined.CheckCircle, stringResource(R.string.welcome_allowed), tint = SettingColor.Green.forTheme(), modifier = Modifier.size(28.dp))
}

/** Whether the phone currently has a network with internet access (Wi-Fi, mobile data, ethernet). */
fun isOnline(context: android.content.Context): Boolean {
    val cm = ContextCompat.getSystemService(context, ConnectivityManager::class.java) ?: return true
    val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
    return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
}
