package expo.modules.orpheus.util

import android.content.Context
import android.net.Uri
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener
import androidx.media3.datasource.cache.ContentMetadata
import expo.modules.orpheus.OrpheusConfig
import expo.modules.orpheus.manager.DownloadCache
import java.io.IOException

/** Offline account playback never falls back to HTTP, even after files disappear. */
@UnstableApi
object OfflinePlaybackDataSource {
    private const val SUFFIX = OfflinePlaybackRoute.SUFFIX
    fun isOfflineUri(uri: String) = uri.endsWith(SUFFIX)
    fun check(context: Context, uri: String): Boolean = OfflinePlaybackRoute.cacheKey(
        uri, OrpheusConfig.hasPlaybackAccess(), OrpheusConfig.hasAccountSession(),
    ) { key ->
        val cache = DownloadCache.getStableCache(context)
        val length = ContentMetadata.getContentLength(cache.getContentMetadata(key))
        OfflineDownloadPolicy.completeFiles(context, key, length)
    } != null
    fun factory(context: Context, online: DataSource.Factory): DataSource.Factory = DataSource.Factory {
        object : DataSource {
            // Capture the playback epoch when this loadable is created, not on each retry.
            private val onlineOwner = OfflineUpstreamOwner { online.createDataSource() }
            private var active: DataSource? = null
            private val listeners = mutableListOf<TransferListener>()
            override fun addTransferListener(listener: TransferListener) { listeners.add(listener); active?.addTransferListener(listener) }
            override fun getUri(): Uri? = active?.uri
            override fun getResponseHeaders(): Map<String, List<String>> = active?.responseHeaders ?: emptyMap()
            override fun open(spec: DataSpec): Long {
                val offline = check(context, spec.uri.toString())
                val source = if (offline) DownloadUtil.getReadOnlyCacheDataSource(context) else onlineOwner.source
                active = source
                listeners.forEach(source::addTransferListener)
                val request = if (offline) {
                    val key = spec.uri.toString().removeSuffix(SUFFIX)
                    spec.buildUpon().setUri(key).setKey(key).build()
                } else spec
                return source.open(request)
            }
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int =
                (active ?: throw IOException("Data source not open")).read(buffer, offset, length)
            override fun close() { try { active?.close() } finally { active = null } }
        }
    }
}
