package io.cloudy.app.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.drawable.BitmapDrawable
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ripple
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import coil.imageLoader
import coil.request.CachePolicy
import coil.request.ImageRequest
import coil.request.SuccessResult
import coil.size.Precision
import coil.size.Scale
import io.cloudy.app.R
import io.cloudy.app.Services
import io.cloudy.app.data.ApiException
import io.cloudy.app.data.User
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream

/** Side of the stored picture: the same 512 px square the web app sends. */
private const val PICTURE_SIDE = 512

/**
 * The picture at [uri] as a square JPEG (the middle of it, at most [PICTURE_SIDE] px, white behind see-through parts),
 * or null when it can't be read. Coil turns it upright (EXIF) and downsamples while decoding; re-encoding leaves the
 * photo's metadata (place, camera) behind.
 */
private suspend fun squarePicture(context: Context, uri: Uri): ByteArray? {
    val request = ImageRequest.Builder(context).data(uri).size(PICTURE_SIDE).scale(Scale.FILL).precision(Precision.INEXACT)
        .allowHardware(false).memoryCachePolicy(CachePolicy.DISABLED).diskCachePolicy(CachePolicy.DISABLED).build()
    val bitmap = ((context.imageLoader.execute(request) as? SuccessResult)?.drawable as? BitmapDrawable)?.bitmap ?: return null
    return withContext(Dispatchers.Default) {
        val side = minOf(bitmap.width, bitmap.height)
        if (side <= 0) return@withContext null
        val out = minOf(side, PICTURE_SIDE)
        val square = Bitmap.createBitmap(out, out, Bitmap.Config.ARGB_8888)
        Canvas(square).apply {
            drawColor(android.graphics.Color.WHITE)
            val left = (bitmap.width - side) / 2
            val top = (bitmap.height - side) / 2
            drawBitmap(bitmap, Rect(left, top, left + side, top + side), Rect(0, 0, out, out), Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG))
        }
        ByteArrayOutputStream().use { bytes ->
            square.compress(Bitmap.CompressFormat.JPEG, 90, bytes)
            square.recycle()
            bytes.toByteArray()
        }
    }
}

/** A failed save or removal as a message; 404 = a server from before profile pictures (1.20). */
private fun pictureError(context: Context, e: Throwable): String =
    if (e is ApiException && e.status == 404) context.getString(R.string.picture_unsupported)
    else e.message ?: context.getString(R.string.failed)

/**
 * The signed-in user's picture (More screen) with a camera badge. Tapping it chooses a new picture (Android's photo
 * picker: no permission needed), shows it as others will see it, and saves it; with a picture, a sheet also offers
 * Remove. Same flow and words as the web's Settings → Profile picture.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProfilePicture(user: User?, size: androidx.compose.ui.unit.Dp = 56.dp) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var sheet by rememberSaveable { mutableStateOf(false) }
    var confirmRemove by rememberSaveable { mutableStateOf(false) }
    // The chosen picture survives rotation; it is read again then.
    var chosen by rememberSaveable { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri -> if (uri != null) chosen = uri.toString() }
    fun choose() { sheet = false; pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }
    val hasPicture = user?.avatar != null
    val label = stringResource(if (hasPicture) R.string.change_picture else R.string.upload_picture)

    // Not clipped (the badge sits on the edge); the ripple is a circle around the picture.
    Box(Modifier.clickable(remember { MutableInteractionSource() }, ripple(bounded = false, radius = size / 2 + 4.dp), onClickLabel = label,
        role = Role.Button) { if (hasPicture) sheet = true else choose() }) {
        Avatar(user?.displayName ?: "", size, user?.id, user?.avatar)
        // The badge says the picture can be changed (controls stay visible, never only on hover/long-press).
        Box(Modifier.align(Alignment.BottomEnd).size(22.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary)
            .border(2.dp, MaterialTheme.colorScheme.surfaceContainerLowest, CircleShape), contentAlignment = Alignment.Center) {
            Icon(Icons.Outlined.PhotoCamera, null, tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size(12.dp))
        }
    }

    if (sheet) ModalBottomSheet(onDismissRequest = { sheet = false }) {
        Text(stringResource(R.string.profile_picture), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
        val colors = ListItemDefaults.colors(containerColor = Color.Transparent)
        ListItem(modifier = Modifier.clickable { choose() }, colors = colors,
            leadingContent = { Icon(Icons.Outlined.PhotoLibrary, null) }, headlineContent = { Text(stringResource(R.string.change_picture)) })
        ListItem(modifier = Modifier.clickable { sheet = false; confirmRemove = true }, colors = colors,
            leadingContent = { Icon(Icons.Outlined.Delete, null, tint = MaterialTheme.colorScheme.error) },
            headlineContent = { Text(stringResource(R.string.remove_picture), color = MaterialTheme.colorScheme.error) })
        Box(Modifier.padding(bottom = 24.dp))
    }

    if (confirmRemove) ConfirmDialog(stringResource(R.string.remove_picture), stringResource(R.string.remove_picture_text), stringResource(R.string.remove),
        { confirmRemove = false }) {
        confirmRemove = false
        scope.launch {
            try {
                Services.api.removeAvatar()
                Services.session.user.value?.let { Services.session.updateUser(it.copy(avatar = null)) }
                toast(context, context.getString(R.string.picture_removed))
            } catch (e: Exception) { toast(context, pictureError(context, e)) }
        }
    }

    chosen?.let { uriText ->
        // Read once per chosen picture; null while reading, then the JPEG (or a toast and nothing when unreadable).
        var jpeg by remember(uriText) { mutableStateOf<ByteArray?>(null) }
        LaunchedEffect(uriText) {
            val bytes = runCatching { squarePicture(context, Uri.parse(uriText)) }.getOrNull()
            if (bytes == null) { toast(context, context.getString(R.string.picture_unreadable)); chosen = null } else jpeg = bytes
        }
        val preview = remember(jpeg) { jpeg?.let { android.graphics.BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() } }
        AlertDialog(
            onDismissRequest = { if (!busy) chosen = null },
            title = { Text(stringResource(R.string.new_profile_picture)) },
            text = {
                Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                    Box(Modifier.size(160.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceContainerHigh), contentAlignment = Alignment.Center) {
                        if (preview != null) Image(preview, stringResource(R.string.picture_preview), Modifier.size(160.dp), contentScale = ContentScale.Crop)
                        else Loading()
                    }
                    Text(stringResource(R.string.picture_preview_note), Modifier.padding(top = 16.dp), textAlign = TextAlign.Center,
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            },
            confirmButton = {
                TextButton(enabled = jpeg != null && !busy, onClick = {
                    val bytes = jpeg ?: return@TextButton
                    busy = true
                    scope.launch {
                        try {
                            val version = Services.api.setAvatar(bytes)
                            Services.session.user.value?.let { Services.session.updateUser(it.copy(avatar = version)) }
                            toast(context, context.getString(R.string.picture_saved))
                            chosen = null
                        } catch (e: Exception) { toast(context, pictureError(context, e)) }
                        busy = false
                    }
                }) { Text(stringResource(R.string.save_picture)) }
            },
            dismissButton = { TextButton(enabled = !busy, onClick = { chosen = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}
