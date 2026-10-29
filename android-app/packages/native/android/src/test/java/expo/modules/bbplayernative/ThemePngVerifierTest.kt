package expo.modules.bbplayernative

import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.util.zip.CRC32
import java.util.zip.DeflaterOutputStream
import org.junit.Assert.*
import org.junit.Test

class ThemePngVerifierTest {
    private val limits = ThemeImageLimits()
    private fun zipped(raw: ByteArray): ByteArray = ByteArrayOutputStream().also { out ->
        DeflaterOutputStream(out).use { it.write(raw) }
    }.toByteArray()
    private fun chunk(type: String, data: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        DataOutputStream(out).use {
            it.writeInt(data.size); it.writeBytes(type); it.write(data)
            it.writeInt(CRC32().apply { update(type.toByteArray(Charsets.US_ASCII)); update(data) }.value.toInt())
        }
        return out.toByteArray()
    }
    private fun png(width: Int = 1, height: Int = 1, depth: Int = 8, color: Int = 6, interlace: Int = 0,
                    compressed: ByteArray = zipped(byteArrayOf(0, 10, 20, 30, -1)),
                    before: List<Pair<String, ByteArray>> = emptyList(), after: List<Pair<String, ByteArray>> = emptyList()): ByteArray {
        val header = ByteArrayOutputStream().also { out -> DataOutputStream(out).use {
            it.writeInt(width); it.writeInt(height); it.write(byteArrayOf(depth.toByte(), color.toByte(), 0, 0, interlace.toByte()))
        } }.toByteArray()
        return byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10) + chunk("IHDR", header) +
            before.fold(byteArrayOf()) { a, (t, d) -> a + chunk(t, d) } + chunk("IDAT", compressed) +
            after.fold(byteArrayOf()) { a, (t, d) -> a + chunk(t, d) } + chunk("IEND", byteArrayOf())
    }
    private fun verify(bytes: ByteArray) = ThemePngVerifier().verify(bytes, limits)
    private fun rejects(bytes: ByteArray, isLimit: Boolean = false) {
        try { verify(bytes); fail("Accepted damaged PNG") } catch (error: ThemeImageFailure) { assertEquals(isLimit, error.limit) }
    }
    private fun metadata(type: String, raw: ByteArray): Pair<String, ByteArray> = type to (
        "sample".toByteArray() + if (type == "iTXt") byteArrayOf(0, 1, 0, 0, 0) + zipped(raw)
        else byteArrayOf(0, 0) + zipped(raw))

    @Test fun validRgbaAndPackedGrayscaleAndPalette() {
        assertEquals(VerifiedPng(1, 1), verify(png()))
        verify(png(depth = 1, color = 0, compressed = zipped(byteArrayOf(0, 0))))
        verify(png(depth = 2, color = 3, compressed = zipped(byteArrayOf(0, 0)), before = listOf("PLTE" to ByteArray(12))))
        verify(png(color = 2, compressed = zipped(byteArrayOf(0, 10, 20, 30))))
        verify(png(color = 4, compressed = zipped(byteArrayOf(0, 10, -1))))
    }
    @Test fun realAuthorPngsWithIccTextPaletteAndAdam7() {
        for (name in listOf("theme-rgba-icc-text.png", "theme-palette.png", "theme-adam7.png")) {
            val bytes = javaClass.getResourceAsStream("/$name")!!.use { it.readBytes() }
            assertEquals(VerifiedPng(9, 9), verify(bytes))
        }
    }
    @Test fun adam7UsesAllSevenPassesAndExactScanlineSize() {
        // 9x9 RGBA: 324 sample bytes + 19 pass-row filter bytes, independently enumerated.
        verify(png(9, 9, interlace = 1, compressed = zipped(ByteArray(343))))
        rejects(png(9, 9, interlace = 1, compressed = zipped(ByteArray(342))))
        rejects(png(9, 9, interlace = 1, compressed = zipped(ByteArray(344))))
    }
    @Test fun truncatedContainerAndDamagedCrcAreRejected() {
        val good = png()
        rejects(good.copyOf(good.size - 1))
        rejects(good.clone().also { it[40] = (it[40].toInt() xor 1).toByte() })
        rejects(good + byteArrayOf(0))
    }
    @Test fun completeContainerCannotHideTruncatedDeflate() {
        val compressed = zipped(byteArrayOf(0, 10, 20, 30, -1))
        // Outer chunk lengths/CRCs and IEND are recomputed: header checks alone accept this.
        for (cut in listOf(1, 3, 5)) rejects(png(compressed = compressed.copyOf(compressed.size - cut)))
    }
    @Test fun badAdlerAndExtraZlibDataAreRejected() {
        val compressed = zipped(byteArrayOf(0, 10, 20, 30, -1))
        rejects(png(compressed = compressed.clone().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }))
        rejects(png(compressed = compressed + byteArrayOf(0)))
        rejects(png(after = listOf("IDAT" to zipped(byteArrayOf(0)))))
    }
    @Test fun incompleteExtraAndIllegalFilterRowsAreRejected() {
        rejects(png(compressed = zipped(byteArrayOf(0, 1, 2))))
        rejects(png(compressed = zipped(ByteArray(6))))
        rejects(png(compressed = zipped(byteArrayOf(5, 1, 2, 3, 4))))
    }
    @Test fun animationUnknownCriticalAndNonconsecutiveDataAreRejected() {
        for (type in listOf("acTL", "fcTL", "fdAT", "WXYZ")) rejects(png(before = listOf(type to ByteArray(8))))
        rejects(png(after = listOf("tEXt" to byteArrayOf(0), "IDAT" to byteArrayOf(0))))
    }
    @Test fun budgetsAndDepthAreCheckedBeforeInflation() {
        rejects(png(width = 8193, compressed = byteArrayOf(0)), true)
        rejects(png(width = 4000, height = 2001, compressed = byteArrayOf(0)), true)
        rejects(png(depth = 16))
        rejects(png(depth = 2, color = 6))
        try { ThemePngVerifier().verify(png(), limits.copy(decodedImageBytes = 3)); fail() } catch (e: ThemeImageFailure) { assertTrue(e.limit) }
        try { ThemePngVerifier().verify(png(), limits.copy(fileBytes = 10)); fail() } catch (e: ThemeImageFailure) { assertTrue(e.limit) }
        try { limits.copy(fileBytes = Int.MAX_VALUE); fail() } catch (e: ThemeImageFailure) { assertTrue(e.limit) }
    }
    @Test fun metadataFieldsNormalProfileAndInternationalText() {
        verify(png(before = listOf(metadata("iCCP", ByteArray(128)), metadata("zTXt", "author text".toByteArray()), metadata("iTXt", "作者说明".toByteArray()))))
        rejects(png(before = listOf("zTXt" to byteArrayOf(0, 0, 1))))
        rejects(png(before = listOf("zTXt" to ("key".toByteArray() + byteArrayOf(0, 1) + zipped(byteArrayOf(0))))))
        rejects(png(before = listOf("iTXt" to ("key".toByteArray() + byteArrayOf(0, 2, 0, 0, 0)))))
        rejects(png(before = listOf(metadata("iTXt", byteArrayOf(0xc0.toByte(), 0x80.toByte())))))
        rejects(png(after = listOf(metadata("iCCP", ByteArray(128)))))
    }
    @Test fun internationalTextSpansInflaterBuffersAndRejectsBadSuffix() {
        val text = "a".repeat(16383).toByteArray() + "说明".toByteArray()
        verify(png(before = listOf(metadata("iTXt", text))))
        rejects(png(before = listOf(metadata("iTXt", text + byteArrayOf(0xc2.toByte())))))
    }
    @Test fun metadataBombsAndAggregateBudgetAreRejected() {
        rejects(png(before = listOf(metadata("zTXt", ByteArray(1024 * 1024 + 1)))), true)
        val blocks = (1..3).map { metadata("iTXt", ByteArray(800_000) { 65 }) }
        rejects(png(before = blocks), true)
        verify(png(before = listOf(metadata("iTXt", ByteArray(1024 * 1024) { 65 }))))
    }
    @Test fun metadataDeflateMustFinishAndNotHaveTrailingBytes() {
        val prefix = "sample".toByteArray() + byteArrayOf(0, 0)
        val data = zipped("text".toByteArray())
        rejects(png(before = listOf("zTXt" to (prefix + data.copyOf(data.size - 1)))))
        rejects(png(before = listOf("zTXt" to (prefix + data + byteArrayOf(0)))))
    }
    @Test fun validationHasMonotonicDeadline() {
        var now = 0L
        try { ThemePngVerifier { now.also { now += 3_000_000_000L } }.verify(png(), limits); fail() }
        catch (error: ThemeImageFailure) { assertTrue(error.limit); assertTrue(error.message!!.contains("deadline")) }
    }
    @Test fun indexedRangeIsCheckedAfterEveryFilterAndAcceptsLegalShortPalette() {
        val firstRow = byteArrayOf(0, 1, 1)
        val badRows = listOf(byteArrayOf(0, 1, 2), byteArrayOf(1, 1, 1), byteArrayOf(2, 0, 1), byteArrayOf(3, 1, 1), byteArrayOf(4, 0, 1))
        val goodRows = listOf(byteArrayOf(0, 1, 0), byteArrayOf(1, 1, -1), byteArrayOf(2, 0, -1), byteArrayOf(3, 1, -1), byteArrayOf(4, 0, -1))
        for (filter in 0..4) {
            rejects(png(2, 2, color = 3, before = listOf("PLTE" to ByteArray(6)), compressed = zipped(firstRow + badRows[filter])))
            verify(png(2, 2, color = 3, before = listOf("PLTE" to ByteArray(6)), compressed = zipped(firstRow + goodRows[filter])))
        }
    }
    @Test fun indexedPackedDepthsIgnorePaddingButRejectActualOutOfRangeSamples() {
        for (depth in listOf(1, 2, 4, 8)) {
            val padding = (1 shl (8 - depth)) - 1
            val bad = 1 shl (8 - depth)
            // One real index is zero, all non-pixel padding bits are one.
            verify(png(depth = depth, color = 3, before = listOf("PLTE" to ByteArray(3)), compressed = zipped(byteArrayOf(0, padding.toByte()))))
            rejects(png(depth = depth, color = 3, before = listOf("PLTE" to ByteArray(3)), compressed = zipped(byteArrayOf(0, bad.toByte()))))
        }
    }
    private val adamPasses = listOf(2 to 2, 1 to 2, 3 to 1, 2 to 3, 5 to 2, 4 to 5, 9 to 4)
    @Test fun indexedAdam7ResetsPreviousRowAtEachPass() {
        val raw = ByteArrayOutputStream()
        for ((width, height) in adamPasses) for (row in 0 until height) {
            raw.write(2) // Up: every new pass starts with a zero previous row.
            repeat(width) { raw.write(if (row == 0) 1 else 0) }
        }
        verify(png(9, 9, color = 3, interlace = 1, before = listOf("PLTE" to ByteArray(6)), compressed = zipped(raw.toByteArray())))
    }
    @Test fun indexedAdam7ChecksEachPassAndPackedPixelsNotPadding() {
        for (badPass in -1..6) {
            val raw = ByteArrayOutputStream()
            for ((pass, size) in adamPasses.withIndex()) {
                val (width, height) = size
                val rowBytes = (width * 2 + 7) / 8
                val unused = rowBytes * 8 - width * 2
                for (row in 0 until height) {
                    raw.write(2)
                    val packed = ByteArray(rowBytes)
                    if (row == 0) {
                        packed[packed.lastIndex] = ((1 shl unused) - 1).toByte()
                        if (pass == badPass) packed[packed.lastIndex] = (packed.last().toInt() or (1 shl unused)).toByte()
                    }
                    raw.write(packed)
                }
            }
            val image = png(9, 9, depth = 2, color = 3, interlace = 1, before = listOf("PLTE" to ByteArray(3)), compressed = zipped(raw.toByteArray()))
            if (badPass < 0) verify(image) else rejects(image)
        }
    }
    @Test fun indexedRowsSpanInflaterBuffersWithoutLosingFilterState() {
        val raw = ByteArrayOutputStream()
        repeat(3) { raw.write(1); raw.write(1); raw.write(ByteArray(8191)) }
        val good = raw.toByteArray()
        verify(png(8192, 3, color = 3, before = listOf("PLTE" to ByteArray(6)), compressed = zipped(good)))
        rejects(png(8192, 3, color = 3, before = listOf("PLTE" to ByteArray(6)), compressed = zipped(good.clone().also { it[it.lastIndex] = 1 })))
    }
}
