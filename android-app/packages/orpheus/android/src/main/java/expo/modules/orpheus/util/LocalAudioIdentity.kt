package expo.modules.orpheus.util

/** Stable content identity, never a caller-provided path or a provider permission. */
object LocalAudioIdentity {
    private val uuid = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
    private const val SOURCE_PREFIX = "local:"
    private const val URI_PREFIX = "orpheus://local-audio?id="

    fun validId(id: String): Boolean = uuid.matches(id)

    fun sourceId(id: String): String {
        require(validId(id)) { "LocalAudioInvalidIdentity" }
        return SOURCE_PREFIX + id
    }

    fun uri(id: String): String {
        require(validId(id)) { "LocalAudioInvalidIdentity" }
        return URI_PREFIX + id
    }

    fun idFromUri(uri: String): String? = uri.takeIf { it.startsWith(URI_PREFIX) }
        ?.removePrefix(URI_PREFIX)?.takeIf(::validId)

    fun isValid(source: String, uri: String): Boolean =
        idFromUri(uri)?.let { source == sourceId(it) } == true
}
