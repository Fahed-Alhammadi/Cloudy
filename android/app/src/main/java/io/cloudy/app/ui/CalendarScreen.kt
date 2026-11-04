package io.cloudy.app.ui

import io.cloudy.app.R
import androidx.compose.ui.res.stringResource
import android.app.DatePickerDialog
import android.app.TimePickerDialog
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.Repeat
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.cloudy.app.Services
import io.cloudy.app.data.CalEvent
import io.cloudy.app.data.DavCollection
import io.cloudy.app.data.EventInput
import kotlinx.coroutines.launch
import java.time.DayOfWeek
import java.time.Instant
import java.time.Duration
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.YearMonth
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.time.temporal.WeekFields
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import java.util.Locale

private val zone: ZoneId get() = ZoneId.systemDefault()

private fun startOf(e: CalEvent, master: Boolean = false): LocalDateTime {
    val s = if (master && e.masterStart.isNotEmpty()) e.masterStart else e.start
    return if (e.allDay) LocalDate.parse(s.take(10)).atStartOfDay() else LocalDateTime.ofInstant(Instant.parse(s), zone)
}
private fun endOf(e: CalEvent, master: Boolean = false): LocalDateTime {
    val s = if (master && e.masterEnd.isNotEmpty()) e.masterEnd else e.end
    return if (e.allDay) LocalDate.parse(s.take(10)).atStartOfDay() else LocalDateTime.ofInstant(Instant.parse(s), zone)
}
/** An event with its start and end parsed once (the month grid asks every day about every event). */
private class Span(val e: CalEvent, val start: LocalDateTime, val end: LocalDateTime) {
    fun onDay(d: LocalDate) = start < d.plusDays(1).atStartOfDay() && end > d.atStartOfDay()
}

fun parseColor(hex: String): Color = runCatching { Color(android.graphics.Color.parseColor(hex)) }.getOrDefault(Accent)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CalendarScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var month by rememberSaveable { mutableStateOf(YearMonth.now()) }
    var selected by rememberSaveable { mutableStateOf(LocalDate.now()) }
    var calendars by remember { mutableStateOf<List<DavCollection>>(emptyList()) }
    var events by remember { mutableStateOf<List<CalEvent>>(emptyList()) }
    var editing by rememberSaveable(stateSaver = editingSaver) { mutableStateOf<Pair<CalEvent?, LocalDate>?>(null) }
    var reloadKey by remember { mutableStateOf(0) }
    var calendarsLoaded by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) } // ignore a second tap on Save while one is in flight

    val first = month.atDay(1)
    // Weeks start on the locale's first day (Sunday in the US, Saturday in many Arabic locales, Monday elsewhere).
    val weekStart = remember { WeekFields.of(Locale.getDefault()).firstDayOfWeek }
    val gridStart = first.minusDays(((first.dayOfWeek.value - weekStart.value + 7) % 7).toLong())
    LaunchedEffect(month, reloadKey) {
        try {
            calendars = Services.api.calendars()
            val s = gridStart.atStartOfDay(zone).toInstant().toString()
            val e = gridStart.plusDays(42).atStartOfDay(zone).toInstant().toString()
            events = calendars.flatMap { c -> runCatching { Services.api.events(c.id, s, e) }.getOrDefault(emptyList()) }
        } catch (e: Exception) { toast(context, e.message ?: context.getString(R.string.calendar_load_failed)) }
        calendarsLoaded = true
    }
    val colorOf = calendars.associate { it.id to parseColor(it.color) }
    val spans = remember(events) { events.mapNotNull { e -> runCatching { Span(e, startOf(e), endOf(e)) }.getOrNull() } }
    val dayLabel = remember { DateTimeFormatter.ofLocalizedDate(java.time.format.FormatStyle.FULL) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(month.month.getDisplayName(TextStyle.FULL, Locale.getDefault()) + " " + month.year) },
                actions = {
                    IconButton(onClick = { month = month.minusMonths(1) }) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, stringResource(R.string.previous_month)) }
                    TextButton(onClick = { month = YearMonth.now(); selected = LocalDate.now() }) { Text(stringResource(R.string.today)) }
                    IconButton(onClick = { month = month.plusMonths(1) }) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, stringResource(R.string.next_month)) }
                },
            )
        },
        floatingActionButton = { FloatingActionButton(onClick = { editing = null to selected }, modifier = Modifier.sideInsets()) { Icon(Icons.Filled.Add, stringResource(R.string.new_event)) } },
    ) { pad ->
        BoxWithConstraints(Modifier.padding(pad).fillMaxSize()) {
            // Landscape and wide windows: month and day side by side, the grid's rows sized to the height (square
            // cells would push the day's events off the screen).
            val wide = maxWidth > maxHeight
            val cellHeight = if (wide) ((maxHeight - 20.dp) / 6).coerceAtLeast(28.dp) else null
            @Composable
            fun Month(modifier: Modifier) = Column(modifier) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp)) {
                    for (i in 0 until 7) Text(weekStart.plus(i.toLong()).getDisplayName(TextStyle.SHORT, Locale.getDefault()),
                        Modifier.weight(1f), textAlign = TextAlign.Center, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
                }
                val circle = cellHeight?.let { (it - 11.dp).coerceIn(20.dp, 32.dp) } ?: 32.dp
                for (w in 0 until 6) Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp)) {
                    for (d in 0 until 7) {
                        val day = gridStart.plusDays((w * 7 + d).toLong())
                        val dayEvents = spans.filter { it.onDay(day) }
                        val isSel = day == selected
                        Column(
                            Modifier.weight(1f).then(if (cellHeight != null) Modifier.height(cellHeight) else Modifier.aspectRatio(1.15f))
                                .clip(RoundedCornerShape(12.dp)).clickable { selected = day }
                                .semantics { contentDescription = day.format(dayLabel); this.selected = isSel },
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            val today = day == LocalDate.now()
                            // Today: filled circle; the selected day: tonal circle.
                            Box(Modifier.padding(top = 3.dp).size(circle).clip(CircleShape).background(when {
                                today -> MaterialTheme.colorScheme.primary
                                isSel -> MaterialTheme.colorScheme.primaryContainer
                                else -> Color.Transparent
                            }), contentAlignment = Alignment.Center) {
                                Text(day.dayOfMonth.toString(), fontSize = 14.sp, fontWeight = if (today || isSel) FontWeight.SemiBold else FontWeight.Normal,
                                    color = when {
                                        today -> MaterialTheme.colorScheme.onPrimary
                                        isSel -> MaterialTheme.colorScheme.onPrimaryContainer
                                        day.month != month.month -> MaterialTheme.colorScheme.outline.copy(alpha = 0.6f)
                                        else -> MaterialTheme.colorScheme.onSurface
                                    })
                            }
                            Row(Modifier.padding(top = 3.dp), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                                dayEvents.take(3).forEach { Box(Modifier.size(5.dp).clip(CircleShape).background(colorOf[it.e.calendarId] ?: Accent)) }
                            }
                        }
                    }
                }
            }
            @Composable
            fun Day(modifier: Modifier) {
                val today = spans.filter { it.onDay(selected) }.sortedWith(compareBy({ !it.e.allDay }, { it.start })).map { it.e }
                LazyColumn(modifier.clip(RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp)).background(MaterialTheme.colorScheme.surfaceContainerLow),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 88.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    item {
                        Text(selected.format(DateTimeFormatter.ofPattern("EEEE, d MMMM")), style = MaterialTheme.typography.titleSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp, bottom = 4.dp))
                    }
                    if (today.isEmpty()) item { Text(stringResource(R.string.no_events), color = MaterialTheme.colorScheme.outline) }
                    // The same event file can be in two calendars (imported twice): the calendar is part of the key.
                    items(today, key = { "${it.calendarId}/${it.uri}/${it.start}" }) { e -> EventCard(e, colorOf[e.calendarId] ?: Accent) { editing = e to selected } }
                }
            }
            if (wide) Row(Modifier.fillMaxSize()) {
                Month(Modifier.weight(1f))
                Day(Modifier.weight(1f).fillMaxHeight())
            } else Column(Modifier.fillMaxSize()) {
                Month(Modifier.fillMaxWidth())
                Day(Modifier.fillMaxSize())
            }
        }
    }
    // A restored editor (after rotation) waits until the calendars have loaded again.
    editing?.takeIf { calendarsLoaded }?.let { (ev, day) ->
        if (calendars.isEmpty()) {
            toast(context, context.getString(R.string.no_calendar)); editing = null
        } else EventEditor(ev, day, calendars, onDismiss = { editing = null }) { op ->
            // The editor stays open until the server accepts the change, so a rejected save loses nothing.
            if (!saving) scope.launch {
                saving = true
                try { op(); reloadKey++; editing = null } catch (e: Exception) { toast(context, e.message ?: context.getString(R.string.failed)) }
                saving = false
            }
        }
    }
}

/** One event of the selected day: time column, calendar color bar, title and place. */
@Composable
private fun EventCard(e: CalEvent, color: Color, onClick: () -> Unit) {
    val fmt = DateTimeFormatter.ofLocalizedTime(java.time.format.FormatStyle.SHORT)
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(MaterialTheme.colorScheme.surfaceContainerLowest).clickable(onClick = onClick)
        .padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.width(64.dp)) {
            if (e.allDay) Text(stringResource(R.string.all_day), style = MaterialTheme.typography.labelLarge)
            else {
                Text(startOf(e).toLocalTime().format(fmt), style = MaterialTheme.typography.labelLarge)
                Text(endOf(e).toLocalTime().format(fmt), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Box(Modifier.padding(horizontal = 10.dp).width(4.dp).height(36.dp).background(color, RoundedCornerShape(2.dp)))
        Column(Modifier.weight(1f)) {
            Text(e.summary.ifEmpty { stringResource(R.string.no_title) }, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (e.location.isNotEmpty()) Text(e.location, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (e.recurring) Icon(Icons.Outlined.Repeat, stringResource(R.string.repeats), tint = MaterialTheme.colorScheme.outline, modifier = Modifier.size(18.dp))
    }
}

/** The open editor (event, or null for a new one, and the day it was opened on) kept across rotation. */
private val editingSaver = Saver<Pair<CalEvent?, LocalDate>?, String>(
    save = { it?.let { (ev, day) -> "$day|" + (ev?.let { e -> saveJson.encodeToString(CalEvent.serializer(), e) } ?: "") } },
    restore = { s ->
        val (day, ev) = s.split("|", limit = 2)
        (if (ev.isEmpty()) null else saveJson.decodeFromString(CalEvent.serializer(), ev)) to LocalDate.parse(day)
    },
)

@Composable
private fun EventEditor(ev: CalEvent?, day: LocalDate, calendars: List<DavCollection>, onDismiss: () -> Unit, onDone: (suspend () -> Unit) -> Unit) {
    val context = LocalContext.current
    var summary by rememberSaveable { mutableStateOf(ev?.summary ?: "") }
    var allDay by rememberSaveable { mutableStateOf(ev?.allDay ?: false) }
    val s0 = ev?.let { startOf(it, master = true) } ?: day.atTime(9, 0)
    var e0 = ev?.let { endOf(it, master = true) } ?: day.atTime(10, 0)
    if (ev?.allDay == true) e0 = e0.minusDays(1) // stored end is exclusive
    var startDate by rememberSaveable { mutableStateOf(s0.toLocalDate()) }
    var startTime by rememberSaveable { mutableStateOf(s0.toLocalTime()) }
    var endDate by rememberSaveable { mutableStateOf(e0.toLocalDate()) }
    var endTime by rememberSaveable { mutableStateOf(e0.toLocalTime()) }
    var rrule by rememberSaveable { mutableStateOf(ev?.rrule ?: "") }
    var calendarId by rememberSaveable { mutableStateOf(ev?.calendarId ?: calendars.first().id) }
    var location by rememberSaveable { mutableStateOf(ev?.location ?: "") }
    var notes by rememberSaveable { mutableStateOf(ev?.description ?: "") }
    var repeatMenu by remember { mutableStateOf(false) }
    var calMenu by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    // Dates and times as the phone shows them ("4 Nov 2026", "9:00 AM" or "09:00").
    val dateFmt = remember { DateTimeFormatter.ofLocalizedDate(java.time.format.FormatStyle.MEDIUM) }
    val timeFmt = remember { DateTimeFormatter.ofLocalizedTime(java.time.format.FormatStyle.SHORT) }
    val repeats = listOf("" to R.string.does_not_repeat, "DAILY" to R.string.daily, "WEEKLY" to R.string.weekly, "MONTHLY" to R.string.monthly, "YEARLY" to R.string.yearly)
        .map { (k, label) -> k to stringResource(label) }

    fun pickDate(d: LocalDate, set: (LocalDate) -> Unit) =
        DatePickerDialog(context, { _, y, m, dd -> set(LocalDate.of(y, m + 1, dd)) }, d.year, d.monthValue - 1, d.dayOfMonth).show()
    fun pickTime(t: LocalTime, set: (LocalTime) -> Unit) =
        TimePickerDialog(context, { _, h, min -> set(LocalTime.of(h, min)) }, t.hour, t.minute, android.text.format.DateFormat.is24HourFormat(context)).show()

    /** Moves the start and keeps the event's length, as calendar apps do. */
    fun moveStart(d: LocalDate, t: LocalTime) {
        val length = Duration.between(startDate.atTime(startTime), endDate.atTime(endTime)).coerceAtLeast(Duration.ZERO)
        val end = d.atTime(t).plus(length)
        startDate = d; startTime = t; endDate = end.toLocalDate(); endTime = end.toLocalTime()
    }
    val endBeforeStart = if (allDay) endDate < startDate else endDate.atTime(endTime) < startDate.atTime(startTime)

    fun input(): EventInput {
        val (s, e) = if (allDay) startDate.toString() to endDate.plusDays(1).toString()
        else startDate.atTime(startTime).atZone(zone).toInstant().toString() to endDate.atTime(endTime).atZone(zone).toInstant().toString()
        return EventInput(summary.trim(), s, e, allDay, location, notes, rrule)
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(if (ev == null) R.string.new_event else R.string.edit_event)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(summary, { summary = it }, label = { Text(stringResource(R.string.event_title)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                SwitchRow(stringResource(R.string.all_day), allDay) { allDay = it }
                Text(stringResource(R.string.starts), style = MaterialTheme.typography.labelMedium)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { pickDate(startDate) { moveStart(it, startTime) } }) { Text(startDate.format(dateFmt)) }
                    if (!allDay) OutlinedButton(onClick = { pickTime(startTime) { moveStart(startDate, it) } }) { Text(startTime.format(timeFmt)) }
                }
                Text(stringResource(R.string.ends), style = MaterialTheme.typography.labelMedium)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { pickDate(endDate) { endDate = it } }) { Text(endDate.format(dateFmt)) }
                    if (!allDay) OutlinedButton(onClick = { pickTime(endTime) { endTime = it } }) { Text(endTime.format(timeFmt)) }
                }
                if (endBeforeStart) Text(stringResource(R.string.end_before_start), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                Box {
                    OutlinedButton(onClick = { repeatMenu = true }) { Icon(Icons.Outlined.Repeat, null); Text("  " + (repeats.firstOrNull { it.first == rrule }?.second
                        // A rule this app can't set (e.g. HOURLY from another calendar app) is shown as it is.
                        ?: rrule.lowercase().replaceFirstChar { it.titlecase() })) }
                    DropdownMenu(repeatMenu, { repeatMenu = false }) {
                        repeats.forEach { (v, l) -> DropdownMenuItem({ Text(l) }, onClick = { rrule = v; repeatMenu = false }) }
                    }
                }
                if (ev == null) Box {
                    OutlinedButton(onClick = { calMenu = true }) { Icon(Icons.Outlined.CalendarMonth, null); Text("  " + (calendars.firstOrNull { it.id == calendarId }?.name ?: "")) }
                    DropdownMenu(calMenu, { calMenu = false }) {
                        calendars.forEach { c -> DropdownMenuItem({ Text(c.name) }, onClick = { calendarId = c.id; calMenu = false }) }
                    }
                }
                OutlinedTextField(location, { location = it }, label = { Text(stringResource(R.string.location)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(notes, { notes = it }, label = { Text(stringResource(R.string.notes)) }, minLines = 2, modifier = Modifier.fillMaxWidth())
                if (ev?.recurring == true) Text(stringResource(R.string.applies_all), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline)
                if (ev != null) TextButton(onClick = { confirmDelete = true }) { Text(stringResource(R.string.delete_event), color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            TextButton(enabled = summary.isNotBlank() && !endBeforeStart, onClick = {
                val data = input()
                onDone { if (ev == null) Services.api.createEvent(calendarId, data) else Services.api.updateEvent(ev.calendarId, ev.uri, data) }
            }) { Text(stringResource(R.string.save)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) } },
    )
    if (confirmDelete && ev != null) ConfirmDialog(stringResource(R.string.delete_event),
        stringResource(if (ev.recurring) R.string.delete_all_occurrences else R.string.delete_this_event), stringResource(R.string.delete), { confirmDelete = false }) {
        onDone { Services.api.deleteEvent(ev.calendarId, ev.uri) }
    }
}
