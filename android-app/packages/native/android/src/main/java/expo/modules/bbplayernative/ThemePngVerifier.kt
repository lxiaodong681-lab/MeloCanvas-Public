package expo.modules.bbplayernative

import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction
import java.util.zip.CRC32
import java.util.zip.DataFormatException
import java.util.zip.Inflater

internal class ThemeImageFailure(val limit: Boolean, message: String) : Exception(message)

internal data class ThemeImageLimits(
    val fileBytes: Int = 8 * 1024 * 1024,
    val imagePixels: Int = 8_000_000,
    val imageDimension: Int = 8192,
    val decodedImageBytes: Int = 32 * 1024 * 1024,
) {
    init {
        if (fileBytes !in 1..8 * 1024 * 1024 || imagePixels !in 1..8_000_000 ||
            imageDimension !in 1..8192 || decodedImageBytes !in 1..32 * 1024 * 1024
        ) throw ThemeImageFailure(true, "Invalid or enlarged image budget")
    }
}

internal data class VerifiedPng(val width: Int, val height: Int) {
    val decodedBytes: Int get() = width * height * 4
}

/** Complete container and bounded zlib validation; pixel decoding still belongs to Android. */
internal class ThemePngVerifier(private val clock: () -> Long = System::nanoTime) {
    private var started = 0L
    private var metadataBytes = 0L
    private fun invalid(message: String): Nothing = throw ThemeImageFailure(false, message)
    private fun limit(message: String): Nothing = throw ThemeImageFailure(true, message)
    private fun progress() {
        if (clock() - started > 5_000_000_000L) limit("PNG validation deadline exceeded")
        if (Thread.currentThread().isInterrupted) invalid("PNG validation interrupted")
    }
    private fun u32(bytes: ByteArray, at: Int): Long =
        ((bytes[at].toLong() and 255) shl 24) or ((bytes[at + 1].toLong() and 255) shl 16) or
            ((bytes[at + 2].toLong() and 255) shl 8) or (bytes[at + 3].toLong() and 255)
    private fun u8(bytes: ByteArray, at: Int) = bytes[at].toInt() and 255

    fun verify(bytes: ByteArray, limits: ThemeImageLimits): VerifiedPng {
        started = clock()
        metadataBytes = 0
        if (bytes.isEmpty() || bytes.size > limits.fileBytes) limit("PNG input byte budget exceeded")
        val signature = byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10)
        if (bytes.size < 8 || !bytes.copyOfRange(0, 8).contentEquals(signature)) invalid("Not a PNG")
        var at = 8
        var width = 0
        var height = 0
        var depth = 0
        var color = 0
        var interlace = 0
        var palette = 0
        var transparency = false
        var idatStart = -1
        var idatEnd = -1
        var dataClosed = false
        var dataBytes = 0L
        var profile = false
        while (at < bytes.size) {
            progress()
            if (bytes.size - at < 12) invalid("Truncated PNG chunk")
            val lengthLong = u32(bytes, at)
            if (lengthLong > bytes.size.toLong() - at - 12) invalid("Truncated PNG chunk data")
            val length = lengthLong.toInt()
            val end = at + length + 12
            val type = String(bytes, at + 4, 4, Charsets.US_ASCII)
            if (!(at + 4 until at + 8).all { u8(bytes, it) in 65..90 || u8(bytes, it) in 97..122 } ||
                u8(bytes, at + 6) !in 65..90
            ) invalid("Invalid PNG chunk type")
            val crc = CRC32().apply { update(bytes, at + 4, length + 4) }.value
            if (crc != u32(bytes, end - 4)) invalid("PNG CRC mismatch")
            if (at == 8 && (type != "IHDR" || length != 13)) invalid("PNG must start with IHDR")
            if (idatStart >= 0 && type != "IDAT") dataClosed = true
            val from = at + 8
            when (type) {
                "IHDR" -> {
                    if (at != 8 || length != 13) invalid("Invalid or duplicate IHDR")
                    val w = u32(bytes, from)
                    val h = u32(bytes, from + 4)
                    if (w == 0L || h == 0L || w > limits.imageDimension || h > limits.imageDimension ||
                        w * h > limits.imagePixels || w * h * 4 > limits.decodedImageBytes
                    ) limit("PNG pixel budget exceeded before decoding")
                    width = w.toInt(); height = h.toInt()
                    depth = u8(bytes, from + 8); color = u8(bytes, from + 9)
                    val validDepth = when (color) {
                        0, 3 -> depth in listOf(1, 2, 4, 8)
                        2, 4, 6 -> depth == 8
                        else -> false
                    }
                    interlace = u8(bytes, from + 12)
                    if (!validDepth || u8(bytes, from + 10) != 0 || u8(bytes, from + 11) != 0 || interlace !in 0..1)
                        invalid("Only static PNG up to 8 bits with standard compression/filtering is supported")
                }
                "PLTE" -> {
                    if (palette != 0 || idatStart >= 0 || transparency || color in listOf(0, 4) ||
                        length !in 3..768 || length % 3 != 0
                    ) invalid("Invalid PNG palette")
                    palette = length / 3
                    if (color == 3 && palette > (1 shl depth)) invalid("PNG palette exceeds bit depth")
                }
                "tRNS" -> {
                    if (transparency || idatStart >= 0) invalid("Invalid PNG transparency ordering")
                    transparency = true
                    when (color) {
                        0 -> if (length != 2 || u8(bytes, from) != 0 || u8(bytes, from + 1) >= (1 shl depth)) invalid("Invalid grayscale transparency")
                        2 -> if (length != 6 || listOf(0, 2, 4).any { u8(bytes, from + it) != 0 }) invalid("Invalid RGB transparency")
                        3 -> if (palette == 0 || length !in 1..palette) invalid("Invalid palette transparency")
                        else -> invalid("Alpha PNG cannot contain tRNS")
                    }
                }
                "IDAT" -> {
                    if (dataClosed || (color == 3 && palette == 0)) invalid("Invalid or nonconsecutive PNG data")
                    if (idatStart < 0) idatStart = at
                    idatEnd = end
                    dataBytes += length
                }
                "IEND" -> {
                    if (length != 0 || end != bytes.size || idatStart < 0 || dataBytes == 0L) invalid("Incomplete PNG ending or trailing bytes")
                    validatePixels(bytes, idatStart, idatEnd, width, height, depth, color, interlace, palette)
                    return VerifiedPng(width, height)
                }
                "acTL", "fcTL", "fdAT" -> invalid("Animated PNG is not supported")
                "iCCP", "zTXt", "iTXt" -> {
                    if (type == "iCCP") {
                        if (profile || idatStart >= 0 || palette != 0) invalid("Invalid ICC profile ordering")
                        profile = true
                    }
                    validateMetadata(bytes, from, from + length, type)
                }
                else -> if (type[0] in 'A'..'Z') invalid("Unknown mandatory PNG chunk")
            }
            at = end
        }
        invalid("PNG has no IEND")
    }

    private fun keywordEnd(bytes: ByteArray, from: Int, end: Int): Int {
        var at = from
        while (at < end && bytes[at] != 0.toByte() && at - from <= 79) at++
        if (at - from !in 1..79 || at >= end || bytes[at] != 0.toByte() || bytes[from] == 32.toByte() || bytes[at - 1] == 32.toByte()) invalid("Invalid PNG metadata keyword")
        for (i in from until at) {
            val b = u8(bytes, i)
            if (!(b in 32..126 || b in 161..255) || (b == 32 && i > from && bytes[i - 1] == 32.toByte())) invalid("Invalid PNG metadata keyword")
        }
        return at
    }

    private fun validateUtf8(bytes: ByteArray, from: Int, end: Int) {
        val decoder = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
        val input = ByteBuffer.wrap(bytes, from, end - from)
        val output = CharBuffer.allocate(4096)
        while (true) {
            progress()
            val result = decoder.decode(input, output, true)
            if (result.isError) invalid("Invalid UTF-8 PNG metadata")
            if (result.isUnderflow) return
            output.clear()
        }
    }

    private fun validateMetadata(bytes: ByteArray, from: Int, end: Int, type: String) {
        var at = keywordEnd(bytes, from, end) + 1
        var compressed = true
        if (type == "iTXt") {
            if (end - at < 2 || u8(bytes, at) !in 0..1 || bytes[at + 1] != 0.toByte()) invalid("Invalid iTXt compression fields")
            compressed = bytes[at] == 1.toByte()
            at += 2
            val languageStart = at
            while (at < end && bytes[at] != 0.toByte()) {
                if (!(u8(bytes, at) in 65..90 || u8(bytes, at) in 97..122 || u8(bytes, at) in 48..57 || bytes[at] == 45.toByte())) invalid("Invalid iTXt language tag")
                if ((at - languageStart) % 4096 == 0) progress()
                at++
            }
            if (at >= end) invalid("Truncated iTXt language field")
            at++
            val translated = at
            while (at < end && bytes[at] != 0.toByte()) { if ((at - translated) % 4096 == 0) progress(); at++ }
            if (at >= end) invalid("Truncated iTXt translated keyword")
            validateUtf8(bytes, translated, at)
            at++
        } else {
            if (at >= end || bytes[at] != 0.toByte()) invalid("Unsupported PNG metadata compression")
            at++
        }
        if (!compressed) { validateUtf8(bytes, at, end); return }
        val inflater = Inflater()
        val output = ByteArray(16 * 1024)
        val utf8 = if (type == "iTXt") Utf8Stream() else null
        var count = 0L
        try {
            inflater.setInput(bytes, at, end - at)
            while (!inflater.finished()) {
                progress()
                val size = inflate(inflater, output)
                count += size
                metadataBytes += size
                if (count > 1024 * 1024 || metadataBytes > 2 * 1024 * 1024) limit("Compressed PNG metadata budget exceeded")
                utf8?.accept(output, size, false)
                if (size == 0 && !inflater.finished()) invalid("Truncated or stalled PNG metadata stream")
            }
            if (inflater.remaining != 0) invalid("Trailing compressed PNG metadata")
            utf8?.accept(output, 0, true)
        } finally { inflater.end() }
    }

    private inner class Utf8Stream {
        private val decoder = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
        private val input = ByteBuffer.allocate(16 * 1024 + 4)
        private val chars = CharBuffer.allocate(4096)
        fun accept(bytes: ByteArray, count: Int, last: Boolean) {
            input.put(bytes, 0, count).flip()
            while (true) {
                progress()
                chars.clear()
                val result = decoder.decode(input, chars, last)
                if (result.isError) invalid("Invalid compressed iTXt UTF-8")
                if (result.isUnderflow) break
            }
            input.compact()
        }
    }

    private fun inflate(inflater: Inflater, output: ByteArray): Int = try {
        inflater.inflate(output)
    } catch (_: DataFormatException) { invalid("Damaged PNG zlib stream") }

    /** Only indexed samples need reconstruction: Android accepts out-of-PLTE indices. */
    private inner class IndexedRows(width: Int, private val depth: Int, private val palette: Int) {
        private var previous = ByteArray((width * depth + 7) / 8)
        private var current = ByteArray(previous.size)
        private var position = 0
        private var filter = 0
        private var pixels = 0
        fun resetPass() { previous.fill(0) }
        fun beginRow(value: Int, width: Int) { position = 0; filter = value; pixels = width }
        private fun paeth(left: Int, above: Int, upperLeft: Int): Int {
            val p = left + above - upperLeft
            val a = kotlin.math.abs(p - left)
            val b = kotlin.math.abs(p - above)
            val c = kotlin.math.abs(p - upperLeft)
            return if (a <= b && a <= c) left else if (b <= c) above else upperLeft
        }
        fun accept(bytes: ByteArray, from: Int, count: Int) {
            for (at in from until from + count) {
                if (position % 4096 == 0) progress()
                // Indexed PNG has one packed sample channel: filter byte stride is always one.
                val left = if (position == 0) 0 else u8(current, position - 1)
                val above = u8(previous, position)
                val upperLeft = if (position == 0) 0 else u8(previous, position - 1)
                val predictor = when (filter) {
                    0 -> 0
                    1 -> left
                    2 -> above
                    3 -> (left + above) / 2
                    else -> paeth(left, above, upperLeft)
                }
                current[position++] = (u8(bytes, at) + predictor).toByte()
            }
        }
        fun finishRow() {
            val mask = (1 shl depth) - 1
            for (pixel in 0 until pixels) {
                if (pixel % 4096 == 0) progress()
                val bit = pixel * depth
                val index = (u8(current, bit / 8) ushr (8 - depth - bit % 8)) and mask
                if (index >= palette) invalid("PNG pixel index exceeds PLTE")
            }
            // Padding bits are not pixels. Retain exactly two row buffers across all passes.
            val reuse = previous
            previous = current
            current = reuse
        }
    }

    private fun validatePixels(bytes: ByteArray, from: Int, end: Int, width: Int, height: Int, depth: Int, color: Int, interlace: Int, palette: Int) {
        val channels = when (color) { 0, 3 -> 1; 2 -> 3; 4 -> 2; else -> 4 }
        val passes = if (interlace == 0) listOf(intArrayOf(0, 0, 1, 1)) else listOf(
            intArrayOf(0, 0, 8, 8), intArrayOf(4, 0, 8, 8), intArrayOf(0, 4, 4, 8),
            intArrayOf(2, 0, 4, 4), intArrayOf(0, 2, 2, 4), intArrayOf(1, 0, 2, 2), intArrayOf(0, 1, 1, 2),
        )
        val rows = passes.mapNotNull { pass ->
            val w = (width - pass[0] + pass[2] - 1).coerceAtLeast(0) / pass[2]
            val h = (height - pass[1] + pass[3] - 1).coerceAtLeast(0) / pass[3]
            if (w == 0 || h == 0) null else intArrayOf((w * channels * depth + 7) / 8, h, w)
        }
        val indexed = if (color == 3) IndexedRows(width, depth, palette) else null
        val inflater = Inflater()
        val output = ByteArray(16 * 1024)
        var inputAt = from
        var pass = 0
        var row = 0
        var remaining = 0
        try {
            while (!inflater.finished()) {
                progress()
                if (inflater.needsInput()) {
                    if (inputAt >= end) invalid("Truncated PNG compressed image")
                    val length = u32(bytes, inputAt).toInt()
                    inflater.setInput(bytes, inputAt + 8, length)
                    inputAt += length + 12
                }
                val count = inflate(inflater, output)
                var at = 0
                while (at < count) {
                    if (pass >= rows.size) invalid("PNG has extra scanline bytes")
                    if (remaining == 0) {
                        val filter = u8(output, at++)
                        if (filter !in 0..4) invalid("Invalid PNG row filter")
                        indexed?.beginRow(filter, rows[pass][2])
                        remaining = rows[pass][0]
                    }
                    val used = minOf(remaining, count - at)
                    indexed?.accept(output, at, used)
                    at += used; remaining -= used
                    if (remaining == 0) {
                        indexed?.finishRow()
                        row++
                        if (row == rows[pass][1]) { pass++; row = 0; indexed?.resetPass() }
                    }
                }
                if (count == 0 && !inflater.finished() && !inflater.needsInput()) invalid("Stalled PNG image stream")
            }
            if (pass != rows.size || remaining != 0) invalid("Incomplete PNG scanlines")
            if (inflater.remaining != 0) invalid("Trailing PNG zlib image bytes")
            // Zero-length final IDAT chunks are valid; nonempty bytes after zlib are not.
            while (inputAt < end) {
                progress()
                val length = u32(bytes, inputAt).toInt()
                if (length != 0) invalid("Trailing PNG IDAT data")
                inputAt += length + 12
            }
        } finally { inflater.end() }
    }
}
