package expo.modules.orpheus.util

import java.io.File

/** Snapshot preflight, not a promise against files changing after this check. */
data class OfflineFileSpan(val position: Long, val length: Long, val file: File?)
object OfflineFileCoverage {
    fun complete(length: Long, spans: List<OfflineFileSpan>): Boolean {
        if (length <= 0) return false
        var covered = 0L
        for (span in spans.sortedBy { it.position }) {
            if (covered >= length) return true
            if (span.position < 0 || span.length <= 0 || span.position > covered ||
                span.length > Long.MAX_VALUE - span.position) return false
            val file = span.file ?: return false
            if (!file.isFile || !file.canRead() || file.length() != span.length) return false
            covered = maxOf(covered, span.position + span.length)
        }
        return covered >= length
    }
}
