package expo.modules.orpheus.widget

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class WidgetThemeProjectionTest {
    private val base = WidgetThemeProjection.modern.encode()
    private fun changed(key: String, value: JsonElement): String = JsonObject(Json.parseToJsonElement(base).jsonObject + (key to value)).toString()

    @Test fun revisionConflictDoesNotReplaceThePriorThemeAndOldWritesAreStale() {
        val current = WidgetThemeProjection.parse(changed("registryRevision", JsonPrimitive(5)))
        assertEquals("stale", WidgetThemeProjection.modern.updateResult(current))
        assertEquals("unchanged", WidgetThemeProjection.parse(current.encode()).updateResult(current))
        val conflicting = current.copy(themeVersion = "new")
        assertTrue(runCatching { conflicting.updateResult(current) }.isFailure)
        assertEquals("0.1.0-design", current.themeVersion)
        assertEquals("applied", current.copy(revision = 6).updateResult(current))
    }

    @Test fun objectOrderAndColorCaseDoNotCreateFalseConflicts() {
        val root = Json.parseToJsonElement(base).jsonObject
        val reversed = JsonObject(root.entries.reversed().associate { it.key to it.value }.toMutableMap().apply {
            put("selection", JsonObject(root.getValue("selection").jsonObject.entries.reversed().associate { it.key to it.value }))
            put("colors", JsonObject(root.getValue("colors").jsonObject.entries.reversed().associate { it.key to JsonPrimitive(it.value.jsonPrimitive.content.uppercase()) }))
        })
        assertEquals("unchanged", WidgetThemeProjection.parse(reversed.toString()).updateResult(WidgetThemeProjection.modern))
    }

    @Test fun validatesEveryIdentityAndScalarBoundaryWithoutInterpretingPackageUris() {
        for (revision in listOf(JsonPrimitive(-1), JsonPrimitive(9007199254740992L), JsonPrimitive("1"), JsonPrimitive(1.5), JsonNull)) {
            assertTrue(runCatching { WidgetThemeProjection.parse(changed("registryRevision", revision)) }.isFailure)
        }
        assertTrue(runCatching { WidgetThemeProjection.parse(changed("schemaVersion", JsonPrimitive(2))) }.isFailure)
        assertTrue(runCatching { WidgetThemeProjection.parse(changed("themeVersion", JsonPrimitive(" "))) }.isFailure)
        val pointer = buildJsonObject { put("kind", "package"); put("id", "melo.test-theme"); put("archiveSha256", "a".repeat(64)) }
        val parsed = WidgetThemeProjection.parse(changed("selection", pointer))
        assertEquals(pointer, parsed.selection)
        for (bad in listOf("../theme", "https://theme", "melo.test\n")) {
            assertTrue(runCatching { WidgetThemeProjection.parse(changed("selection", JsonObject(pointer + ("id" to JsonPrimitive(bad))))) }.isFailure)
        }
        assertTrue(runCatching { WidgetThemeProjection.parse(changed("selection", JsonObject(pointer + ("archiveSha256" to JsonPrimitive("A".repeat(64)))))) }.isFailure)
    }

    @Test fun invalidColorsVariantsMissingAndExtraFieldsAreRejected() {
        val root = Json.parseToJsonElement(base).jsonObject
        for (bad in listOf("#abc", "#ffffffff", "red", "#12345g", "#123456\n")) {
            val colors = JsonObject(root.getValue("colors").jsonObject + ("accent" to JsonPrimitive(bad)))
            assertTrue(runCatching { WidgetThemeProjection.parse(changed("colors", colors)) }.isFailure)
        }
        assertTrue(runCatching { WidgetThemeProjection.parse(changed("variants", buildJsonObject { put("card", "script"); put("button", "rounded"); put("progress", "modern") })) }.isFailure)
        assertTrue(runCatching { WidgetThemeProjection.parse(changed("decoration", JsonPrimitive("file:///private.png"))) }.isFailure)
        assertTrue(runCatching { WidgetThemeProjection.parse(changed("fallback", JsonPrimitive("other"))) }.isFailure)
        assertTrue(runCatching { WidgetThemeProjection.parse(JsonObject(root - "colors").toString()) }.isFailure)
        assertTrue(runCatching { WidgetThemeProjection.parse(JsonObject(root + ("uri" to JsonPrimitive("file:///private"))).toString()) }.isFailure)
    }

    @Test fun boundedParserRejectsDeepAndOversizedInputs() {
        assertTrue(runCatching { WidgetThemeProjection.parse(" ".repeat(8193)) }.isFailure)
        val deep = changed("selection", JsonPrimitive("placeholder")).replace("\"placeholder\"", "[".repeat(1000) + "0" + "]".repeat(1000))
        val error = runCatching { WidgetThemeProjection.parse(deep) }.exceptionOrNull()
        assertTrue(error is IllegalArgumentException)
    }

    @Test fun playIconKeepsWhiteAboveNonTextThreeToOneAndUsesBlackForLightAccents() {
        for (accent in listOf("#ce4c3c", "#52794f", "#7352ba", "#808080", "#949494", "#000000")) {
            assertEquals("white preference $accent", -1, WidgetThemeProjection.playIconColor(accent))
        }
        for (accent in listOf("#959595", "#a0a0a0", "#ffffff")) {
            assertEquals("light accent $accent", -16777216, WidgetThemeProjection.playIconColor(accent))
        }
    }
}
