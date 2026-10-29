package expo.modules.orpheus.util

import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import java.io.File
import java.io.FileInputStream
import java.io.IOException

data class LocalAudioMetadata(
    val title: String?,
    val artist: String?,
    val durationSeconds: Double,
    val bytes: Long,
) {
    fun toJsMap(): Map<String, Any?> = mapOf(
        "title" to title, "artist" to artist, "durationSeconds" to durationSeconds, "bytes" to bytes,
    )
}

/** Only probes the completed private copy. No service, player, queue, or network is touched. */
object LocalAudioProbe {
    fun probe(filesDir: File, id: String): LocalAudioMetadata = try {
        readMetadata(filesDir, id)
    } catch (failure: Exception) {
        if (failure.message?.startsWith("LocalAudio") == true) throw failure
        throw IOException("LocalAudioUnsupported", failure)
    }

    private fun readMetadata(filesDir: File, id: String): LocalAudioMetadata {
        val file = LocalAudioFiles.requireFile(filesDir, id)
        val extractor = MediaExtractor()
        var audioDurationUs = 0L
        try {
            FileInputStream(file).use { input -> extractor.setDataSource(input.fd) }
            var hasAudio = false
            var hasVideo = false
            for (index in 0 until extractor.trackCount) {
                val format = extractor.getTrackFormat(index)
                val mime = format.getString(MediaFormat.KEY_MIME).orEmpty()
                if (mime.startsWith("video/")) hasVideo = true
                if (mime.startsWith("audio/")) {
                    hasAudio = true
                    if (format.containsKey(MediaFormat.KEY_DURATION)) {
                        audioDurationUs = maxOf(audioDurationUs, format.getLong(MediaFormat.KEY_DURATION))
                    }
                }
            }
            if (!hasAudio || hasVideo) throw IOException("LocalAudioNotAudio")
        } catch (failure: RuntimeException) {
            throw IOException("LocalAudioUnsupported", failure)
        } finally {
            extractor.release()
        }

        var title: String? = null
        var artist: String? = null
        var durationMs: Long? = null
        val metadata = MediaMetadataRetriever()
        try {
            FileInputStream(file).use { input -> metadata.setDataSource(input.fd) }
            title = metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE)?.trim()?.takeIf { it.isNotEmpty() }
            artist = metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST)?.trim()?.takeIf { it.isNotEmpty() }
            durationMs = metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
        } catch (_: RuntimeException) {
            // Missing/unsupported tags do not reject an audio stream already recognized above.
        } finally {
            metadata.release()
        }
        val durationSeconds = if (audioDurationUs > 0) audioDurationUs / 1_000_000.0
            else (durationMs ?: 0L) / 1000.0
        if (!durationSeconds.isFinite() || durationSeconds <= 0) throw IOException("LocalAudioUnknownDuration")
        return LocalAudioMetadata(title, artist, durationSeconds, file.length())
    }
}
