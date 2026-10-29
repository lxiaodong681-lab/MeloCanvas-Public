package expo.modules.orpheus.widget

import kotlinx.serialization.json.*

/** A bounded mirror of a committed theme, never a theme-install or playback authority. */
data class WidgetThemeProjection(
    val revision: Long,
    val selection: JsonObject,
    val themeVersion: String,
    val colors: Map<String, String>,
    val card: String,
    val button: String,
    val progress: String,
    val decoration: String,
) {
    fun encode(): String = buildJsonObject {
        put("schemaVersion", 1)
        put("registryRevision", revision)
        put("selection", selection)
        put("themeVersion", themeVersion)
        put("colors", JsonObject(colors.mapValues { JsonPrimitive(it.value) }))
        put("variants", buildJsonObject { put("card", card); put("button", button); put("progress", progress) })
        put("decoration", decoration)
        put("fallback", "modern")
    }.toString()

    fun updateResult(previous: WidgetThemeProjection?): String = when {
        previous == null -> "applied"
        revision < previous.revision -> "stale"
        revision > previous.revision -> "applied"
        this == previous -> "unchanged"
        else -> error("Widget theme revision conflicts with the saved projection")
    }

    companion object {
        private val variants = setOf("rounded", "leaf", "comic")
        private val colorNames = setOf("card", "textPrimary", "textSecondary", "accent", "border")
        /** Preserve the approved white icon whenever non-text contrast reaches 3:1. */
        fun playIconColor(accent: String): Int {
            val rgb = accent.substring(1).toInt(16)
            fun linear(value: Int): Double {
                val channel = value / 255.0
                return if (channel <= .04045) channel / 12.92 else Math.pow((channel + .055) / 1.055, 2.4)
            }
            val luminance = .2126 * linear(rgb shr 16 and 255) + .7152 * linear(rgb shr 8 and 255) + .0722 * linear(rgb and 255)
            return if (1.05 / (luminance + .05) >= 3.0) -1 else -16777216
        }
        private fun fields(value: JsonElement?, names: Set<String>): JsonObject {
            val obj = value as? JsonObject ?: error("Widget theme field must be an object")
            require(obj.keys == names) { "Widget theme fields are missing or unsupported" }
            return obj
        }
        private fun text(value: JsonElement?): String {
            val primitive = value as? JsonPrimitive ?: error("Widget theme string is missing")
            require(primitive.isString && primitive.content.isNotBlank() && primitive.content == primitive.content.trim()) {
                "Invalid widget theme string"
            }
            return primitive.content
        }
        fun parse(raw: String): WidgetThemeProjection {
            require(raw.length <= 8192 && raw.toByteArray(Charsets.UTF_8).size <= 8192) { "Widget theme projection is too large" }
            var depth = 0
            var quoted = false
            var escaped = false
            for (char in raw) {
                if (quoted) {
                    if (escaped) escaped = false else if (char == '\\') escaped = true else if (char == '"') quoted = false
                } else when (char) {
                    '"' -> quoted = true
                    '{', '[' -> { depth++; require(depth <= 8) { "Widget theme nesting is too deep" } }
                    '}', ']' -> depth--
                }
            }
            val root = fields(Json.parseToJsonElement(raw), setOf(
                "schemaVersion", "registryRevision", "selection", "themeVersion", "colors", "variants", "decoration", "fallback",
            ))
            require(root["schemaVersion"] == JsonPrimitive(1)) { "Unsupported widget theme version" }
            val revision = (root["registryRevision"] as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull
                ?: error("Invalid widget theme revision")
            require(revision in 0..9007199254740991L) { "Invalid widget theme revision" }
            val pointer = root["selection"] as? JsonObject ?: error("Invalid widget theme selection")
            val selection = when (text(pointer["kind"])) {
                "builtin" -> {
                    fields(pointer, setOf("kind", "key"))
                    val key = text(pointer["key"])
                    require(key in setOf("modern", "pastoral", "anime")) { "Invalid built-in widget theme" }
                    buildJsonObject { put("kind", "builtin"); put("key", key) }
                }
                "package" -> {
                    fields(pointer, setOf("kind", "id", "archiveSha256"))
                    val id = text(pointer["id"])
                    val hash = text(pointer["archiveSha256"])
                    require(Regex("[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+").matches(id) && Regex("[a-f0-9]{64}").matches(hash)) {
                        "Invalid package widget theme identity"
                    }
                    buildJsonObject { put("kind", "package"); put("id", id); put("archiveSha256", hash) }
                }
                else -> error("Invalid widget theme selection")
            }
            val colors = fields(root["colors"], colorNames).mapValues { (_, value) ->
                text(value).also { require(Regex("#[a-fA-F0-9]{6}").matches(it)) { "Invalid widget theme color" } }.lowercase()
            }
            val styles = fields(root["variants"], setOf("card", "button", "progress"))
            val card = text(styles["card"]).also { require(it in variants) { "Unsupported widget card" } }
            val button = text(styles["button"]).also { require(it in variants) { "Unsupported widget button" } }
            val progress = text(styles["progress"]).also { require(it in setOf("modern", "pastoral", "anime")) { "Unsupported widget progress" } }
            val decoration = text(root["decoration"]).also { require(it in setOf("none", "botanical", "stars")) { "Unsupported widget decoration" } }
            require(text(root["fallback"]) == "modern") { "Unsupported widget fallback" }
            return WidgetThemeProjection(revision, selection, text(root["themeVersion"]), colors, card, button, progress, decoration)
        }

        val modern: WidgetThemeProjection by lazy {
            parse("""{"schemaVersion":1,"registryRevision":0,"selection":{"kind":"builtin","key":"modern"},"themeVersion":"0.1.0-design","colors":{"card":"#fffdf9","textPrimary":"#292925","textSecondary":"#716f68","accent":"#ce4c3c","border":"#e9e5dd"},"variants":{"card":"rounded","button":"rounded","progress":"modern"},"decoration":"none","fallback":"modern"}""")
        }
    }
}
