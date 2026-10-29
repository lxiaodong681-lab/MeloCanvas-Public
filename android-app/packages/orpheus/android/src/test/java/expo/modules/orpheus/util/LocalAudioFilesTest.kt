package expo.modules.orpheus.util

import java.io.File
import java.io.IOException
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class LocalAudioFilesTest {
    @get:Rule val temporary = TemporaryFolder()
    private val id = "12345678-90ab-4cde-8fab-123456789abc"

    private fun rejected(action: () -> Unit) {
        try { action(); fail("Expected file rejection") } catch (_: IOException) { }
    }

    @Test fun onlyAnExistingNonEmptyPrivateRegularFileCanResolve() {
        val files = temporary.newFolder("files")
        val directory = File(files, LocalAudioFiles.DIRECTORY).apply { mkdir() }
        rejected { LocalAudioFiles.requireFile(files, id) }
        val file = File(directory, id).apply { writeBytes(byteArrayOf()) }
        rejected { LocalAudioFiles.requireFile(files, id) }
        file.writeBytes(byteArrayOf(1, 2, 3))
        assertEquals(file.canonicalFile, LocalAudioFiles.requireFile(files, id))
        assertTrue(file.delete())
        assertTrue(file.mkdir())
        rejected { LocalAudioFiles.requireFile(files, id) }
    }

    @Test fun callerCannotUsePathsOrExtensionsToSelectAnotherFile() {
        val files = temporary.newFolder("files")
        for (invalid in listOf("../outside", "$id.mp3", "$id/", "file:///$id", id.uppercase())) {
            try { LocalAudioFiles.requireFile(files, invalid); fail(invalid) } catch (_: IllegalArgumentException) { }
        }
    }

    @Test fun aSymlinkedDirectoryCannotEscapeThePrivateRoot() {
        val files = temporary.newFolder("files")
        val outside = temporary.newFolder("outside")
        File(outside, id).writeText("audio")
        Files.createSymbolicLink(File(files, LocalAudioFiles.DIRECTORY).toPath(), outside.toPath())
        rejected { LocalAudioFiles.requireFile(files, id) }
    }

    @Test fun aSymlinkedFileCannotAliasEvenAnotherPrivateFile() {
        val files = temporary.newFolder("files")
        val directory = File(files, LocalAudioFiles.DIRECTORY).apply { mkdir() }
        val other = File(directory, "other").apply { writeText("audio") }
        Files.createSymbolicLink(File(directory, id).toPath(), other.toPath())
        rejected { LocalAudioFiles.requireFile(files, id) }
    }
}
