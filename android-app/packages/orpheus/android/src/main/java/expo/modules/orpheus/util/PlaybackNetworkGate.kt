package expo.modules.orpheus.util

import java.io.Closeable
import java.io.IOException

/** Pure playback request ownership. An interrupted lease never revives when Wi-Fi returns. */
class PlaybackNetworkGate {
    private val lock = Any()
    private var enabled = false
    private var wifi = false
    private var generation = 0L
    private val leases = mutableSetOf<Lease>()

    fun update(newEnabled: Boolean? = null, newWifi: Boolean? = null): Boolean {
        val cancel: List<() -> Unit>
        val interrupted: Boolean
        synchronized(lock) {
            val wasBlocked = enabled && !wifi
            newEnabled?.let { enabled = it }
            newWifi?.let { wifi = it }
            interrupted = enabled && !wifi && !wasBlocked
            cancel = if (interrupted) {
                generation++
                leases.flatMap { it.cancellations.toList() }
            } else emptyList()
        }
        cancel.forEach { runCatching(it) }
        return interrupted
    }
    fun state(): Map<String, Any> = synchronized(lock) {
        mapOf("enabled" to enabled, "wifiAvailable" to wifi, "blocked" to (enabled && !wifi),
            "reason" to if (enabled && !wifi) "wifi_required" else "allowed")
    }
    fun blocked(): Boolean = synchronized(lock) { enabled && !wifi }
    fun epoch(): Long = synchronized(lock) { generation }
    fun begin(expectedEpoch: Long? = null): Lease = synchronized(lock) {
        if ((expectedEpoch != null && expectedEpoch != generation) || (enabled && !wifi)) throw IOException("WiFiPlaybackRequired")
        Lease(generation).also { leases.add(it) }
    }
    inner class Lease internal constructor(private val epoch: Long) : Closeable {
        internal val cancellations = mutableListOf<() -> Unit>()
        private var closed = false
        fun check() = synchronized(lock) {
            if (closed || epoch != generation || (enabled && !wifi)) throw IOException("WiFiPlaybackRequired")
        }
        fun register(cancel: () -> Unit) {
            synchronized(lock) {
                if (!closed && epoch == generation && !(enabled && !wifi)) {
                    cancellations.add(cancel)
                    return
                }
            }
            cancel()
            throw IOException("WiFiPlaybackRequired")
        }
        override fun close() { synchronized(lock) { closed = true; cancellations.clear(); leases.remove(this) } }
    }
}
