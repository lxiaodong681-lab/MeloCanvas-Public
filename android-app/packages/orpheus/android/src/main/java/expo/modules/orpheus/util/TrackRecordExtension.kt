package expo.modules.orpheus.util

import android.os.Bundle
import androidx.core.net.toUri
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import expo.modules.orpheus.model.TrackRecord
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

fun TrackRecord.toMediaItem(context: android.content.Context? = null): MediaItem {
    val trackJson = Json.encodeToString(this)

    val extras = Bundle()
    extras.putString("track_json", trackJson)

    val downloadedCoverUri = context?.let { 
        expo.modules.orpheus.manager.CoverDownloadManager.getCoverFile(it, this.sourceId ?: this.id)?.absolutePath?.let { path -> "file://$path" }
    }

    val finalArtUri = downloadedCoverUri ?: this.artwork

    val artUri = if (!finalArtUri.isNullOrEmpty()) finalArtUri.toUri() else null

    val metadata = MediaMetadata.Builder()
        .setTitle(this.title)
        .setArtist(this.artist)
        .setArtworkUri(artUri)
        .setExtras(extras)
        .build()

    return MediaItem.Builder()
        .setMediaId(this.id)
        .setUri(this.url)
        .setMediaMetadata(metadata)
        .build()
}

/** Media IDs select queue occurrences; resume points always follow the underlying source. */
fun MediaItem.playbackSourceId(): String {
    val raw = mediaMetadata.extras?.getString("track_json") ?: return mediaId
    return runCatching { Json.decodeFromString<TrackRecord>(raw).sourceId ?: mediaId }.getOrDefault(mediaId)
}
