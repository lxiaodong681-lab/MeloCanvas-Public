package expo.modules.orpheus.bilibili

import java.io.IOException
import okhttp3.CookieJar
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test

class AccountNetworkPolicyTest {
    @Test fun explicitCookieClientNeverFollowsRedirectsOrPersistsCookies() {
        assertFalse(NetworkModule.client.followRedirects)
        assertFalse(NetworkModule.client.followSslRedirects)
        assertSame(CookieJar.NO_COOKIES, NetworkModule.client.cookieJar)
        assertEquals(15000, NetworkModule.client.callTimeoutMillis)
    }
    @Test fun playbackApiCannotSendSessionToOtherOrigin() {
        NetworkModule.requireApiOrigin("https://api.bilibili.com/x/player/wbi/playurl".toHttpUrl())
        for (value in listOf("http://api.bilibili.com/x", "https://api.bilibili.com:444/x", "https://api.bilibili.com.evil.test/x", "https://i0.hdslb.com/x", "https://user@api.bilibili.com/x"))
            assertThrows(IOException::class.java) { NetworkModule.requireApiOrigin(value.toHttpUrl()) }
    }
}
