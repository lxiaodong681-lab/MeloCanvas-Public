package expo.modules.bbplayernative

import android.content.Context
import android.net.Uri
import android.system.Os
import android.system.OsConstants
import android.system.ErrnoException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.text.Normalizer
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject

/** Private storage operations only. No ZIP extraction or package-supplied URI. */
class MeloThemeFilesModule : Module() {
  private companion object { val lock = Any(); val selectedReadBusy = AtomicBoolean(false) }
  private var store: MeloThemeFileStore? = null
  private fun files(): MeloThemeFileStore = store ?: MeloThemeFileStore(
    appContext.reactContext ?: error("React context unavailable")
  ).also { store = it }
  override fun definition() = ModuleDefinition {
    Name("MeloThemeFiles")
    AsyncFunction("rootAsync") Coroutine { -> withContext(Dispatchers.IO) { synchronized(lock) { files().installedUri() } } }
    AsyncFunction("createStageAsync") Coroutine { -> withContext(Dispatchers.IO) { synchronized(lock) { files().createStage() } } }
    AsyncFunction("writeStageAsync") Coroutine { token: String, path: String, bytes: ByteArray ->
      withContext(Dispatchers.IO) { synchronized(lock) { files().writeStage(token, path, bytes) } }
    }
    AsyncFunction("readAsync") Coroutine { scope: String, path: String, maxBytes: Int ->
      withContext(Dispatchers.IO) { synchronized(lock) { files().read(scope, path, maxBytes) } }
    }
    AsyncFunction("listAsync") Coroutine { scope: String, path: String ->
      withContext(Dispatchers.IO) { synchronized(lock) { files().list(scope, path) } }
    }
    AsyncFunction("publishAsync") Coroutine { token: String, id: String, hash: String ->
      withContext(Dispatchers.IO) { synchronized(lock) { files().publish(token, id, hash) } }
    }
    AsyncFunction("removeStageAsync") Coroutine { token: String ->
      withContext(Dispatchers.IO) { synchronized(lock) { files().removeStage(token) } }
    }
    AsyncFunction("readVerifiedAsync") Coroutine { id: String, hash: String, context: String ->
      withContext(Dispatchers.IO) { synchronized(lock) { files().readVerified(id, hash, context) } }
    }
    AsyncFunction("writeVerifiedAsync") Coroutine { id: String, hash: String, context: String, payload: String, entries: List<Map<String, Any>> ->
      withContext(Dispatchers.IO) { synchronized(lock) { files().writeVerified(id, hash, context, payload, entries) } }
    }
    AsyncFunction("removeInstalledAsync") Coroutine { id: String, hash: String, token: String ->
      withContext(Dispatchers.IO) { synchronized(lock) { files().removeInstalled(id, hash, token) } }
    }
    AsyncFunction("readSelectedAsync") Coroutine { uri: String ->
      require(selectedReadBusy.compareAndSet(false, true)) { "Another selected theme read is still running" }
      try {
        withContext(Dispatchers.IO) {
          val selectedStore = synchronized(lock) { files() }
          // A remote/slow DocumentProvider must never hold the private FS lock.
          selectedStore.readSelected(uri)
        }
      } finally { selectedReadBusy.set(false) }
    }
  }
}

/** Same-UID hostile code is outside this boundary; packages cannot create links. */
internal class MeloThemeFileStore(private val context: Context) {
  private val appFiles = context.filesDir.canonicalFile
  private val base = File(appFiles, "melocanvas-themes")
  private val installed = File(base, "installed")
  private val staging = File(base, "staging")
  private val receipts = File(base, "verified")
  private val owners = mutableSetOf<String>()
  private val maxArchive = 20 * 1024 * 1024
  private val maxFile = 8 * 1024 * 1024
  private val maxStored = 80L * 1024 * 1024
  private val metadata = ThemeMetadataStore(
    read = { file -> if (stat(file) == null) null else String(readFile(file, 1024), Charsets.UTF_8) },
    writeSynced = ::writeFile,
    rename = { from, to ->
      check(from, false)
      check(to.parentFile!!, true)
      if (stat(to) != null) check(to, false)
      Os.rename(from.path, to.path)
    },
    syncDirectory = ::syncDirectory,
    removeTemporary = { file -> if (stat(file) != null) { check(file, false); Os.remove(file.path) } },
  )
  private fun stat(file: File) = try { Os.lstat(file.path) } catch (error: ErrnoException) {
    if (error.errno == OsConstants.ENOENT) null else throw error
  }
  private fun check(file: File, directory: Boolean? = null) {
    require(file.path == appFiles.path || file.path.startsWith(appFiles.path + File.separator)) { "Theme path outside private files" }
    var cursor = appFiles
    val relative = file.relativeTo(appFiles).path
    val pieces = if (relative.isEmpty()) emptyList() else relative.split(File.separatorChar)
    for (piece in pieces) {
      cursor = File(cursor, piece)
      val info = stat(cursor) ?: error("Missing theme path")
      require(!OsConstants.S_ISLNK(info.st_mode)) { "Theme links are forbidden" }
      require(OsConstants.S_ISREG(info.st_mode) || OsConstants.S_ISDIR(info.st_mode)) { "Theme special file forbidden" }
      if (OsConstants.S_ISREG(info.st_mode)) require(info.st_nlink == 1L) { "Theme hard links are forbidden" }
    }
    require(file.canonicalPath == file.absolutePath) { "Theme path alias forbidden" }
    val info = stat(file) ?: error("Missing theme path")
    if (directory != null) require(OsConstants.S_ISDIR(info.st_mode) == directory) { "Theme file type mismatch" }
  }
  private fun mkdir(file: File, exclusive: Boolean = false) {
    check(file.parentFile!!, true)
    val existing = stat(file)
    if (existing != null) { require(!exclusive) { "Theme directory already exists" }; check(file, true); return }
    Os.mkdir(file.path, 448) // 0700; no recursive or overwriting create.
    check(file, true)
    syncDirectory(file.parentFile!!)
  }
  private fun syncDirectory(file: File) {
    check(file, true)
    val before = Os.lstat(file.path)
    val fd = Os.open(file.path, OsConstants.O_RDONLY or OsConstants.O_CLOEXEC or OsConstants.O_NOFOLLOW, 0)
    try {
      val opened = Os.fstat(fd)
      val named = Os.lstat(file.path)
      require(OsConstants.S_ISDIR(opened.st_mode) && OsConstants.S_ISDIR(named.st_mode) &&
        opened.st_ino == before.st_ino && opened.st_dev == before.st_dev &&
        opened.st_ino == named.st_ino && opened.st_dev == named.st_dev) { "Theme directory changed during open" }
      check(file, true)
      Os.fsync(fd)
    } finally { Os.close(fd) }
  }
  private fun initialize() { check(appFiles, true); mkdir(base); mkdir(installed); mkdir(staging) }
  private fun uri(file: File) = Uri.fromFile(file).toString().trimEnd('/') + "/"
  fun installedUri(): String { initialize(); return uri(installed) }
  private fun parts(path: String): List<String> {
    require(path.isNotEmpty() && path.length <= 1024 && Normalizer.normalize(path, Normalizer.Form.NFC) == path) { "Invalid theme path" }
    return path.split('/').also { pieces -> require(pieces.all {
      it.length <= 100 && Regex("^[\\p{L}\\p{N}][\\p{L}\\p{N}._-]*$").matches(it) && !it.endsWith('.')
    }) { "Unsafe theme path" } }
  }
  private fun root(scope: String): File {
    initialize()
    if (scope == "installed") return installed
    require(scope in owners) { "Stage not owned by this process" }
    return File(File(staging, scope), "packages").also { check(it, true) }
  }
  private fun target(scope: String, path: String): File = parts(path).fold(root(scope)) { parent, name -> File(parent, name) }
  fun createStage(): Map<String, String> {
    initialize()
    val token = UUID.randomUUID().toString()
    val owned = File(staging, token)
    mkdir(owned, true)
    try { mkdir(File(owned, "packages"), true) } catch (error: Exception) { runCatching { deleteTree(owned) }; throw error }
    owners.add(token)
    return mapOf("token" to token, "privateRootUri" to uri(File(owned, "packages")))
  }
  private fun readFile(file: File, max: Int): ByteArray {
    require(max in 1..maxArchive)
    check(file, false)
    val fd = Os.open(file.path, OsConstants.O_RDONLY or OsConstants.O_CLOEXEC or OsConstants.O_NOFOLLOW, 0)
    return FileInputStream(fd).use { input ->
      val opened = Os.fstat(fd)
      val named = Os.lstat(file.path)
      require(OsConstants.S_ISREG(opened.st_mode) && opened.st_ino == named.st_ino && opened.st_dev == named.st_dev) { "Theme file changed during open" }
      require(opened.st_size <= max) { "Theme read exceeds budget" }
      bounded(input, max).also { check(file, false) }
    }
  }
  private fun bounded(input: InputStream, max: Int): ByteArray {
    val output = ByteArrayOutputStream()
    val chunk = ByteArray(16384)
    while (true) { val count = input.read(chunk); if (count < 0) break; require(output.size().toLong() + count <= max) { "Theme input exceeds budget" }; output.write(chunk, 0, count) }
    return output.toByteArray()
  }
  fun read(scope: String, path: String, max: Int) = readFile(target(scope, path), max)
  private fun writeFile(file: File, bytes: ByteArray) {
    check(file.parentFile!!, true)
    val fd = Os.open(file.path, OsConstants.O_WRONLY or OsConstants.O_CREAT or OsConstants.O_EXCL or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC, 384) // 0600
    FileOutputStream(fd).use { output -> output.write(bytes); output.fd.sync() }
    check(file, false)
    syncDirectory(file.parentFile!!)
  }
  private fun ensureParents(scope: String, path: String): File {
    val names = parts(path)
    var parent = root(scope)
    for (name in names.dropLast(1)) { parent = File(parent, name); mkdir(parent) }
    return File(parent, names.last())
  }
  fun writeStage(token: String, path: String, bytes: ByteArray) {
    require(token in owners)
    val cap = if (path.endsWith("/archive.melotheme")) maxArchive else maxFile
    require(bytes.size <= cap)
    val existing = collect(root(token))
    require(existing.size < 257 && existing.sumOf { it.length() } + bytes.size <= maxStored) { "Theme stage exceeds budget" }
    writeFile(ensureParents(token, path), bytes)
  }
  private fun collect(directory: File): List<File> {
    check(directory, true)
    val output = mutableListOf<File>()
    fun visit(folder: File, depth: Int) {
      require(depth <= 128) { "Theme directory depth exceeded" }
      check(folder, true)
      for (file in folder.listFiles() ?: error("Cannot list theme directory")) {
        check(file)
        if (file.isDirectory) visit(file, depth + 1) else { output.add(file); require(output.size <= 257) { "Theme entries exceeded" }; require(output.sumOf { it.length() } <= maxStored) { "Theme total bytes exceeded" } }
      }
    }
    visit(directory, 0)
    return output
  }
  fun list(scope: String, path: String): List<Map<String, Any>> {
    val leaf = target(scope, path)
    return collect(leaf).map { mapOf("path" to it.relativeTo(leaf).invariantSeparatorsPath, "bytes" to it.length()) }
  }
  fun publish(token: String, id: String, hash: String): String {
    require(token in owners && Regex("^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$").matches(id) && Regex("^[a-f0-9]{64}$").matches(hash))
    val source = target(token, "$id/$hash")
    check(source, true)
    val destinationParent = File(root("installed"), parts(id).single())
    mkdir(destinationParent)
    val destination = File(destinationParent, hash)
    if (stat(destination) != null) { check(destination, true); return "exists" }
    // JS has re-read and checked the archive and every payload byte immediately
    // before this call. This process exposes no overwrite operation for those
    // exclusive stage files. Freeze them before publishing the complete leaf.
    val sourceFiles = collect(source)
    require(sourceFiles.any { it.relativeTo(source).invariantSeparatorsPath == "archive.melotheme" })
    for (file in sourceFiles) { check(file, false); Os.chmod(file.path, 256) }
    val folders = linkedSetOf(source)
    for (file in sourceFiles) {
      var parent = file.parentFile!!
      while (parent.path == source.path || parent.path.startsWith(source.path + File.separator)) {
        folders.add(parent)
        parent = parent.parentFile!!
      }
      val fd = Os.open(file.path, OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC, 0)
      try { Os.fsync(fd) } finally { Os.close(fd) }
    }
    folders.sortedByDescending { it.path.length }.forEach { syncDirectory(it) }
    // Same-filesystem rename under the ONE process-wide writer lock. There is
    // deliberately no copy fallback and no overwrite of any existing final.
    // This is not renameat2(RENAME_NOREPLACE) against malicious same-UID code.
    check(source.parentFile!!, true)
    require(stat(destination) == null) { "Theme final already exists" }
    Os.rename(source.path, destination.path)
    syncDirectory(source.parentFile!!)
    syncDirectory(destinationParent)
    check(destination, true)
    return "created"
  }
  private fun deleteTree(file: File) {
    check(file)
    if (file.isDirectory) for (child in file.listFiles() ?: error("Cannot list owned stage")) deleteTree(child)
    Os.remove(file.path)
  }
  fun removeStage(token: String) {
    require(token in owners) { "Refusing cleanup of unowned stage" }
    val directory = File(staging, token)
    deleteTree(directory)
    owners.remove(token)
  }
  private fun installedLeaf(id: String, hash: String): File {
    require(id.length <= 100 && Regex("^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$").matches(id) && Regex("^[a-f0-9]{64}$").matches(hash))
    return target("installed", "$id/$hash")
  }
  private fun receiptFile(id: String, hash: String): File {
    installedLeaf(id, hash)
    mkdir(receipts)
    val key = MessageDigest.getInstance("SHA-256").digest("$id/$hash".toByteArray()).joinToString("") { "%02x".format(it) }
    return File(receipts, "$key.json")
  }
  /** Stream integrity checks on Dispatchers.IO, without ZIP inflation, bitmap
   * decoding, or sending image buffers over the React Native bridge. */
  private fun digestFile(file: File): String {
    check(file, false)
    val fd = Os.open(file.path, OsConstants.O_RDONLY or OsConstants.O_CLOEXEC or OsConstants.O_NOFOLLOW, 0)
    return FileInputStream(fd).use { input ->
      val opened = Os.fstat(fd)
      val named = Os.lstat(file.path)
      require(OsConstants.S_ISREG(opened.st_mode) && opened.st_ino == named.st_ino && opened.st_dev == named.st_dev && opened.st_size <= maxArchive)
      val digest = MessageDigest.getInstance("SHA-256")
      val buffer = ByteArray(32768)
      var total = 0L
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        total += count
        require(total <= maxArchive)
        digest.update(buffer, 0, count)
      }
      require(total == opened.st_size)
      check(file, false)
      digest.digest().joinToString("") { "%02x".format(it) }
    }
  }
  private fun verifyReceiptFiles(leaf: File, entries: JSONArray) {
    val actual = collect(leaf).associateBy { it.relativeTo(leaf).invariantSeparatorsPath }
    require(entries.length() in 1..257 && entries.length() == actual.size)
    val seen = mutableSetOf<String>()
    for (index in 0 until entries.length()) {
      val entry = entries.getJSONObject(index)
      val path = entry.getString("path")
      parts(path)
      require(seen.add(path))
      val file = actual[path] ?: error("Verified theme file missing")
      require(file.length() == entry.getLong("bytes") && digestFile(file) == entry.getString("sha256"))
    }
    require("archive.melotheme" in seen)
  }
  fun writeVerified(id: String, hash: String, context: String, payload: String, entries: List<Map<String, Any>>) {
    require(context.length <= 16384 && payload.toByteArray().size <= 512 * 1024)
    val leaf = installedLeaf(id, hash)
    val inventory = JSONArray(entries.map { JSONObject(it) })
    verifyReceiptFiles(leaf, inventory)
    val receipt = JSONObject().put("version", 1).put("context", context).put("payload", payload)
      .put("payloadSha256", MessageDigest.getInstance("SHA-256").digest(payload.toByteArray()).joinToString("") { "%02x".format(it) })
      .put("entries", inventory).toString().toByteArray()
    require(receipt.size <= 1024 * 1024)
    val destination = receiptFile(id, hash)
    if (stat(destination) != null) check(destination, false)
    metadata.writeAtomically(destination, receipt)
  }
  fun readVerified(id: String, hash: String, context: String): String? {
    require(context.length <= 16384)
    val leaf = installedLeaf(id, hash)
    val receipt = receiptFile(id, hash)
    if (stat(receipt) == null) return null
    // A missing/corrupt/stale receipt is a cache miss, never permission to skip
    // full validation. Receipts live outside all archive-controlled directories.
    return runCatching {
      val value = JSONObject(String(readFile(receipt, 1024 * 1024), Charsets.UTF_8))
      require(value.getInt("version") == 1 && value.getString("context") == context)
      val payload = value.getString("payload")
      require(MessageDigest.getInstance("SHA-256").digest(payload.toByteArray()).joinToString("") { "%02x".format(it) } == value.getString("payloadSha256"))
      verifyReceiptFiles(leaf, value.getJSONArray("entries"))
      payload
    }.getOrNull()
  }
  fun removeInstalled(id: String, hash: String, token: String) {
    require(Regex("^[a-z0-9-]{1,100}$").matches(token))
    val leaf = installedLeaf(id, hash)
    val receipt = receiptFile(id, hash)
    val completed = File(receipts, "removed-$token.json")
    // Retrying a completed cleanup must never delete a later reinstall of the
    // same archive. This tiny host marker survives process death and sessions.
    metadata.completeRemoval(completed, "$id/$hash") {
      if (stat(receipt) != null) { check(receipt, false); Os.remove(receipt.path) }
      syncDirectory(receipts)
      if (stat(leaf) != null) deleteTree(leaf)
      // Retry the parent sync even when a previous attempt already unlinked
      // the leaf, so a completion marker never precedes durable deletion.
      if (stat(leaf.parentFile!!) != null) syncDirectory(leaf.parentFile!!)
    }
  }
  fun readSelected(value: String): ByteArray {
    val selected = Uri.parse(value)
    require(selected.scheme == "content" || selected.scheme == "file") { "Only selected local documents may be read" }
    return context.contentResolver.openInputStream(selected)?.use { bounded(it, maxArchive) } ?: error("Cannot open selected theme")
  }
}
