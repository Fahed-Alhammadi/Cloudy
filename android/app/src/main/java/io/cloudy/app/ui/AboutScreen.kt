package io.cloudy.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.HelpOutline
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.Feedback
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.PrivacyTip
import androidx.compose.material.icons.outlined.StarOutline
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import io.cloudy.app.BuildConfig
import io.cloudy.app.R

const val WEBSITE_URL = "https://fahed-alhammadi.github.io/Cloudy/"
const val PRIVACY_URL = "https://fahed-alhammadi.github.io/Cloudy/privacy-policy.html"

/** The website's night-sky navy (#062b66) and sky blue (#4da3ff): the same in light and dark theme. */
private val NightSky = Color(0xFF062B66)
private val SkyBlue = Color(0xFF4DA3FF)

/** A few fixed stars (fractions of the panel, radius in dp, alpha), so the panel reads as the website's night sky. */
private val Stars = listOf(
    floatArrayOf(0.09f, 0.18f, 1.5f, 0.55f), floatArrayOf(0.22f, 0.62f, 1f, 0.35f), floatArrayOf(0.31f, 0.11f, 1f, 0.4f),
    floatArrayOf(0.72f, 0.14f, 1.5f, 0.5f), floatArrayOf(0.86f, 0.44f, 1f, 0.35f), floatArrayOf(0.93f, 0.12f, 1f, 0.45f),
    floatArrayOf(0.80f, 0.78f, 1.5f, 0.3f), floatArrayOf(0.14f, 0.86f, 1f, 0.3f),
)

/**
 * More → About Cloudy, the same as the iPhone app's: one bold element — the website's night-sky panel with the logo,
 * name, copyright line (the README's footer) and version — then Help, Send feedback and Rate Cloudy, then the website
 * and the privacy policy.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AboutScreen(nav: NavController) {
    val context = LocalContext.current
    Scaffold(topBar = {
        TopAppBar(title = { Text(stringResource(R.string.about)) }, navigationIcon = {
            IconButton(onClick = { nav.popBackStack() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) }
        })
    }) { pad ->
        Column(Modifier.padding(pad).fillMaxWidth().verticalScroll(rememberScrollState()).readableWidth().padding(16.dp)) {
            NightSkyPanel()

            val colors = ListItemDefaults.colors(containerColor = Color.Transparent)
            @Composable
            fun LinkRow(label: Int, detail: String?, icon: androidx.compose.ui.graphics.vector.ImageVector, open: () -> Unit) =
                ListItem(modifier = Modifier.clickable(onClick = open), colors = colors,
                    leadingContent = { Icon(icon, null, tint = MaterialTheme.colorScheme.primary) },
                    headlineContent = { Text(stringResource(label)) },
                    supportingContent = detail?.let { { Text(it) } },
                    trailingContent = { Icon(Icons.AutoMirrored.Outlined.OpenInNew, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.outline) })
            @Composable
            fun Card(content: @Composable () -> Unit) = Column(Modifier.padding(top = 20.dp).fillMaxWidth().clip(RoundedCornerShape(24.dp))
                .background(MaterialTheme.colorScheme.surfaceContainerLowest)) { content() }
            @Composable
            fun Divider() = HorizontalDivider(Modifier.padding(start = 56.dp), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f))
            // What you do (help, feedback, rating), then what you read (website, privacy policy).
            Card {
                LinkRow(R.string.help, null, Icons.AutoMirrored.Outlined.HelpOutline) { openUrl(context, HELP_URL) }
                Divider()
                LinkRow(R.string.send_feedback, null, Icons.Outlined.Feedback) { openUrl(context, FEEDBACK_URL) }
                Divider()
                LinkRow(R.string.rate_app, null, Icons.Outlined.StarOutline) { openStoreListing(context) }
            }
            Card {
                LinkRow(R.string.website, "fahed-alhammadi.github.io/Cloudy", Icons.Outlined.Language) { openUrl(context, WEBSITE_URL) }
                Divider()
                LinkRow(R.string.privacy_policy, null, Icons.Outlined.PrivacyTip) { openUrl(context, PRIVACY_URL) }
            }

            Text(stringResource(R.string.license_note), Modifier.fillMaxWidth().padding(top = 24.dp), textAlign = TextAlign.Center,
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun NightSkyPanel() {
    Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(28.dp)).background(NightSky)) {
        Canvas(Modifier.matchParentSize().clearAndSetSemantics { }) {
            for (s in Stars) {
                drawCircle(Color.White.copy(alpha = s[3]), radius = s[2].dp.toPx(), center = Offset(size.width * s[0], size.height * s[1]))
            }
        }
        Column(Modifier.fillMaxWidth().padding(start = 24.dp, end = 24.dp, top = 36.dp, bottom = 30.dp),
            horizontalAlignment = Alignment.CenterHorizontally) {
            Image(painterResource(R.drawable.ic_cloudy_logo), null,
                Modifier.size(84.dp).shadow(14.dp, RoundedCornerShape(19.dp)).border(1.dp, Color.White.copy(alpha = 0.18f), RoundedCornerShape(19.dp)))
            Text("Cloudy", Modifier.padding(top = 18.dp), color = Color.White,
                style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold)
            Text(stringResource(R.string.copyright), Modifier.padding(top = 4.dp), color = Color.White.copy(alpha = 0.78f),
                style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center)
            Text(stringResource(R.string.version, BuildConfig.VERSION_NAME), Modifier.padding(top = 16.dp).clip(CircleShape)
                .background(Color.White.copy(alpha = 0.09f)).padding(horizontal = 12.dp, vertical = 5.dp),
                color = SkyBlue, style = MaterialTheme.typography.labelLarge)
        }
    }
}
