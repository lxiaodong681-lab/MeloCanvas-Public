package expo.modules.orpheus.util

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.IOException

class OfflineIntegrityTest {
    @Test fun newInstallUsesOneGiB() {
        assertEquals(1073741824L, OfflineIntegrity.storageLimit(null))
    }
    @Test fun upgradeWithoutConfiguredLimitUsesOneGiB() {
        val previousSettings = emptyMap<String, Long>()
        assertEquals(1073741824L, OfflineIntegrity.storageLimit(previousSettings["limit"]))
    }
    @Test fun configuredLimitIsNeverOverwritten() {
        for (value in listOf(64L * 1024 * 1024, 2L * 1024 * 1024 * 1024, 0L)) {
            assertEquals(value, OfflineIntegrity.storageLimit(value))
        }
    }
    @Test fun sameWrapperReopenCannotRenewEpochButNewUserSourceCan() {
        val gate = PlaybackNetworkGate()
        gate.update(true, true)
        var creations = 0
        fun owner() = OfflineUpstreamOwner {
            creations++
            val epoch = gate.epoch()
            val open: () -> Unit = { gate.begin(epoch).use { it.check() } }
            open
        }
        val oldWrapper = owner()
        oldWrapper.source()
        gate.update(newWifi = false)
        gate.update(newWifi = true)
        assertThrows(IOException::class.java) { oldWrapper.source() }
        assertEquals(1, creations)
        owner().source() // New explicit playback owns a new source and the current epoch.
        assertEquals(2, creations)
    }
    @Test fun cacheOnlyMarkerKeepsRealBilibiliIdentity() {
        val source = "bilibili:BV1vT411i7ET:123"
        val uri = "orpheus://bilibili?bvid=BV1vT411i7ET&cid=123&quality=30232&meloOffline=1"
        assertTrue(PlaybackSourceIdentity.isValidEntry(source, source, uri, "music"))
        assertFalse(PlaybackSourceIdentity.isValidEntry("local:fake", "local:fake", uri, "music"))
    }
    @Test fun fragmentAndUnknownLengthNeverBecomeComplete() {
        assertFalse(OfflineIntegrity.complete(-1, -1) { _, _ -> true })
        assertFalse(OfflineIntegrity.complete(10, 9) { _, _ -> true })
        assertFalse(OfflineIntegrity.complete(10, 10) { start, length -> start == 0L && length <= 4 })
        assertTrue(OfflineIntegrity.complete(10, 10) { start, length -> start == 0L && length == 10L })
    }
    @Test fun syntheticAudioMustMatchDeclaredLengthExactly() {
        val synthetic = ByteArray(44 + 3200) { index -> (index % 127).toByte() }
        fun consume(declared: Long) {
            val budget = OfflineTransferLength(declared)
            val stream = ByteArrayInputStream(synthetic)
            val buffer = ByteArray(127)
            while (true) { val count = stream.read(buffer); budget.read(count); if (count == -1) break }
            assertEquals(0, budget.remaining)
        }
        consume(synthetic.size.toLong())
        assertThrows(IOException::class.java) { consume(synthetic.size.toLong() + 1) }
        assertThrows(IOException::class.java) { consume(synthetic.size.toLong() - 1) }
    }
    @Test fun capAndFreeSpaceCannotOvercommitOrAcceptUnknownLength() {
        OfflineIntegrity.reserve(40, 60, 100, 200, 100)
        assertThrows(IOException::class.java) { OfflineIntegrity.reserve(41, 60, 100, 200, 100) }
        assertThrows(IOException::class.java) { OfflineIntegrity.reserve(40, 0, 100, 139, 100) }
        assertThrows(IOException::class.java) { OfflineIntegrity.reserve(-1, 0, 100, 200, 100) }
    }
}
