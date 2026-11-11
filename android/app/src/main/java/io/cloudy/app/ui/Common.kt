package io.cloudy.app.ui

import android.content.Context
import android.content.Intent
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.Dp
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Slideshow
import androidx.compose.material.icons.outlined.TableChart
import androidx.compose.material3.IconButton
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.automirrored.outlined.Article
import androidx.compose.material.icons.outlined.AudioFile
import androidx.compose.material.icons.outlined.FolderZip
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.PictureAsPdf
import androidx.compose.material.icons.outlined.VideoFile
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.Saver
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.cloudy.app.R
import io.cloudy.app.data.FileNode
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

val Accent = Color(0xFF0B6BCB)

// Brand scheme for every role, so no Material default (purple) tones show up in bars, chips or selections.
private val LightColors = lightColorScheme(
    primary = Accent, onPrimary = Color.White, primaryContainer = Color(0xFFD6E6FA), onPrimaryContainer = Color(0xFF002C5A),
    secondary = Color(0xFF52606F), onSecondary = Color.White, secondaryContainer = Color(0xFFD9E5F5), onSecondaryContainer = Color(0xFF0F1C2B),
    tertiary = Color(0xFF00796B), onTertiary = Color.White, tertiaryContainer = Color(0xFFCDEDE8), onTertiaryContainer = Color(0xFF00201C),
    background = Color(0xFFF8F9FC), onBackground = Color(0xFF191C20), surface = Color(0xFFF8F9FC), onSurface = Color(0xFF191C20),
    surfaceVariant = Color(0xFFDFE3EB), onSurfaceVariant = Color(0xFF454951), outline = Color(0xFF747880), outlineVariant = Color(0xFFC4C7CF),
    surfaceTint = Accent, surfaceContainerLowest = Color.White, surfaceContainerLow = Color(0xFFF2F4F8), surfaceContainer = Color(0xFFECEFF4),
    surfaceContainerHigh = Color(0xFFE6E9EF), surfaceContainerHighest = Color(0xFFE0E3E9), surfaceBright = Color(0xFFF8F9FC), surfaceDim = Color(0xFFD8DADF),
)
private val DarkColors = darkColorScheme(
    primary = Color(0xFF8CBDF7), onPrimary = Color(0xFF00315F), primaryContainer = Color(0xFF0E4A8C), onPrimaryContainer = Color(0xFFD6E6FA),
    secondary = Color(0xFFBAC7DA), onSecondary = Color(0xFF243140), secondaryContainer = Color(0xFF2A3849), onSecondaryContainer = Color(0xFFD9E5F5),
    tertiary = Color(0xFF7FD6C8), onTertiary = Color(0xFF003731), tertiaryContainer = Color(0xFF005047), onTertiaryContainer = Color(0xFFCDEDE8),
    background = Color(0xFF111418), onBackground = Color(0xFFE1E2E8), surface = Color(0xFF111418), onSurface = Color(0xFFE1E2E8),
    surfaceVariant = Color(0xFF44474F), onSurfaceVariant = Color(0xFFC4C6CF), outline = Color(0xFF8E9199), outlineVariant = Color(0xFF44474F),
    surfaceTint = Color(0xFF8CBDF7), surfaceContainerLowest = Color(0xFF0C0E12), surfaceContainerLow = Color(0xFF191C20), surfaceContainer = Color(0xFF1D2025),
    surfaceContainerHigh = Color(0xFF272A2F), surfaceContainerHighest = Color(0xFF32353A), surfaceBright = Color(0xFF37393E), surfaceDim = Color(0xFF111418),
)

@Composable
fun CloudyTheme(content: @Composable () -> Unit) =
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors, content = content)

fun formatSize(bytes: Long): String {
    val units = listOf("B", "KB", "MB", "GB", "TB")
    var n = bytes.toDouble()
    var i = 0
    while (n >= 1024 && i < units.size - 1) { n /= 1024; i++ }
    // Latin digits, isolated, so "9.0 MB" keeps its order inside right-to-left (Arabic) text.
    val text = if (i == 0) "$bytes B" else String.format(java.util.Locale.ROOT, if (n < 10) "%.1f %s" else "%.0f %s", n, units[i])
    return "\u2068$text\u2069"
}

private val dateFmt = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT)
fun formatDate(iso: String): String =
    runCatching { dateFmt.format(Instant.parse(iso).atZone(ZoneId.systemDefault())) }.getOrDefault("")

private val timeFmt = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT)
private val dayFmt = DateTimeFormatter.ofPattern("d MMM")
private val dayYearFmt = DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)

/** Short date for lists, like the iPhone app: time today, "12 Oct" this year, the full date before. */
fun formatWhen(iso: String): String = runCatching {
    val t = Instant.parse(iso).atZone(ZoneId.systemDefault())
    val today = java.time.LocalDate.now()
    when {
        t.toLocalDate() == today -> timeFmt.format(t)
        t.year == today.year -> dayFmt.format(t)
        else -> dayYearFmt.format(t)
    }
}.getOrDefault("")

private val ARCHIVE = Regex("zip|tar|gzip|7z|rar")

/** File type colors, the same in the iPhone app (`fileIcon` in Common.swift). */
object TypeColor {
    val Folder = Accent
    val Image = Color(0xFF0E9AA7)
    val Video = Color(0xFFE0457B)
    val Audio = Color(0xFF8B5CF6)
    val Pdf = Color(0xFFD93A3A)
    val Archive = Color(0xFFA0782C)
    val Sheet = Color(0xFF1F9D55)
    val Slides = Color(0xFFE8772E)
    val Doc = Color(0xFF3B66D9)
    val Other = Color(0xFF64748B)
}

/** More screen icon colors (Android Settings style); the iPhone app uses the same hue per entry where it has one. */
object SettingColor {
    val Blue = Color(0xFF1A73E8)
    val Sky = Color(0xFF0288D1)
    val Orange = Color(0xFFE37400)
    val Green = Color(0xFF1E8E3E)
    val Teal = Color(0xFF00897B)
    val Purple = Color(0xFF8E44D9)
    val Pink = Color(0xFFD81B60)
    val Indigo = Color(0xFF4F5BD5)
    val Gray = Color(0xFF5F6368)
}

fun iconFor(node: FileNode): Pair<ImageVector, Color> {
    val m = node.mime
    val ext = node.name.substringAfterLast('.', "").lowercase()
    return when {
        node.isDir -> Icons.Filled.Folder to TypeColor.Folder
        m.startsWith("image/") -> Icons.Outlined.Image to TypeColor.Image
        m.startsWith("video/") -> Icons.Outlined.VideoFile to TypeColor.Video
        m.startsWith("audio/") -> Icons.Outlined.AudioFile to TypeColor.Audio
        m == "application/pdf" || ext == "pdf" -> Icons.Outlined.PictureAsPdf to TypeColor.Pdf
        ARCHIVE.containsMatchIn(m) -> Icons.Outlined.FolderZip to TypeColor.Archive
        ext in setOf("xls", "xlsx", "ods", "csv", "numbers") -> Icons.Outlined.TableChart to TypeColor.Sheet
        ext in setOf("ppt", "pptx", "odp", "key") -> Icons.Outlined.Slideshow to TypeColor.Slides
        ext in setOf("doc", "docx", "odt", "rtf", "pages") -> Icons.Outlined.Description to TypeColor.Doc
        m.startsWith("text/") || m.contains("json") || m.contains("xml") -> Icons.AutoMirrored.Outlined.Article to TypeColor.Other
        else -> Icons.AutoMirrored.Outlined.InsertDriveFile to TypeColor.Other
    }
}

/** Type and avatar colors are tuned for light backgrounds; in dark mode they are lifted so glyphs keep their contrast. */
@Composable
fun Color.forTheme(): Color = if (isSystemInDarkTheme()) androidx.compose.ui.graphics.lerp(this, Color.White, 0.4f) else this

@Composable
fun FileIcon(node: FileNode, modifier: Modifier = Modifier.size(32.dp)) {
    val (icon, base) = iconFor(node)
    val tint = base.forTheme()
    Icon(icon, contentDescription = null, tint = tint, modifier = modifier)
}

/** The file's type as a tinted rounded square (list rows); [size] scales the glyph with it. */
@Composable
fun FileTile(node: FileNode, size: Dp = 40.dp) {
    val (icon, base) = iconFor(node)
    val tint = base.forTheme()
    Box(Modifier.size(size).clip(RoundedCornerShape(size * 0.28f)).background(tint.copy(alpha = if (isSystemInDarkTheme()) 0.22f else 0.12f)),
        contentAlignment = Alignment.Center) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(size * 0.55f))
    }
}

private val AVATAR_COLORS = listOf(0xFF0B6BCB, 0xFF0E9AA7, 0xFF1F9D55, 0xFFE8772E, 0xFFE0457B, 0xFF8B5CF6, 0xFFD93A3A, 0xFF3B66D9).map { Color(it) }

/** A stable color per name, so a person keeps their avatar color everywhere. */
fun avatarColor(name: String): Color = AVATAR_COLORS[Math.floorMod(name.hashCode(), AVATAR_COLORS.size)]

/** Initials in a circle filled with the name's color. */
@Composable
fun Avatar(name: String, size: Dp = 40.dp) {
    val initials = name.split(' ').filter { it.isNotBlank() }.take(2).joinToString("") { it.take(1) }.uppercase().ifEmpty { "?" }
    val color = avatarColor(name).forTheme()
    Box(Modifier.size(size).clip(CircleShape).background(color.copy(alpha = if (isSystemInDarkTheme()) 0.3f else 0.16f)), contentAlignment = Alignment.Center) {
        Text(initials, color = color, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleSmall)
    }
}

/** Pill-shaped search field (Material 3 search bar look) for lists that filter as you type. */
@Composable
fun SearchField(value: String, onChange: (String) -> Unit, placeholder: String, modifier: Modifier = Modifier) {
    val colors = MaterialTheme.colorScheme
    BasicTextField(value, onChange, singleLine = true, textStyle = MaterialTheme.typography.bodyLarge.copy(color = colors.onSurface),
        cursorBrush = SolidColor(colors.primary), keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        modifier = modifier.fillMaxWidth().height(52.dp).clip(RoundedCornerShape(26.dp)).background(colors.surfaceContainerHigh),
        decorationBox = { inner ->
            Row(Modifier.padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.Search, null, tint = colors.onSurfaceVariant)
                Box(Modifier.weight(1f).padding(start = 12.dp)) {
                    if (value.isEmpty()) Text(placeholder, color = colors.onSurfaceVariant, style = MaterialTheme.typography.bodyLarge)
                    inner()
                }
                if (value.isNotEmpty()) IconButton(onClick = { onChange("") }) { Icon(Icons.Outlined.Close, stringResource(R.string.cancel)) }
                else Box(Modifier.width(12.dp))
            }
        })
}

fun toast(context: Context, msg: String) = Toast.makeText(context, msg, Toast.LENGTH_SHORT).show()

fun shareText(context: Context, text: String) {
    val send = Intent(Intent.ACTION_SEND).apply { type = "text/plain"; putExtra(Intent.EXTRA_TEXT, text) }
    context.startActivity(Intent.createChooser(send, null))
}

@Composable
fun Loading() = Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }

/** Centered icon and text; [onRetry] adds a "Try again" button (for load errors). */
@Composable
fun EmptyState(icon: ImageVector, text: String, onRetry: (() -> Unit)? = null) =
    Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(icon, null, modifier = Modifier.size(64.dp), tint = MaterialTheme.colorScheme.outline)
            Text(text, color = MaterialTheme.colorScheme.outline, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 12.dp))
            if (onRetry != null) androidx.compose.material3.OutlinedButton(onClick = onRetry, modifier = Modifier.padding(top = 16.dp)) {
                Text(stringResource(R.string.try_again))
            }
        }
    }

@Composable
fun TextPrompt(
    title: String, initial: String = "", label: String = stringResource(R.string.name), confirm: String = stringResource(R.string.ok),
    onDismiss: () -> Unit, onConfirm: (String) -> Unit,
) {
    var value by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf(initial) } // survives rotation
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { OutlinedTextField(value, { value = it }, label = { Text(label) }, singleLine = true) },
        confirmButton = { TextButton(enabled = value.isNotBlank(), onClick = { onConfirm(value.trim()) }) { Text(confirm) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) } },
    )
}

@Composable
fun ConfirmDialog(title: String, text: String, confirm: String, onDismiss: () -> Unit, onConfirm: () -> Unit) =
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(text) },
        confirmButton = { TextButton(onClick = onConfirm) { Text(confirm, color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) } },
    )

/**
 * A label with a switch at the end. The whole row toggles it (a bigger target) and TalkBack reads both together
 * ("All day, switch, on") instead of a bare "switch, off".
 */
@Composable
fun SwitchRow(label: String, checked: Boolean, modifier: Modifier = Modifier, enabled: Boolean = true, onChange: (Boolean) -> Unit) =
    Row(modifier.fillMaxWidth().heightIn(min = 48.dp)
        .toggleable(checked, enabled = enabled, role = androidx.compose.ui.semantics.Role.Switch, onValueChange = onChange),
        verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f))
        androidx.compose.material3.Switch(checked, onCheckedChange = null, enabled = enabled)
    }

/** For a ListItem whose trailing Switch (with `onCheckedChange = null`) it toggles, as one TalkBack element. */
fun Modifier.toggleRow(checked: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit): Modifier =
    toggleable(checked, enabled = enabled, role = androidx.compose.ui.semantics.Role.Switch, onValueChange = onChange)

/** Lets rememberSaveable keep a @Serializable model, so an open form survives rotation and process death. */
val saveJson = Json { ignoreUnknownKeys = true }

inline fun <reified T : Any> jsonSaver(): Saver<T?, String> = Saver(
    save = { it?.let { v -> saveJson.encodeToString(v) } },
    restore = { saveJson.decodeFromString<T>(it) },
)

/**
 * Keeps a floating button clear of a navigation bar or camera cutout at the side (landscape, 3-button navigation):
 * the app is edge-to-edge, and Scaffold only insets the FAB at the bottom.
 */
@Composable
fun Modifier.sideInsets(): Modifier = windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.End))

/** Password field with an eye button that shows or hides what was typed (login, delete account). */
@Composable
fun PasswordField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: androidx.compose.ui.Modifier = androidx.compose.ui.Modifier,
    enabled: Boolean = true,
    isError: Boolean = false,
    supportingText: (@Composable () -> Unit)? = null,
    imeAction: ImeAction = ImeAction.Default,
    keyboardActions: androidx.compose.foundation.text.KeyboardActions = androidx.compose.foundation.text.KeyboardActions.Default,
) {
    var visible by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf(false) }
    OutlinedTextField(
        value, onValueChange, modifier, enabled = enabled, singleLine = true, isError = isError,
        label = { Text(label) }, supportingText = supportingText,
        visualTransformation = if (visible) androidx.compose.ui.text.input.VisualTransformation.None
            else androidx.compose.ui.text.input.PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Password, autoCorrectEnabled = false, imeAction = imeAction),
        keyboardActions = keyboardActions,
        trailingIcon = {
            // 48 dp touch target (IconButton), spoken as "Show password" / "Hide password".
            IconButton(onClick = { visible = !visible }) {
                Icon(if (visible) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                    androidx.compose.ui.res.stringResource(if (visible) io.cloudy.app.R.string.hide_password else io.cloudy.app.R.string.show_password))
            }
        },
    )
}

// Links shown in the app (same targets as the iPhone app).
const val HELP_URL = "https://github.com/Fahed-Alhammadi/Cloudy#readme"
const val INSTALL_URL = "https://github.com/Fahed-Alhammadi/Cloudy#install"
const val FEEDBACK_URL = "https://github.com/Fahed-Alhammadi/Cloudy/issues"

/** Opens a web page in the browser; quietly does nothing when no app can open it. */
fun openUrl(context: Context, url: String) {
    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
}

/** Play Store page of the app (fixed id: debug builds are io.cloudy.app.debug, which is not on Play). */
fun openStoreListing(context: Context) {
    val market = Intent(Intent.ACTION_VIEW, android.net.Uri.parse("market://details?id=io.cloudy.app")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    if (runCatching { context.startActivity(market) }.isFailure) openUrl(context, "https://play.google.com/store/apps/details?id=io.cloudy.app")
}
