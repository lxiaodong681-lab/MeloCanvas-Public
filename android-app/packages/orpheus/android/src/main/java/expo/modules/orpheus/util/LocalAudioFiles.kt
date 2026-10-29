package expo.modules.orpheus.util

import java.io.File
import java.io.IOException

/** Runtime availability is separate from snapshot validity: a missing file must not destroy a queue. */
object LocalAudioFiles {
    const val DIRECTORY = "melo-local-audio"

    fun requireFile(filesDir: File, id: String): File {
        require(LocalAudioIdentity.validId(id)) { "LocalAudioInvalidIdentity" }
        val privateRoot = filesDir.canonicalFile
        val directory = File(privateRoot, DIRECTORY)
        val file = File(directory, id)
        // Reject both directory and file symlinks, including aliases to another private file.
        if (directory.canonicalFile != directory || file.canonicalFile != file) {
            throw IOException("LocalAudioInvalidFile")
        }
        if (!file.isFile || !file.canRead() || file.length() <= 0L) {
            throw IOException("LocalAudioUnavailable")
        }
        return file
    }
}
