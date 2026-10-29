package expo.modules.bbplayernative

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ThemeMetadataStoreTest {
  @get:Rule val folder = TemporaryFolder()
  private val identity = "theme.example/" + "a".repeat(64)
  private fun store(
    write: (File, ByteArray) -> Unit = { file, bytes ->
      FileOutputStream(file).use { it.write(bytes); it.fd.sync() }
    },
    rename: (File, File) -> Unit = { from, to ->
      Files.move(from.toPath(), to.toPath(), ATOMIC_MOVE, REPLACE_EXISTING)
    },
    sync: (File) -> Unit = {},
    cleanup: (File) -> Unit = { Files.deleteIfExists(it.toPath()) },
  ) = ThemeMetadataStore(
    read = { if (it.exists()) it.readText() else null },
    writeSynced = write, rename = rename, syncDirectory = sync, removeTemporary = cleanup,
  )

  @Test fun partialWriteDoesNotPublishCompletionAndRestartCanRetry() {
    val marker = File(folder.root, "removed-token.json")
    val installed = folder.newFile("installed")
    val interrupted = store(write = { file, bytes ->
      FileOutputStream(file).use { it.write(bytes, 0, 7); it.fd.sync() }
      throw IOException("disk full")
    })
    assertThrows(IOException::class.java) {
      interrupted.completeRemoval(marker, identity) { installed.delete() }
    }
    assertFalse(installed.exists())
    assertFalse("An incomplete completion marker must never be visible", marker.exists())
    store().completeRemoval(marker, identity) { installed.delete() }
    assertEquals(identity, marker.readText())
    installed.writeText("reinstalled")
    store().completeRemoval(marker, identity) { fail("Late retry must preserve reinstall") }
    assertEquals("reinstalled", installed.readText())
  }

  @Test fun interruptedRenamePreservesReceiptAndOrphanDoesNotBlockRestart() {
    val destination = folder.newFile("receipt.json").apply { writeText("old") }
    val interrupted = store(
      rename = { _, _ -> throw IOException("interrupted before rename") },
      cleanup = {}, // Process death can leave the temporary file on disk.
    )
    assertThrows(IOException::class.java) { interrupted.writeAtomically(destination, "new".toByteArray()) }
    assertEquals("old", destination.readText())
    assertTrue(folder.root.listFiles()!!.any { it.extension == "tmp" })
    store().writeAtomically(destination, "new".toByteArray())
    assertEquals("new", destination.readText())
  }

  @Test fun publishesOnlyAfterFileSyncAndRetriesDirectorySyncBeforeAcknowledging() {
    val marker = File(folder.root, "removed-token.json")
    val events = mutableListOf<String>()
    val failing = store(
      write = { file, bytes ->
        assertFalse(marker.exists())
        FileOutputStream(file).use { it.write(bytes); it.fd.sync() }
        events.add("file synced")
      },
      rename = { from, to ->
        assertEquals(listOf("removed", "file synced"), events)
        Files.move(from.toPath(), to.toPath(), ATOMIC_MOVE)
        events.add("renamed")
      },
      sync = { assertEquals(identity, marker.readText()); throw IOException("directory sync failed") },
    )
    assertThrows(IOException::class.java) {
      failing.completeRemoval(marker, identity) { events.add("removed") }
    }
    assertEquals(listOf("removed", "file synced", "renamed"), events)
    store(sync = { events.add("directory synced") }).completeRemoval(marker, identity) {
      fail("Published completion must not remove files again")
    }
    assertEquals("directory synced", events.last())
  }

  @Test fun repairsLegacyPartialMarkerWithoutRepeatingDeletion() {
    for (partial in listOf("", identity.take(7))) {
      val marker = File(folder.root, "removed-legacy.json").apply { writeText(partial) }
      store().completeRemoval(marker, identity) { fail("Legacy marker was created after durable deletion") }
      assertEquals(identity, marker.readText())
    }
  }

  @Test fun mismatchedMarkerFailsClosedWithoutDeletingFiles() {
    val marker = folder.newFile("removed-token.json").apply { writeText("other.theme/" + "b".repeat(64)) }
    val before = marker.readText()
    assertThrows(IllegalArgumentException::class.java) {
      store().completeRemoval(marker, identity) { fail("Mismatched token must not remove files") }
    }
    assertEquals(before, marker.readText())
  }
}
