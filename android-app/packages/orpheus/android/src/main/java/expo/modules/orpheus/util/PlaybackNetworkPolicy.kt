package expo.modules.orpheus.util

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper

/** Playback-only policy. Downloads, search and the shared HTTP client's dispatcher are untouched. */
object PlaybackNetworkPolicy {
    private val lock = Any()
    private val main = Handler(Looper.getMainLooper())
    private var context: Context? = null
    private var manager: ConnectivityManager? = null
    private val gate = PlaybackNetworkGate()
    private var activeNetwork: Network? = null
    @Volatile private var networkReason = "unverified"
    private val listeners = mutableSetOf<(Boolean) -> Unit>()
    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            synchronized(lock) {
                val changed = activeNetwork != network
                activeNetwork = network
                // API 26+ follows with capabilities; do not query stale state in this callback.
                if (changed) applyCapabilities(null)
            }
        }
        override fun onLost(network: Network) {
            synchronized(lock) {
                if (activeNetwork == network) {
                    activeNetwork = null
                    applyCapabilities(null)
                }
            }
        }
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
            synchronized(lock) {
                if (activeNetwork == network) applyCapabilities(capabilities)
            }
        }
    }

    @Synchronized fun initialize(value: Context) {
        if (context != null) return
        context = value.applicationContext
        gate.update(newEnabled = value.getSharedPreferences("playback_network_policy", Context.MODE_PRIVATE).getBoolean("wifiOnly", false))
        manager = value.getSystemService(ConnectivityManager::class.java)
        runCatching { manager?.registerDefaultNetworkCallback(callback) }
        refresh()
    }

    private fun refresh() = synchronized(lock) {
        val caps = runCatching {
            val cm = manager ?: return@runCatching null
            val current = cm.activeNetwork
            synchronized(lock) { activeNetwork = current }
            current?.let { cm.getNetworkCapabilities(it) }
        }.getOrNull()
        applyCapabilities(caps)
    }

    private fun applyCapabilities(caps: NetworkCapabilities?) = synchronized(lock) {
        // Constants are inlined; hasTransport exists since API 21. No newer runtime getter is used.
        val other = caps != null && listOf(
            NetworkCapabilities.TRANSPORT_BLUETOOTH, NetworkCapabilities.TRANSPORT_ETHERNET,
            NetworkCapabilities.TRANSPORT_WIFI_AWARE, NetworkCapabilities.TRANSPORT_LOWPAN,
            NetworkCapabilities.TRANSPORT_USB, NetworkCapabilities.TRANSPORT_THREAD,
            NetworkCapabilities.TRANSPORT_SATELLITE,
        ).any { caps.hasTransport(it) }
        val oldReason = networkReason
        networkReason = PlaybackWifiRoute.classify(
            caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true,
            caps?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true,
            other, caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true,
        )
        update(null, networkReason == "wifi", oldReason != networkReason)
    }

    fun setEnabled(value: Boolean) {
        checkNotNull(context).getSharedPreferences("playback_network_policy", Context.MODE_PRIVATE)
            .edit().putBoolean("wifiOnly", value).commit().also { check(it) { "Playback policy could not be saved" } }
        update(value, null)
    }

    private fun update(newEnabled: Boolean?, newWifi: Boolean?, reasonChanged: Boolean = false) = synchronized(lock) {
        val old = gate.state()
        val interrupted = gate.update(newEnabled, newWifi)
        if (old == gate.state() && !reasonChanged) return@synchronized
        val notify = synchronized(lock) { listeners.toList() }
        main.post { notify.forEach { it(interrupted) } }
    }
    fun refreshState(): Map<String, Any> { refresh(); return state() }
    fun state(): Map<String, Any> = synchronized(lock) { gate.state() + ("networkReason" to networkReason) }
    fun blocked(): Boolean = gate.blocked()
    fun addListener(listener: (Boolean) -> Unit) { synchronized(lock) { listeners.add(listener) } }
    fun removeListener(listener: (Boolean) -> Unit) { synchronized(lock) { listeners.remove(listener) } }
    fun epoch(): Long = gate.epoch()
    fun begin(expectedEpoch: Long? = null): PlaybackNetworkGate.Lease = gate.begin(expectedEpoch)
}
