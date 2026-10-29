package expo.modules.orpheus.network

import java.io.ByteArrayInputStream
import java.io.IOException
import org.junit.Assert.*
import org.junit.Test

class BilibiliAccountRequestTest {
    @Test fun apiSessionIsRestrictedToExactHttpsOrigin() {
        assertEquals("api.bilibili.com", BilibiliAccountRequest.validatedUrl("https://api.bilibili.com/x/web-interface/nav", "fixture-session").host)
        for (url in listOf("http://api.bilibili.com/x", "https://api.bilibili.com:444/x", "https://api.bilibili.com.evil.test/x", "https://user@api.bilibili.com/x", "https://@api.bilibili.com/x", "https://api.bilibili.com/x#fragment", "https://aisubtitle.hdslb.com/a.json"))
            assertThrows(IOException::class.java) { BilibiliAccountRequest.validatedUrl(url, "fixture-session") }
    }
    @Test fun passportNeverAcceptsAccountHeaderAndOnlyQrEndpoints() {
        val base = "https://passport.bilibili.com/x/passport-login/web/qrcode/"
        for (path in listOf("generate", "poll?qrcode_key=fixture")) {
            BilibiliAccountRequest.validatedUrl(base + path, "")
            assertThrows(IOException::class.java) { BilibiliAccountRequest.validatedUrl(base + path, "fixture-session") }
        }
        assertThrows(IOException::class.java) { BilibiliAccountRequest.validatedUrl("https://passport.bilibili.com/other", "") }
    }
    @Test fun headerInjectionIsRejected() {
        assertThrows(IOException::class.java) { BilibiliAccountRequest.validatedUrl("https://api.bilibili.com/x", "fixture\r\nOther: header") }
    }
    @Test fun responseSizeLimitIsEnforcedBeforeAccumulatingOversizedBody() {
        assertEquals("{}", BilibiliAccountRequest.limitedText(ByteArrayInputStream("{}".toByteArray())))
        assertThrows(IOException::class.java) { BilibiliAccountRequest.limitedText(ByteArrayInputStream(ByteArray(1024 * 1024 + 1))) }
    }
    @Test fun subtitlesAreNoCredentialSeparateExactOriginsAndPaths() {
        for (host in listOf("aisubtitle.hdslb.com", "i0.hdslb.com"))
            BilibiliAccountRequest.validatedSubtitleUrl("https://$host/bfs/subtitle/fixture.json")
        for (url in listOf("https://api.bilibili.com/bfs/subtitle/x", "https://aisubtitle.hdslb.com/other/x", "http://i0.hdslb.com/bfs/subtitle/x", "https://@i0.hdslb.com/bfs/subtitle/x", "https://i0.hdslb.com:444/bfs/subtitle/x", "https://i0.hdslb.com/bfs/subtitle/x#fragment"))
            assertThrows(IOException::class.java) { BilibiliAccountRequest.validatedSubtitleUrl(url) }
    }
    @Test fun subtitleBodyHasIndependentTwoMiBLimit() {
        assertEquals(1024 * 1024 + 1, BilibiliAccountRequest.limitedText(ByteArrayInputStream(ByteArray(1024 * 1024 + 1)), 2 * 1024 * 1024).length)
        assertThrows(IOException::class.java) { BilibiliAccountRequest.limitedText(ByteArrayInputStream(ByteArray(2 * 1024 * 1024 + 1)), 2 * 1024 * 1024) }
    }

}
