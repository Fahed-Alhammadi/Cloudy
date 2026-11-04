package io.cloudy.app.ui

import io.cloudy.app.R
import androidx.compose.ui.res.stringResource
import java.io.File
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers
import io.cloudy.app.data.ImportResult
import androidx.core.content.FileProvider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.AlertDialog
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.FileUpload
import androidx.compose.material.icons.outlined.FileDownload
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.rememberLauncherForActivityResult
import android.app.DatePickerDialog
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.Call
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.Contacts
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.cloudy.app.Services
import java.time.LocalDate
import io.cloudy.app.data.Contact
import io.cloudy.app.data.DavCollection
import kotlinx.coroutines.launch

private fun initials(c: Contact) = c.fn.split(Regex("\\s+")).filter { it.isNotEmpty() }.take(2).joinToString("") { it.take(1) }.uppercase()

@Composable
private fun Avatar(c: Contact, size: Int = 40) = Avatar(c.fn, size.dp)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ContactsScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var books by remember { mutableStateOf<List<DavCollection>>(emptyList()) }
    // The chosen address book survives rotation: an editor restored after it saves into the book it came from.
    var book by rememberSaveable(stateSaver = jsonSaver<DavCollection>()) { mutableStateOf<DavCollection?>(null) }
    var contacts by remember { mutableStateOf<List<Contact>?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) } // ignore a second tap on Save while one is in flight
    var query by rememberSaveable { mutableStateOf("") }
    var editing by rememberSaveable(stateSaver = jsonSaver<Contact>()) { mutableStateOf<Contact?>(null) }
    var bookMenu by remember { mutableStateOf(false) }
    var reloadKey by remember { mutableStateOf(0) }
    var moreMenu by remember { mutableStateOf(false) }
    var importing by remember { mutableStateOf(false) }
    var importResult by remember { mutableStateOf<ImportResult?>(null) }

    // Import: pick a .vcf or .csv file (exported from the phone's Contacts app, Google, Outlook or iCloud).
    val pickFile = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val b = book
        if (uri == null || b == null) return@rememberLauncherForActivityResult
        importing = true
        scope.launch {
            try {
                val bytes = withContext(Dispatchers.IO) {
                    context.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: error(context.getString(R.string.cannot_read_file))
                }
                if (bytes.size > 20 * 1024 * 1024) error(context.getString(R.string.file_too_large))
                importResult = Services.api.importContacts(b.id, bytes)
                reloadKey++
            } catch (e: Exception) {
                toast(context, e.message ?: context.getString(R.string.import_failed))
            } finally {
                importing = false
            }
        }
    }

    // Export: the whole address book as one .vcf, handed to the share sheet (save to Files, send, …).
    fun export() {
        val b = book ?: return
        scope.launch {
            try {
                val file = withContext(Dispatchers.IO) {
                    File(context.cacheDir, "export").apply { mkdirs() }.resolve(io.cloudy.app.data.SafeName.segment("${b.name.replace(Regex("[^\\w .-]"), "_")}.vcf"))
                        .apply { writeText(Services.api.exportContacts(b.id)) }
                }
                val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
                context.startActivity(Intent.createChooser(
                    Intent(Intent.ACTION_SEND).setType("text/x-vcard").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),
                    context.getString(R.string.export_contacts)))
            } catch (e: Exception) {
                toast(context, e.message ?: context.getString(R.string.export_failed))
            }
        }
    }

    // A failed load shows the error with Try again, not "No contacts yet".
    LaunchedEffect(reloadKey) {
        if (books.isNotEmpty()) return@LaunchedEffect
        runCatching { Services.api.addressBooks() }
            .onSuccess { list -> books = list; book = list.firstOrNull { it.id == book?.id } ?: list.firstOrNull(); if (list.isEmpty()) contacts = emptyList() }
            .onFailure { loadError = it.message ?: context.getString(R.string.failed) }
    }
    LaunchedEffect(book?.id, reloadKey) {
        val b = book ?: return@LaunchedEffect
        runCatching { Services.api.contacts(b.id) }
            .onSuccess { contacts = it; loadError = null }
            .onFailure { if (contacts == null) loadError = it.message ?: context.getString(R.string.failed) else toast(context, it.message ?: context.getString(R.string.failed)) }
    }

    // After rotation the editor is restored before the address book has reloaded; open it once it has.
    val editBook = book
    editing?.takeIf { editBook != null }?.let { c ->
        ContactEditor(c, editBook!!.id, onClose = { editing = null }) { op ->
            if (!saving) scope.launch {
                saving = true
                try { op(); editing = null; reloadKey++ } catch (e: Exception) { toast(context, e.message ?: context.getString(R.string.failed)) }
                saving = false
            }
        }
        return
    }

    importResult?.let { r ->
        AlertDialog(
            onDismissRequest = { importResult = null },
            title = { Text(stringResource(R.string.import_finished)) },
            text = {
                Text(listOfNotNull(
                    stringResource(R.string.import_added, r.imported),
                    if (r.updated > 0) stringResource(R.string.import_updated, r.updated) else null,
                    if (r.duplicates > 0) stringResource(R.string.import_duplicates, r.duplicates) else null,
                    if (r.skipped > 0) stringResource(R.string.import_skipped, r.skipped) else null,
                ).joinToString("\n"))
            },
            confirmButton = { TextButton(onClick = { importResult = null }) { Text(stringResource(R.string.ok)) } },
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(title = {
                Box {
                    // Looks like the other tabs' titles; the arrow shows it opens the address-book list.
                    TextButton(onClick = { bookMenu = true }, contentPadding = PaddingValues(start = 0.dp, end = 8.dp),
                        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface)) {
                        Text(book?.name ?: stringResource(R.string.tab_contacts), style = MaterialTheme.typography.titleLarge); Icon(Icons.Outlined.ExpandMore, stringResource(R.string.choose_book))
                    }
                    DropdownMenu(bookMenu, { bookMenu = false }) {
                        books.forEach { b -> DropdownMenuItem({ Text(b.name) }, onClick = { if (b.id != book?.id) { contacts = null; book = b }; bookMenu = false }) }
                    }
                }
            }, actions = {
                if (book != null) Box {
                    IconButton(onClick = { moreMenu = true }) { Icon(Icons.Outlined.MoreVert, stringResource(R.string.more)) }
                    DropdownMenu(moreMenu, { moreMenu = false }) {
                        DropdownMenuItem({ Text(stringResource(R.string.import_from_file)) }, leadingIcon = { Icon(Icons.Outlined.FileUpload, null) }, onClick = {
                            moreMenu = false
                            pickFile.launch(arrayOf("text/x-vcard", "text/vcard", "text/directory", "text/csv", "text/comma-separated-values", "*/*"))
                        })
                        DropdownMenuItem({ Text(stringResource(R.string.export_vcf)) }, leadingIcon = { Icon(Icons.Outlined.FileDownload, null) }, onClick = {
                            moreMenu = false; export()
                        })
                    }
                }
            })
        },
        floatingActionButton = { if (book != null) FloatingActionButton(onClick = { editing = Contact() }, modifier = Modifier.sideInsets()) { Icon(Icons.Filled.Add, stringResource(R.string.new_contact)) } },
    ) { pad ->
        Column(Modifier.padding(pad)) {
            if (importing) LinearProgressIndicator(Modifier.fillMaxWidth())
            SearchField(query, { query = it }, stringResource(R.string.search_contacts), Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
            val list = contacts?.filter { c ->
                query.isBlank() || listOf(c.fn, c.org, *c.emails.toTypedArray(), *c.phones.toTypedArray()).any { it.contains(query, ignoreCase = true) }
            }
            when {
                list == null && loadError != null -> EmptyState(Icons.Outlined.CloudOff, loadError!!) { loadError = null; reloadKey++ }
                list == null -> Loading()
                list.isEmpty() -> EmptyState(Icons.Outlined.Contacts,
                    stringResource(if (contacts.isNullOrEmpty()) R.string.contacts_empty else R.string.no_matches))
                else -> LazyColumn(contentPadding = PaddingValues(bottom = 88.dp)) {
                    // A–Z sections, like the phone's own contacts app.
                    list.sortedBy { it.fn.lowercase() }.groupBy { it.fn.firstOrNull()?.uppercaseChar()?.takeIf(Char::isLetter) ?: '#' }.forEach { (letter, group) ->
                        item(key = "section-$letter") {
                            Text(letter.toString(), style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.padding(start = 24.dp, top = 12.dp, bottom = 4.dp))
                        }
                    items(group, key = { it.uri }) { c ->
                        ListItem(
                            modifier = Modifier.clickable { editing = c },
                            leadingContent = { Avatar(c) },
                            headlineContent = { Text(c.fn, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                            supportingContent = { (c.emails.firstOrNull() ?: c.phones.firstOrNull() ?: c.org.ifEmpty { null })?.let { Text(it, maxLines = 1) } },
                        )
                    }
                    }
                }
            }
        }
    }

}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ContactEditor(c: Contact, bookId: Long, onClose: () -> Unit, onSave: (suspend () -> Unit) -> Unit) {
    val context = LocalContext.current
    BackHandler(onBack = onClose)
    var given by rememberSaveable { mutableStateOf(c.givenName) }
    var family by rememberSaveable { mutableStateOf(c.familyName) }
    var org by rememberSaveable { mutableStateOf(c.org) }
    var title by rememberSaveable { mutableStateOf(c.title) }
    var emails by rememberSaveable { mutableStateOf(c.emails.joinToString("\n")) }
    var phones by rememberSaveable { mutableStateOf(c.phones.joinToString("\n")) }
    var address by rememberSaveable { mutableStateOf(c.address) }
    val shownBirthday = c.birthday.take(10)
    var birthday by rememberSaveable { mutableStateOf(shownBirthday) }
    var note by rememberSaveable { mutableStateOf(c.note) }
    var confirmDelete by remember { mutableStateOf(false) }
    // Empty, or a real date as YYYY-MM-DD (what vCard stores); anything else would be dropped by the server.
    // A birthday left as it was is fine in any form the contact already had (e.g. "--04-15" without a year).
    val birthdayUnchanged = birthday.trim() == shownBirthday.trim() && c.birthday.isNotBlank()
    val birthdayOk = birthday.isBlank() || birthdayUnchanged || runCatching { LocalDate.parse(birthday.trim()) }.isSuccess
    fun pickBirthday() {
        val d = runCatching { LocalDate.parse(birthday.trim()) }.getOrDefault(LocalDate.of(1990, 1, 1))
        DatePickerDialog(context, { _, y, m, dd -> birthday = LocalDate.of(y, m + 1, dd).toString() }, d.year, d.monthValue - 1, d.dayOfMonth).show()
    }
    val isNew = c.uri.isEmpty()

    Scaffold(topBar = {
        TopAppBar(
            title = { Text(if (isNew) stringResource(R.string.new_contact) else c.fn) },
            navigationIcon = { IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) } },
            actions = {
                if (!isNew) IconButton(onClick = { confirmDelete = true }) { Icon(Icons.Outlined.Delete, stringResource(R.string.delete)) }
                TextButton(enabled = (given + family + org).isNotBlank() && birthdayOk, onClick = {
                    val updated = c.copy(givenName = given.trim(), familyName = family.trim(), org = org.trim(), title = title.trim(),
                        emails = emails.lines().map { it.trim() }.filter { it.isNotEmpty() },
                        phones = phones.lines().map { it.trim() }.filter { it.isNotEmpty() },
                        address = address.trim(), birthday = if (birthdayUnchanged) c.birthday else birthday.trim(), note = note)
                    onSave { Services.api.saveContact(bookId, updated) }
                }) { Text(stringResource(R.string.save)) }
            },
        )
    }) { pad ->
        Column(Modifier.padding(pad).imePadding().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (!isNew) Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Avatar(c, 56)
                // Tablets without a phone app (or phones without a mail app) have nothing to open these with.
                fun launch(i: Intent) = runCatching { context.startActivity(i) }.onFailure { toast(context, context.getString(R.string.no_app_found)) }
                c.phones.firstOrNull()?.let { p -> IconButton(onClick = { launch(Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", p, null))) }) { Icon(Icons.Outlined.Call, stringResource(R.string.call)) } }
                c.emails.firstOrNull()?.let { m -> IconButton(onClick = { launch(Intent(Intent.ACTION_SENDTO, Uri.fromParts("mailto", m, null))) }) { Icon(Icons.Outlined.Email, stringResource(R.string.email)) } }
            }
            OutlinedTextField(given, { given = it }, label = { Text(stringResource(R.string.first_name)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(family, { family = it }, label = { Text(stringResource(R.string.last_name)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(org, { org = it }, label = { Text(stringResource(R.string.organization)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(title, { title = it }, label = { Text(stringResource(R.string.job_title)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(emails, { emails = it }, label = { Text(stringResource(R.string.emails_per_line)) }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(phones, { phones = it }, label = { Text(stringResource(R.string.phones_per_line)) }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(address, { address = it }, label = { Text(stringResource(R.string.address)) }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(birthday, { birthday = it }, label = { Text(stringResource(R.string.birthday_format)) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                isError = !birthdayOk,
                supportingText = if (birthdayOk) null else { { Text(stringResource(R.string.birthday_error)) } },
                trailingIcon = { IconButton(onClick = ::pickBirthday) { Icon(Icons.Outlined.CalendarMonth, stringResource(R.string.pick_date)) } })
            OutlinedTextField(note, { note = it }, label = { Text(stringResource(R.string.notes)) }, minLines = 3, modifier = Modifier.fillMaxWidth())
        }
    }
    if (confirmDelete) ConfirmDialog(stringResource(R.string.delete_contact), stringResource(R.string.delete_name, c.fn), stringResource(R.string.delete), { confirmDelete = false }) {
        confirmDelete = false
        onSave { Services.api.deleteContact(bookId, c.uri) }
    }
}
