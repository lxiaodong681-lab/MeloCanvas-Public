package expo.modules.orpheus.util

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.net.Network
import android.os.Handler
import android.os.Looper
import androidx.media3.exoplayer.offline.DownloadManager
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener
import androidx.media3.datasource.cache.ContentMetadata
import androidx.media3.exoplayer.offline.Download
import expo.modules.orpheus.OrpheusConfig
import expo.modules.orpheus.manager.DownloadCache
import java.io.IOException
import okhttp3.Call
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import expo.modules.orpheus.network.OkHttpClientManager

/** Explicit saves only. Playback LRU fragments never qualify as a saved download. */
@UnstableApi
object OfflineDownloadPolicy {
    private const val MIN_LIMIT = 64L * 1024 * 1024
    private const val MAX_LIMIT = 64L * 1024 * 1024 * 1024
    private const val FREE_RESERVE = 32L * 1024 * 1024
    private fun prefs(context: Context) = context.getSharedPreferences("melo-offline", Context.MODE_PRIVATE)
    fun limit(context: Context): Long {
        val preferences = prefs(context)
        return OfflineIntegrity.storageLimit(
            if (preferences.contains("limit")) preferences.getLong("limit", 0) else null,
        )
    }
    fun setLimit(context: Context, bytes: Long) {
        require(DownloadUtil.getDownloadManager(context).currentDownloads.none { it.state == Download.STATE_DOWNLOADING }) { "请先暂停下载再修改上限" }
        require(bytes in MIN_LIMIT..MAX_LIMIT) { "离线容量上限须为 64 MiB 至 64 GiB" }
        require(bytes >= DownloadCache.getStableCache(context).cacheSpace) { "上限小于已保存内容，请先手动清理" }
        check(prefs(context).edit().putLong("limit", bytes).commit()) { "无法保存离线容量设置" }
    }
    fun requireWifi(context: Context) {
        if (!OrpheusConfig.hasAccountSession()) throw IOException("Bilibili account login required")
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val capabilities = manager.getNetworkCapabilities(manager.activeNetwork)
        if (!wifiRoute(capabilities)) {
            throw IOException("离线保存仅在已连接互联网的 Wi-Fi 下进行；请连接后手动重试")
        }
    }
    private fun wifiRoute(capabilities: NetworkCapabilities?): Boolean {
        val other = capabilities != null && listOf(
            NetworkCapabilities.TRANSPORT_BLUETOOTH, NetworkCapabilities.TRANSPORT_ETHERNET,
            NetworkCapabilities.TRANSPORT_WIFI_AWARE, NetworkCapabilities.TRANSPORT_LOWPAN,
            NetworkCapabilities.TRANSPORT_USB, NetworkCapabilities.TRANSPORT_THREAD,
            NetworkCapabilities.TRANSPORT_SATELLITE,
        ).any { capabilities.hasTransport(it) }
        val route = PlaybackWifiRoute.classify(
            capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true,
            capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true,
            other, capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true,
        )
        return route == "wifi"
    }
    private val activeTransfers = ConcurrentHashMap<String, () -> Unit>()
    fun cancelUri(uri: String) { activeTransfers[uri]?.invoke() }
    private val activeResolutions = ConcurrentHashMap.newKeySet<retrofit2.Call<*>>()
    private val activeCalls = ConcurrentHashMap.newKeySet<Call>()
    private var observer: ConnectivityManager.NetworkCallback? = null
    private var observedDownloads: DownloadManager? = null
    fun cancelAccountWork() {
        activeTransfers.values.forEach { it.invoke() }
        activeCalls.forEach { it.cancel() }
        activeResolutions.forEach { it.cancel() }
        Handler(Looper.getMainLooper()).post {
            observedDownloads?.let { downloads ->
                downloads.currentDownloads.filter { it.request.id.startsWith("melo-offline:") &&
                    it.state in listOf(Download.STATE_QUEUED, Download.STATE_DOWNLOADING, Download.STATE_RESTARTING) }
                    .forEach { downloads.setStopReason(it.request.id, 2) }
            }
        }
    }
    /** Wi-Fi loss stops each explicit task persistently; reconnect never silently resumes it. */
    fun observe(context: Context, downloads: DownloadManager) {
        observedDownloads = downloads
        if (observer != null) return
        val handler = Handler(Looper.getMainLooper())
        fun stopForNetwork() {
            // Cancel immediately on the callback thread, before main-thread state publication.
            activeTransfers.values.forEach { it.invoke() }
            activeCalls.forEach { it.cancel() }
            activeResolutions.forEach { it.cancel() }
            handler.post {
                downloads.currentDownloads.filter { it.request.id.startsWith("melo-offline:") && it.state in listOf(Download.STATE_QUEUED, Download.STATE_DOWNLOADING, Download.STATE_RESTARTING) }
                    .forEach { downloads.setStopReason(it.request.id, 2) }
            }
        }
        observer = object : ConnectivityManager.NetworkCallback() {
            override fun onLost(network: Network) { stopForNetwork() }
            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
                if (!wifiRoute(capabilities)) stopForNetwork()
            }
        }
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        manager.registerDefaultNetworkCallback(observer!!)
        if (runCatching { requireWifi(context) }.isFailure) stopForNetwork()
    }
    fun verified(context: Context, download: Download): Boolean {
        if (download.state != Download.STATE_COMPLETED) return false
        return runCatching {
        val cache = DownloadCache.getStableCache(context)
        val key = download.request.customCacheKey ?: download.request.uri.toString()
        val length = ContentMetadata.getContentLength(cache.getContentMetadata(key))
        OfflineIntegrity.complete(length, download.contentLength) { _, size -> completeFiles(context, key, size) }
        }.getOrDefault(false)
    }
    /** Index coverage alone can outlive files removed or truncated during this process. */
    fun completeFiles(context: Context, key: String, length: Long): Boolean = runCatching {
        val cache = DownloadCache.getStableCache(context)
        length > 0 && cache.isCached(key, 0, length) && OfflineFileCoverage.complete(
            length,
            cache.getCachedSpans(key).map { OfflineFileSpan(it.position, it.length, it.file) },
        )
    }.getOrDefault(false)
    fun factory(context: Context, source: (Call.Factory, (retrofit2.Call<*>) -> Unit) -> DataSource): DataSource.Factory = DataSource.Factory {
        val cancelled = AtomicBoolean(false)
        val ownedResolutions = ConcurrentHashMap.newKeySet<retrofit2.Call<*>>()
        val ownedCalls = ConcurrentHashMap.newKeySet<Call>()
        val calls = Call.Factory { request ->
            requireWifi(context)
            if (cancelled.get()) throw IOException("下载已取消")
            OkHttpClientManager.okHttpClient.newCall(request).also { activeCalls.add(it); ownedCalls.add(it); if (cancelled.get()) it.cancel() }
        }
        GuardedSource(context.applicationContext, source(calls) { call ->
            requireWifi(context)
            if (cancelled.get()) { call.cancel(); throw IOException("下载已取消") }
            activeResolutions.add(call); ownedResolutions.add(call)
            if (cancelled.get()) call.cancel()
        }, cancel = { cancelled.set(true); ownedCalls.forEach { it.cancel() }; ownedResolutions.forEach { it.cancel() } }) {
            ownedResolutions.forEach { activeResolutions.remove(it) }; ownedResolutions.clear()
            ownedCalls.forEach { activeCalls.remove(it) }
            ownedCalls.clear()
        }
    }

    private class GuardedSource(val context: Context, val upstream: DataSource, val cancel: () -> Unit, val release: () -> Unit) : DataSource {
        private var key: String? = null
        private var transfer: OfflineTransferLength? = null
        override fun addTransferListener(listener: TransferListener) = upstream.addTransferListener(listener)
        override fun getUri(): Uri? = upstream.uri
        override fun getResponseHeaders(): Map<String, List<String>> = upstream.responseHeaders
        override fun close() { try { upstream.close() } finally { key?.let { activeTransfers.remove(it, cancel) }; key = null; release() } }
        override fun open(spec: DataSpec): Long {
            requireWifi(context)
            val cap = limit(context)
            if (cap == 0L) throw IOException("请先设置离线保存容量上限")
            try {
                key = spec.uri.toString()
                activeTransfers[key!!] = cancel
                val length = upstream.open(spec)
                // Unknown/chunked lengths cannot be promised complete or safely reserved.
                val used = DownloadCache.getStableCache(context).cacheSpace
                OfflineIntegrity.reserve(length, used, cap, context.filesDir.usableSpace, FREE_RESERVE)
                transfer = OfflineTransferLength(length)
                return length
            } catch (error: Exception) {
                try { close() } catch (_: Exception) { }
                throw error
            }
        }
        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            requireWifi(context)
            if (context.filesDir.usableSpace < FREE_RESERVE) throw IOException("设备存储空间不足，下载已中断")
            if (length == 0) return 0
            val budget = transfer ?: throw IOException("Download not open")
            val result = upstream.read(buffer, offset, minOf(length.toLong(), budget.remaining + 1).toInt())
            budget.read(result)
            return result
        }
    }
}
