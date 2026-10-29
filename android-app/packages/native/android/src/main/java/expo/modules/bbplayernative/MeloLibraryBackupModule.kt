package expo.modules.bbplayernative

import android.app.Activity
import android.content.Intent
import android.content.Context
import android.net.Uri
import android.system.Os
import android.system.OsConstants
import android.system.ErrnoException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.*
import java.security.MessageDigest
import java.text.Normalizer
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

/** Streaming private library archive. No account stores, network reads, or arbitrary file paths. */
class MeloLibraryBackupModule : Module() {
  private val lock = Any()
  private var instance: LibraryBackupStore? = null
  private fun store() = instance ?: LibraryBackupStore(appContext.reactContext ?: error("Context unavailable")).also { instance = it }
  private val saveLock = Any()
  private data class SaveRequest(val code: Int, val result: CompletableDeferred<Uri?>)
  private var pendingSave: SaveRequest? = null
  private var saveJob: Job? = null
  companion object {
    // Process-wide sequence also prevents a stale result after JS/module recreation
    // from being mistaken for the newly created module's picker.
    private val nextSaveCode = java.util.concurrent.atomic.AtomicInteger(27100)
  }
  private var destroyed = false

  private fun cancelSave() {
    synchronized(saveLock) { saveJob?.cancel(CancellationException("备份保存已中断；若已选择文件，请检查并删除可能不完整的文件。")) }
  }
  private suspend fun chooseDestination(full: Boolean): Uri? {
    val request = synchronized(saveLock) {
      val code = nextSaveCode.getAndIncrement()
      check(code < 65000) { "请重新打开应用后再保存备份。" }
      SaveRequest(code, CompletableDeferred()).also { pendingSave = it }
    }
    try {
      withContext(Dispatchers.Main) {
        currentCoroutineContext().ensureActive()
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
          addCategory(Intent.CATEGORY_OPENABLE)
          type = "application/zip"
          putExtra(Intent.EXTRA_TITLE, "melocanvas-${if (full) "full" else "light"}-${System.currentTimeMillis()}.zip")
        }
        appContext.throwingActivity.startActivityForResult(intent, request.code)
      }
      return request.result.await()
    } catch (e: Exception) {
      if (e is CancellationException) throw e
      throw IOException("无法打开或完成系统文件保存，请确认设备支持文档选择器后重试。备份未保存。", e)
    } finally {
      synchronized(saveLock) { if (pendingSave === request) pendingSave = null }
      request.result.cancel()
    }
  }
  override fun definition() = ModuleDefinition {
    Name("MeloLibraryBackup")
    AsyncFunction("exportAsync") Coroutine { catalogue: String, full: Boolean -> withContext(Dispatchers.IO) {
      val job = currentCoroutineContext(); synchronized(lock) { store().export(catalogue, full) { job.ensureActive() } }
    } }
    // Native owns the source across picker suspension and IO cancellation. No URI supplied
    // by JS can become a write target: only this ACTION_CREATE_DOCUMENT result is accepted.
    AsyncFunction("saveAsync") Coroutine { catalogue: String, full: Boolean -> withContext(Dispatchers.IO) {
      val job = currentCoroutineContext()[Job] ?: error("Missing save job")
      synchronized(saveLock) {
        check(!destroyed && saveJob == null) { "已有备份正在保存，请完成或取消后再试。" }
        saveJob = job
      }
      var source: String? = null
      try {
        source = synchronized(lock) { store().export(catalogue, full, true) { job.ensureActive() } }
        val destination = chooseDestination(full)
        if (destination == null) false else {
          require(destination.scheme == "content") { "系统未返回可写入的文档位置，备份未保存。" }
          try {
            // Provider IO may block. The owned source needs no store-wide lock; keep
            // lifecycle teardown and unrelated operations independent of providers.
            val owner = synchronized(lock) { store() }
            owner.saveExport(source, destination) { job.ensureActive() }
          } catch (e: Exception) {
            if (e is CancellationException) throw e
            throw IOException("备份保存失败；所选位置可能留有不完整文件，请检查并删除后重试。当前资料未修改。", e)
          }
          true
        }
      } finally {
        // Already on IO: no cancellable dispatcher hand-off can lose source ownership.
        try { source?.let { synchronized(lock) { store().discardSaveExport(it) } } }
        finally { synchronized(saveLock) { if (saveJob === job) saveJob = null } }
      }
    } }
    OnActivityResult { _, (requestCode, resultCode, intent) ->
      val request = synchronized(saveLock) {
        pendingSave?.takeIf { it.code == requestCode }?.also { pendingSave = null }
      }
      if (request != null) {
        if (resultCode != Activity.RESULT_OK) request.result.complete(null)
        else {
          val uri = intent?.data
          if (uri == null || intent.clipData != null) request.result.completeExceptionally(IOException("系统未返回单个备份保存位置。"))
          else request.result.complete(uri)
        }
      }
    }
    OnActivityDestroys { cancelSave() }
    AsyncFunction("inspectAsync") Coroutine { uri: String -> withContext(Dispatchers.IO) {
      val job = currentCoroutineContext(); synchronized(lock) { store().inspect(uri) { job.ensureActive() } }
    } }
    // Caller MUST validate the catalogue and complete merge preflight before this call.
    AsyncFunction("publishFilesAsync") Coroutine { token: String -> withContext(Dispatchers.IO) {
      val job = currentCoroutineContext(); synchronized(lock) { store().publish(token) { job.ensureActive() } }
    } }
    AsyncFunction("discardAsync") Coroutine { token: String -> withContext(Dispatchers.IO) { synchronized(lock) { store().discard(token) } } }
    OnDestroy {
      synchronized(saveLock) { destroyed = true }
      cancelSave()
      synchronized(lock) { instance?.close() }
    }
  }
}

internal class LibraryBackupStore(private val context: Context) {
  companion object {
    const val META = 32L * 1024 * 1024
    const val FILE = 512L * 1024 * 1024
    const val TOTAL = 2L * 1024 * 1024 * 1024
    const val COUNT = 20000
    const val ARCHIVE = TOTAL + META * 2
    fun requireExportSpace(available: Long, payload: Long) {
      require(available > payload + META * 2 + 16L * 1024 * 1024) { "Insufficient backup space" }
    }
    private val uuid = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
    private val cover = Regex("cover-[a-z0-9]+-[a-z0-9]+")
    private val digest = Regex("[0-9a-f]{64}")
    private val themeId = Regex("[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+")
    fun safePath(path: String): String {
      require(path.length in 1..1024 && Normalizer.normalize(path, Normalizer.Form.NFC) == path) { "Invalid archive path" }
      require(path.split('/').size <= 28 && path.split('/').all { it.length in 1..100 && Regex("[\\p{L}\\p{N}][\\p{L}\\p{N}._-]*").matches(it) && !it.endsWith('.') }) { "Unsafe archive path" }
      return path
    }
    fun sha(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
  }
  private data class Entry(val path: String, val bytes: Long, val hash: String)
  private data class Stage(val dir: File, val entries: List<Entry>)
  private val files = context.filesDir.canonicalFile
  private val cache = context.cacheDir.canonicalFile
  private val stages = mutableMapOf<String, Stage>()
  
  private fun stat(file: File) = try { Os.lstat(file.path) } catch (e: ErrnoException) { if (e.errno == OsConstants.ENOENT) null else throw e }
  private fun check(file: File, root: File, directory: Boolean? = null) {
    require(file.path == root.path || file.path.startsWith(root.path + "/")) { "Outside private root" }
    var cursor = root
    val parts = file.relativeTo(root).path.split('/').filter { it.isNotEmpty() }
    for (part in listOf("") + parts) {
      if (part.isNotEmpty()) cursor = File(cursor, part)
      val st = stat(cursor) ?: error("Missing private file")
      require(!OsConstants.S_ISLNK(st.st_mode)) { "Links forbidden" }
      require(OsConstants.S_ISREG(st.st_mode) || OsConstants.S_ISDIR(st.st_mode)) { "Special files forbidden" }
      if (OsConstants.S_ISREG(st.st_mode)) require(st.st_nlink == 1L) { "Hard links forbidden" }
    }
    require(file.canonicalPath == file.absolutePath) { "Path alias forbidden" }
    if (directory != null) require(OsConstants.S_ISDIR(Os.lstat(file.path).st_mode) == directory) { "Wrong file type" }
  }
  private fun mkdir(file: File, root: File, created: MutableList<File>? = null) {
    if (stat(file) != null) { check(file, root, true); return }
    if (file.parentFile != root) mkdir(file.parentFile!!, root, created) else check(root, root, true)
    Os.mkdir(file.path, 448); created?.add(file); check(file, root, true)
  }
  private fun syncDirectory(file: File) {
    check(file, files, true)
    val before = Os.lstat(file.path)
    val fd = Os.open(file.path, OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC, 0)
    try {
      val opened = Os.fstat(fd); val named = Os.lstat(file.path)
      require(OsConstants.S_ISDIR(opened.st_mode) && opened.st_ino == before.st_ino && opened.st_dev == before.st_dev &&
        opened.st_ino == named.st_ino && opened.st_dev == named.st_dev) { "Directory changed during restore" }
      check(file, files, true); Os.fsync(fd)
    } finally { Os.close(fd) }
  }
  private fun open(file: File, root: File): FileInputStream {
    check(file, root, false)
    val before = Os.lstat(file.path)
    val fd = Os.open(file.path, OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC, 0)
    try {
      val st = Os.fstat(fd)
      require(st.st_ino == before.st_ino && st.st_dev == before.st_dev && st.st_nlink == 1L && OsConstants.S_ISREG(st.st_mode)) { "File changed" }
      return FileInputStream(fd)
    } catch (e: Throwable) { Os.close(fd); throw e }
  }
  private fun create(file: File, root: File): FileOutputStream {
    check(file.parentFile!!, root, true)
    return FileOutputStream(Os.open(file.path, OsConstants.O_WRONLY or OsConstants.O_CREAT or OsConstants.O_EXCL or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC, 384))
  }
  private fun stream(input: InputStream, output: OutputStream?, limit: Long, tick: () -> Unit): Pair<Long, String> {
    val md = MessageDigest.getInstance("SHA-256"); val buffer = ByteArray(65536); var size = 0L
    while (true) {
      tick(); val n = input.read(buffer); if (n == -1) break
      size += n; require(size <= limit) { "Backup size limit exceeded" }; md.update(buffer, 0, n); output?.write(buffer, 0, n)
    }
    return size to md.digest().joinToString("") { "%02x".format(it) }
  }
  private data class References(val audio: Map<String, Long>, val themes: Set<String>, val covers: Set<String>)
  private fun integer(value: JSONObject, key: String): Long {
    val raw = value.get(key); require(raw is Int || raw is Long) { "Noninteger $key" }; return (raw as Number).toLong()
  }
  private fun referenceRoots(json: String): References {
    require(json.toByteArray(Charsets.UTF_8).size <= META) { "Catalogue too large" }
    val catalogue = JSONObject(json)
    require(catalogue.getString("format") == "melocanvas.library-catalogue" && catalogue.getInt("version") == 1) { "Unsupported catalogue" }
    val tables = catalogue.getJSONObject("tables"); val audio = linkedMapOf<String, Long>(); val themes = linkedSetOf<String>()
    val rows = tables.getJSONArray("local_audio"); require(rows.length() <= COUNT)
    for (i in 0 until rows.length()) {
      val row = rows.getJSONObject(i); val id = row.getString("id"); require(id.startsWith("local:") && uuid.matches(id.removePrefix("local:")))
      val bytes = integer(row, "bytes"); require(bytes in 1..9007199254740991L)
      require(audio.put("audio/" + id.removePrefix("local:"), bytes) == null) { "Duplicate local audio identity" }
    }
    val settings = tables.getJSONArray("settings")
    for (i in 0 until settings.length()) {
      val row = settings.getJSONObject(i)
      if (row.getString("key") == "theme.state.v1") {
        val installed = JSONObject(row.getString("value")).getJSONArray("installed")
        require(installed.length() <= 1000)
        for (j in 0 until installed.length()) {
          val item = installed.getJSONObject(j); val id = item.getString("id"); val hash = item.getString("archiveSha256")
          require(themeId.matches(id) && digest.matches(hash))
          require(themes.add("themes/$id/$hash/")) { "Duplicate theme identity" }
        }
      }
    }
    val covers = linkedSetOf<String>()
    val playlists = tables.optJSONArray("playlists") ?: JSONArray()
    for (i in 0 until playlists.length()) {
      val uri = playlists.getJSONObject(i).optString("coverUri", "")
      if (uri.startsWith("melo-backup-cover:")) {
        val name = uri.removePrefix("melo-backup-cover:"); require(cover.matches(name)); covers.add("covers/$name")
      } else require(uri.isEmpty() || uri == "null") { "Nonportable playlist cover" }
    }
    return References(audio, themes, covers)
  }
  private fun hasThemeRegistry(catalogue: String): Boolean {
    val rows = JSONObject(catalogue).getJSONObject("tables").getJSONArray("settings")
    return (0 until rows.length()).any { rows.getJSONObject(it).getString("key") == "theme.state.v1" }
  }
  private fun live(path: String): File {
    safePath(path)
    return when {
      path.startsWith("audio/") && uuid.matches(path.removePrefix("audio/")) -> File(files, "melo-local-audio/" + path.removePrefix("audio/"))
      path.startsWith("covers/") && cover.matches(path.removePrefix("covers/")) -> File(files, "melo-playlist-covers/" + path.removePrefix("covers/"))
      path.startsWith("themes/") -> File(files, "melocanvas-themes/installed/" + path.removePrefix("themes/"))
      else -> error("Unsupported backup file")
    }
  }
  private fun sources(catalogue: String, full: Boolean): List<Pair<String, File>> {
    val (audio, themes, covers) = referenceRoots(catalogue); if (!full) { require(covers.isEmpty() && themes.isEmpty() && !hasThemeRegistry(catalogue)) { "Light backup cannot contain theme registry" }; return emptyList() }
    val result = mutableListOf<Pair<String, File>>()
    for (path in audio.keys) { val f = live(path); check(f, files, false); require(f.length() == audio[path]); result.add(path to f) }
    for (path in covers) { val f = live(path); check(f, files, false); result.add(path to f) }
    var visited = 0
    fun visit(dir: File, prefix: String, depth: Int) {
      require(++visited <= COUNT) { "Too many theme directories" }
      require(depth <= 24); check(dir, files, true)
      for (child in (dir.listFiles() ?: error("Cannot read theme")).sortedBy { it.name }) {
        val path = safePath(prefix + child.name); check(child, files)
        if (child.isDirectory) visit(child, "$path/", depth + 1) else result.add(path to child)
        require(result.size <= COUNT)
      }
    }
    for (prefix in themes) { val before = result.size; visit(live(prefix.trimEnd('/')), prefix, 0); require(result.size > before) { "Missing theme files" } }
    require(result.size <= COUNT); return result
  }
  fun export(catalogue: String, full: Boolean, forSave: Boolean = false, tick: () -> Unit): String {
    val sources = sources(catalogue, full); val entries = mutableListOf<Entry>(); var total = 0L
    for ((path, file) in sources) {
      val (size, hash) = open(file, files).use { stream(it, null, FILE, tick) }; total += size; require(total <= TOTAL); entries.add(Entry(path, size, hash))
    }
    requireExportSpace(cache.usableSpace, total)
    // A bounded sharing cache without invalidating delayed readers. Save-to-file uses
    // its own source and bypasses this budget; neither path deletes other exports.
    var remaining = ARCHIVE
    if (!forSave) {
      check(cache, cache, true)
      for (old in cache.listFiles() ?: error("Cannot read backup cache")) {
        if (Regex("melocanvas-backup-${uuid.pattern}\\.zip").matches(old.name)) {
          check(old, cache, false)
          remaining -= old.length()
          if (remaining <= 0) break
        }
      }
      require(remaining > 0) { "临时分享文件已达容量上限，请改用保存到文件。此限制不影响本地歌曲容量。" }
    }
    val cat = catalogue.toByteArray(Charsets.UTF_8)
    val manifest = JSONObject().put("format", "melocanvas.library-archive").put("version", 1).put("full", full)
      .put("catalogueBytes", cat.size).put("catalogueSha256", sha(cat)).put("files", JSONArray(entries.map { JSONObject().put("path", it.path).put("bytes", it.bytes).put("sha256", it.hash) }))
    val manifestBytes = manifest.toString().toByteArray(Charsets.UTF_8)
    require(manifestBytes.size <= 8 * 1024 * 1024) { "File manifest too large" }
    val target = File(cache, "${if (forSave) "melo-save" else "melocanvas-backup"}-${UUID.randomUUID()}.zip")
    try {
      create(target, cache).use { out ->
        val bounded = object : FilterOutputStream(out) {
          var written = 0L
          private fun reserve(n: Int) {
            require(n.toLong() <= remaining - written) { if (forSave) "Backup archive size limit exceeded" else "临时分享文件已达容量上限，请改用保存到文件。此限制不影响本地歌曲容量。" }
            written += n
          }
          override fun write(value: Int) { reserve(1); out.write(value) }
          override fun write(bytes: ByteArray, offset: Int, length: Int) { reserve(length); out.write(bytes, offset, length) }
        }
        ZipOutputStream(bounded).use { zip ->
        fun add(name: String, bytes: ByteArray) { zip.putNextEntry(ZipEntry(name)); zip.write(bytes); zip.closeEntry() }
        add("manifest.json", manifestBytes); add("catalogue.json", cat)
        for ((index, pair) in sources.withIndex()) {
          zip.putNextEntry(ZipEntry(pair.first)); val actual = open(pair.second, files).use { stream(it, zip, FILE, tick) }
          require(actual.first == entries[index].bytes && actual.second == entries[index].hash) { "Source changed during backup" }; zip.closeEntry()
        }
        tick(); zip.finish(); out.fd.sync()
      } }
      // Share recipients may open their URI after the chooser returns. Never invalidate
      // another export here. Share files remain disposable app cache; save files are
      // owned by saveAsync and deleted in its finally block.
      return Uri.fromFile(target).toString()
    } catch (e: Throwable) { target.delete(); throw e }
  }
  private fun saveSource(uri: String): File {
    val parsed = Uri.parse(uri)
    require(parsed.scheme == "file" && parsed.authority.isNullOrEmpty())
    val file = File(parsed.path ?: error("Missing save source")).absoluteFile
    require(file.parentFile == cache && Regex("melo-save-${uuid.pattern}\\.zip").matches(file.name)) { "Not an owned save source" }
    check(file, cache, false)
    return file
  }
  fun saveExport(source: String, destination: Uri, tick: () -> Unit) {
    require(destination.scheme == "content") { "Only a selected document can be written" }
    val file = saveSource(source)
    val limit = ARCHIVE
    val expected = open(file, cache).use { stream(it, null, limit, tick) }
    tick()
    val copied = context.contentResolver.openOutputStream(destination, "w")?.use { output ->
      open(file, cache).use { input -> stream(input, output, limit, tick) }.also { output.flush() }
    } ?: error("Cannot open selected document for writing")
    require(copied == expected) { "Save source changed" }
    // Closing the provider output successfully is Android's write-completion contract.
    // Do not re-download the destination: providers may be cloud-backed or write-only.
    // Source size/hash above verifies the bytes handed to that output, not remote durability.
    tick()
    // No deletion of a provider URI on error: a broken provider could return an existing
    // document. UI warns that an incomplete target may remain for the user to remove.
  }
  fun discardSaveExport(uri: String) {
    val file = saveSource(uri)
    require(file.delete()) { "备份临时文件清理失败，请稍后清理应用缓存。" }
  }
  private fun selected(uri: String): InputStream {
    val value = Uri.parse(uri)
    return when (value.scheme) {
      "content" -> context.contentResolver.openInputStream(value) ?: error("Cannot read selected file")
      "file" -> { require(value.authority.isNullOrEmpty()); val supplied = File(value.path ?: error("Missing path")).absoluteFile
        val rawCache = context.cacheDir.absoluteFile
        require(supplied.path.startsWith(rawCache.path + "/") || supplied.path.startsWith(cache.path + "/")) { "Selected file must be picker cache copy" }
        val f = if (supplied.path.startsWith(rawCache.path + "/")) File(cache, supplied.relativeTo(rawCache).path) else supplied
        open(f, cache) }
      else -> error("Unsupported selected URI")
    }
  }
  fun inspect(uri: String, tick: () -> Unit): Map<String, Any> {
    require(stages.size < 4) { "Discard earlier backup previews first" }
    val token = UUID.randomUUID().toString(); val dir = File(cache, "melo-backup-stage-$token"); mkdir(dir, cache)
    try {
      val result = selected(uri).use { source ->
        // Bound compressed bytes too, including pathological entries and provider streams.
        val bounded = object : FilterInputStream(source) {
          var count = 0L
          override fun read(): Int { tick(); val n = super.read(); if (n >= 0) count++; require(count <= TOTAL + META * 2); return n }
          override fun read(b: ByteArray, off: Int, len: Int): Int { tick(); val n = `in`.read(b, off, len); if (n > 0) count += n; require(count <= TOTAL + META * 2); return n }
        }
        ZipInputStream(BufferedInputStream(bounded)).use { zip ->
          fun metadata(name: String, max: Long): ByteArray {
            val entry = zip.nextEntry ?: error("Missing backup metadata"); require(entry.name == name && !entry.isDirectory)
            val out = ByteArrayOutputStream(); stream(zip, out, max, tick); zip.closeEntry(); return out.toByteArray()
          }
          val manifest = JSONObject(String(metadata("manifest.json", 8L * 1024 * 1024), Charsets.UTF_8))
          require(manifest.getString("format") == "melocanvas.library-archive" && integer(manifest, "version") == 1L)
          require(manifest.get("full") is Boolean); val full = manifest.getBoolean("full"); val cat = metadata("catalogue.json", META)
          require(cat.size.toLong() == integer(manifest, "catalogueBytes") && sha(cat) == manifest.getString("catalogueSha256")) { "Catalogue integrity failed" }
          val catalogue = String(cat, Charsets.UTF_8); val (audio, themes, covers) = referenceRoots(catalogue)
          val array = manifest.getJSONArray("files"); require(array.length() <= COUNT)
          val entries = linkedMapOf<String, Entry>(); val directories = mutableSetOf<String>(); var total = 0L
          for (i in 0 until array.length()) {
            val item = array.getJSONObject(i); val path = safePath(item.getString("path")); val size = integer(item, "bytes"); val hash = item.getString("sha256")
            require(size in 0..FILE && digest.matches(hash)); total += size; require(total <= TOTAL)
            var parent = path.substringBeforeLast('/', "")
            while (parent.isNotEmpty()) { directories.add(parent); require(directories.size <= COUNT) { "Too many archive directories" }; parent = parent.substringBeforeLast('/', "") }
            require(entries.put(path, Entry(path, size, hash)) == null) { "Duplicate archive file" }
            require(audio.containsKey(path) || covers.contains(path) || themes.any { path.startsWith(it) }) { "Unreferenced backup file" }
            if (audio.containsKey(path)) require(size == audio[path]) { "Audio length mismatch" }
          }
          require(full || (entries.isEmpty() && covers.isEmpty() && !hasThemeRegistry(catalogue))) { "Light backup contains files or theme registry" }
          if (full) { require(entries.keys.containsAll(audio.keys)); require(entries.keys.containsAll(covers)); require(themes.all { prefix -> entries.keys.any { it.startsWith(prefix) } }) }
          require(cache.usableSpace > total + 16L * 1024 * 1024) { "Insufficient restore space" }
          val seen = mutableSetOf<String>()
          while (true) {
            tick(); val entry = zip.nextEntry ?: break; val path = safePath(entry.name)
            require(!entry.isDirectory && seen.add(path)) { "Duplicate/directory archive entry" }
            val expected = entries[path] ?: error("Unexpected archive entry")
            require(entry.size == -1L || entry.size == expected.bytes) { "Declared ZIP length mismatch" }
            val target = File(dir, path); mkdir(target.parentFile!!, cache)
            val actual = create(target, cache).use { out -> stream(zip, out, expected.bytes, tick).also { out.fd.sync() } }
            require(actual.first == expected.bytes && actual.second == expected.hash) { "File integrity failed" }; zip.closeEntry()
          }
          require(seen == entries.keys) { "Missing archive files" }
          stages[token] = Stage(dir, entries.values.toList())
          mapOf<String, Any>("token" to token, "catalogueJson" to catalogue, "full" to full,
            "coverFiles" to entries.keys.count { it.startsWith("covers/") }, "audioFiles" to entries.keys.count { it.startsWith("audio/") }, "themeFiles" to entries.keys.count { it.startsWith("themes/") }, "bytes" to total.toDouble())
        }
      }
      return result
    } catch (e: Throwable) { stages.remove(token); dir.deleteRecursively(); throw e }
  }
  fun publish(token: String, tick: () -> Unit) {
    val stage = stages[token] ?: error("Unknown or expired backup preview")
    val added = mutableListOf<File>(); val dirs = mutableListOf<File>()
    try {
      // Preflight every collision and stage hash before changing the live store.
      for (entry in stage.entries) {
        tick(); val staged = File(stage.dir, entry.path)
        val actual = open(staged, cache).use { stream(it, null, entry.bytes, tick) }
        require(actual.first == entry.bytes && actual.second == entry.hash) { "Stage changed" }
        val target = live(entry.path)
        if (stat(target) != null) { val old = open(target, files).use { stream(it, null, FILE, tick) }; require(old == actual) { "Existing file identity collision; nothing overwritten" } }
      }
      for (entry in stage.entries) {
        tick(); val target = live(entry.path)
        if (stat(target) != null) {
          val old = open(target, files).use { stream(it, null, FILE, tick) }
          require(old.first == entry.bytes && old.second == entry.hash) { "Existing file changed during restore" }; continue
        }
        mkdir(target.parentFile!!, files, dirs)
        val staged = File(stage.dir, entry.path); check(staged, cache, false)
        // Same app-private filesystem. link is atomic and fails EEXIST, unlike rename.
        Os.link(staged.path, target.path); added.add(target)
      }
      // Staged file data was synced at inspect. Flush hard-link directory entries and
      // newly created ancestry before allowing the caller to commit its SQLite catalogue.
      val durable = linkedSetOf<File>()
      added.forEach { durable.add(it.parentFile!!) }
      dirs.asReversed().forEach { durable.add(it); durable.add(it.parentFile!!) }
      durable.forEach { tick(); syncDirectory(it) }
      tick()
      // Remove private staging links only after all publications succeed.
      discard(token)
    } catch (e: Throwable) {
      added.asReversed().forEach { it.delete() }; dirs.asReversed().forEach { it.delete() }
      discard(token); throw e
    }
  }
  fun discard(token: String) {
    val stage = stages[token] ?: return
    require(stage.dir.deleteRecursively()) { "Could not remove temporary backup stage" }
    stages.remove(token)
  }
  fun close() { stages.keys.toList().forEach { try { discard(it) } catch (_: Exception) { /* Android may reclaim cache later. */ } } }
}
