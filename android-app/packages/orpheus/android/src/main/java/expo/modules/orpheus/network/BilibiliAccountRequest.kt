package expo.modules.orpheus.network

import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.TimeUnit

/** Auth transport only. Never use this for subtitle/media CDNs or arbitrary URLs. */
object BilibiliAccountRequest {
    private const val MAX_BODY_BYTES = 1024 * 1024
    private const val MAX_COOKIE_CHARS = 16 * 1024
    private const val GENERATE = "/x/passport-login/web/qrcode/generate"
    private const val POLL = "/x/passport-login/web/qrcode/poll"
    private val client by lazy {
        // Deliberately independent of any cookie jar, interceptor or shared account client.
        OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .cookieJar(CookieJar.NO_COOKIES)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .callTimeout(15, TimeUnit.SECONDS)
            .build()
    }

    internal fun validatedUrl(value: String, cookie: String): HttpUrl {
        val authority = try { java.net.URI(value).rawAuthority }
            catch (_: Exception) { throw IOException("Invalid Bilibili account destination") }
        if (authority == null || authority.contains('@')) throw IOException("Invalid Bilibili account destination")
        val url = value.toHttpUrlOrNull() ?: throw IOException("Invalid Bilibili account destination")
        if (url.scheme != "https" || url.port != 443 || url.username.isNotEmpty() ||
            url.password.isNotEmpty() || url.fragment != null ||
            url.host !in setOf("api.bilibili.com", "passport.bilibili.com"))
            throw IOException("Invalid Bilibili account destination")
        if (cookie.length > MAX_COOKIE_CHARS || cookie.any { it.code < 32 || it.code == 127 })
            throw IOException("Invalid Bilibili account session")
        if (url.host == "passport.bilibili.com" &&
            (url.encodedPath !in setOf(GENERATE, POLL) || cookie.isNotEmpty()))
            throw IOException("Invalid Bilibili account destination")
        return url
    }

    internal fun limitedText(input: InputStream, limit: Int = MAX_BODY_BYTES): String {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        var total = 0
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            total += count
            if (total > limit) throw IOException("Bilibili account response too large")
            output.write(buffer, 0, count)
        }
        return output.toString(Charsets.UTF_8.name())
    }

    fun get(value: String, cookie: String): Map<String, Any> {
        try {
            val url = validatedUrl(value, cookie)
            val builder = Request.Builder().url(url)
                .header("User-Agent", "Mozilla/5.0")
                .header("Referer", "https://www.bilibili.com/")
                .get()
            if (url.host == "api.bilibili.com" && cookie.isNotEmpty()) builder.header("Cookie", cookie)
            return client.newCall(builder.build()).execute().use { response ->
                // Do not pass a redirect target, body or any auth headers back to JS.
                if (response.code in 300..399) return@use mapOf(
                    "status" to response.code, "body" to "", "setCookie" to "",
                )
                val body = response.body
                if ((body?.contentLength() ?: 0L) > MAX_BODY_BYTES)
                    throw IOException("Bilibili account response too large")
                val text = body?.byteStream()?.use { limitedText(it) }.orEmpty()
                val cookies = if (url.host == "passport.bilibili.com" && url.encodedPath == POLL && response.isSuccessful)
                    response.headers.values("Set-Cookie").joinToString(", ") else ""
                if (cookies.length > MAX_COOKIE_CHARS) throw IOException("Bilibili account response too large")
                mapOf("status" to response.code, "body" to text, "setCookie" to cookies)
            }
        } catch (_: Exception) {
            // OkHttp errors can contain complete request URLs. Never propagate those or a cause.
            throw IOException("Bilibili account request failed")
        }
    }

    internal fun validatedSubtitleUrl(value: String): HttpUrl {
        val authority = try { java.net.URI(value).rawAuthority }
            catch (_: Exception) { throw IOException("Invalid subtitle destination") }
        if (authority == null || authority.contains('@')) throw IOException("Invalid subtitle destination")
        val url = value.toHttpUrlOrNull() ?: throw IOException("Invalid subtitle destination")
        if (url.scheme != "https" || url.port != 443 || url.username.isNotEmpty() ||
            url.password.isNotEmpty() || url.fragment != null ||
            url.host !in setOf("aisubtitle.hdslb.com", "i0.hdslb.com") ||
            !url.encodedPath.startsWith("/bfs/subtitle/"))
            throw IOException("Invalid subtitle destination")
        return url
    }

    /** Separate no-credential entry point; never expands the account request allowlist. */
    fun subtitle(value: String): Map<String, Any> {
        try {
            val url = validatedSubtitleUrl(value)
            val request = Request.Builder().url(url).header("Accept", "application/json").get().build()
            return client.newCall(request).execute().use { response ->
                if (response.code in 300..399) return@use mapOf(
                    "status" to response.code, "body" to "", "url" to value,
                )
                val body = response.body
                if ((body?.contentLength() ?: 0L) > 2 * MAX_BODY_BYTES)
                    throw IOException("Subtitle response too large")
                val text = body?.byteStream()?.use { limitedText(it, 2 * MAX_BODY_BYTES) }.orEmpty()
                mapOf("status" to response.code, "body" to text, "url" to value)
            }
        } catch (_: Exception) {
            throw IOException("Bilibili subtitle request failed")
        }
    }

}
