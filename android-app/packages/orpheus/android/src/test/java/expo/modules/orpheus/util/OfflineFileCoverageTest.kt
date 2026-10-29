package expo.modules.orpheus.util

import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class OfflineFileCoverageTest {
    @Test fun liveFilesMustMatchIndexAndCoverEveryByte() {
        val dir = Files.createTempDirectory("melo-offline-synthetic").toFile()
        try {
            val a = dir.resolve("a").apply { writeBytes(byteArrayOf(1, 2, 3, 4)) }
            val b = dir.resolve("b").apply { writeBytes(byteArrayOf(5, 6, 7, 8)) }
            val spans = listOf(OfflineFileSpan(0, 4, a), OfflineFileSpan(4, 4, b))
            assertTrue(OfflineFileCoverage.complete(8, spans))
            b.writeBytes(byteArrayOf(5, 6))
            assertFalse(OfflineFileCoverage.complete(8, spans))
            assertTrue(b.delete())
            assertFalse(OfflineFileCoverage.complete(8, spans))
            b.writeBytes(byteArrayOf(5, 6, 7, 8))
            assertTrue(OfflineFileCoverage.complete(8, spans))
            assertFalse(OfflineFileCoverage.complete(9, spans))
            assertFalse(OfflineFileCoverage.complete(8, listOf(spans[0], OfflineFileSpan(5, 4, b))))
            assertFalse(OfflineFileCoverage.complete(8, listOf(OfflineFileSpan(0, 8, null))))
            assertFalse(OfflineFileCoverage.complete(0, spans))
        } finally { dir.deleteRecursively() } // Only this test-created synthetic directory.
    }
}
