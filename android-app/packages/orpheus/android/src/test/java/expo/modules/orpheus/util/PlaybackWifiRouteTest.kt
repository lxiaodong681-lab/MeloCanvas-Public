package expo.modules.orpheus.util

import org.junit.Assert.assertEquals
import org.junit.Test

class PlaybackWifiRouteTest {
    @Test fun knownWifiIncludingVpnUnderlyingWifiIsAllowed() {
        assertEquals("wifi", PlaybackWifiRoute.classify(true, false, false, true))
    }
    @Test fun vpnWithoutReportedUnderlyingWifiIsUnverified() {
        assertEquals("unverified", PlaybackWifiRoute.classify(false, false, false, true))
    }
    @Test fun cellularAndMixedRoutesAreNotWifi() {
        assertEquals("cellular", PlaybackWifiRoute.classify(false, true, false, true))
        assertEquals("mixed", PlaybackWifiRoute.classify(true, true, false, true))
        assertEquals("mixed", PlaybackWifiRoute.classify(true, false, true, true))
    }
    @Test fun noInternetCapabilityIsNotAllowed() {
        assertEquals("offline", PlaybackWifiRoute.classify(true, false, false, false))
    }
}
