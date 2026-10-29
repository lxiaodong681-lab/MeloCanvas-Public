package expo.modules.bbplayernative

import java.io.File
import java.util.UUID

/** File operations are supplied by the private store, retaining its path/link checks. */
internal class ThemeMetadataStore(
  private val read: (File) -> String?,
  private val writeSynced: (File, ByteArray) -> Unit,
  private val rename: (File, File) -> Unit,
  private val syncDirectory: (File) -> Unit,
  private val removeTemporary: (File) -> Unit,
) {
  fun writeAtomically(destination: File, bytes: ByteArray) {
    val directory = destination.parentFile!!
    val temporary = File(directory, "${UUID.randomUUID()}.tmp")
    try {
      writeSynced(temporary, bytes)
      rename(temporary, destination)
      syncDirectory(directory)
    } finally {
      removeTemporary(temporary)
    }
  }

  fun completeRemoval(marker: File, identity: String, remove: () -> Unit) {
    val completed = read(marker)
    if (completed != null) {
      // Older versions created this marker only AFTER durable deletion, but
      // could leave a prefix on disk. Repair it without deleting a reinstall.
      require(identity.startsWith(completed)) { "Theme removal marker identity mismatch" }
      if (completed != identity) writeAtomically(marker, identity.toByteArray(Charsets.UTF_8))
      // A previous attempt may have published the marker but failed its fsync.
      else syncDirectory(marker.parentFile!!)
      return
    }
    remove()
    writeAtomically(marker, identity.toByteArray(Charsets.UTF_8))
  }
}
