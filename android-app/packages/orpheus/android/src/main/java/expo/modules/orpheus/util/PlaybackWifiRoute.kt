package expo.modules.orpheus.util

/** VPN itself is not disqualifying: Android reports its underlying transports on its capabilities. */
object PlaybackWifiRoute {
    fun classify(wifi: Boolean, cellular: Boolean, other: Boolean, internet: Boolean): String = when {
        !internet -> "offline"
        wifi && !cellular && !other -> "wifi"
        wifi && (cellular || other) -> "mixed"
        cellular -> "cellular"
        else -> "unverified"
    }
}
