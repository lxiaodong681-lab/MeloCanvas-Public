package expo.modules.orpheus.util

import org.junit.Assert.*
import org.junit.Test

class RecentMusicHistoryTest {
    private val sourceA = "bilibili:BV1vT411i7ET:123"
    private val sourceB = "bilibili:BV1vT411i7ET:124"
    private fun entry(source: String = sourceA, at: Long = 10) = RecentMusicHistoryEntry(source, "Title", "Artist", "https://example.com/cover.jpg", at)

    @Test fun roundTripKeepsLatestPerSourceAndDeterministicOrder() {
        var raw: String? = null
        val store = RecentMusicHistoryPersistence({ raw }, { raw = it; true })
        assertEquals(emptyList<RecentMusicHistoryEntry>(), store.read())
        store.record(entry(sourceA, 10))
        store.record(entry(sourceB, 20))
        store.record(entry(sourceA, 20).copy(title = "Updated"))
        assertEquals(listOf(sourceA, sourceB), store.read().map { it.sourceId })
        assertEquals("Updated", store.read().first().title)
        val recreated = RecentMusicHistoryPersistence({ raw }, { false })
        assertEquals(store.read(), recreated.read())
        assertEquals(setOf("sourceId", "title", "artist", "artwork", "playedAt"), store.read().first().toJsMap().keys)
    }

    @Test fun localAndBiliPartsRemainDistinctAndHistoryIsNotTruncated() {
        var raw: String? = null
        val store = RecentMusicHistoryPersistence({ raw }, { raw = it; true })
        store.record(entry("local:12345678-1234-1234-1234-123456789abc", 99))
        repeat(50) { store.record(entry("bilibili:BV1vT411i7ET:${it + 1}", it.toLong())) }
        assertEquals(51, store.read().size)
        assertTrue(store.read().first().sourceId.startsWith("local:"))
    }

    @Test fun unknownMalformedAndOccurrenceIdsCannotOverwriteOriginalBytes() {
        for (original in listOf("{\"version\":2,\"entries\":[]}", "not-json", "{}",
            "{\"version\":1,\"entries\":[{\"sourceId\":\"playlist-item:a\",\"title\":\"A\",\"artist\":\"\",\"artwork\":\"\",\"playedAt\":1}]}")) {
            var raw: String? = original
            val store = RecentMusicHistoryPersistence({ raw }, { raw = it; true })
            assertThrows(IllegalStateException::class.java) { store.read() }
            assertThrows(IllegalStateException::class.java) { store.record(entry()) }
            assertEquals(original, raw)
        }
    }

    @Test fun failedWritesAndReadsAreErrorsNotEmptyHistory() {
        val original = RecentMusicHistoryCodec.encode(listOf(entry()))
        val store = RecentMusicHistoryPersistence({ original }, { false })
        assertThrows(IllegalStateException::class.java) { store.record(entry(sourceB)) }
        assertEquals(listOf(entry()), store.read())
        assertThrows(IllegalStateException::class.java) {
            RecentMusicHistoryPersistence({ error("Read failure") }, { true }).read()
        }
    }

    @Test fun failedCommitCanRetryWhileStillPlaying() {
        val observer = RecentMusicPlaybackObserver()
        assertTrue(observer.observe("music", sourceA, true))
        observer.recordFailed()
        assertTrue(observer.observe("music", sourceA, true))
        assertFalse(observer.observe("music", sourceA, true))
    }

    @Test fun onlyActualMusicPlaybackRecordsIncludingGaplessOccurrencesAndRepeat() {
        val observer = RecentMusicPlaybackObserver()
        observer.transition("playlist-item:a", false)
        assertFalse(observer.observe("music", "playlist-item:a", false)) // prepared, failed, restored paused
        assertTrue(observer.observe("music", "playlist-item:a", true))
        assertFalse(observer.observe("music", "playlist-item:a", true)) // metadata/state events
        observer.transition("playlist-item:a", false) // playlist edit retains current item
        assertFalse(observer.observe("music", "playlist-item:a", true))
        observer.transition("playlist-item:b", false) // same source, different queue occurrence
        assertTrue(observer.observe("music", "playlist-item:b", true))
        observer.transition("playlist-item:b", true)
        assertTrue(observer.observe("music", "playlist-item:b", true))
        assertFalse(observer.observe("music", "playlist-item:b", false))
        assertTrue(observer.observe("music", "playlist-item:b", true)) // actual resumed playback
        observer.transition(sourceB, false)
        assertFalse(observer.observe("listening", sourceB, true))
        assertFalse(observer.observe("listening", sourceB, false))
        assertFalse(observer.observe("music", sourceA, false))
        assertTrue(observer.observe("music", sourceA, true))
    }
    @Test fun explicitClearRemovesOnlyHistoryAndAllowsLaterPlayback() {
        var raw: String? = RecentMusicHistoryCodec.encode(listOf(entry()))
        val store = RecentMusicHistoryPersistence({ raw }, { raw = it; true })
        store.clear()
        assertEquals(emptyList<RecentMusicHistoryEntry>(), store.read())
        store.record(entry(sourceB))
        assertEquals(listOf(entry(sourceB)), store.read())
        // User-confirmed clearing can recover a corrupt history, unlike implicit record().
        raw = "unknown version"
        store.clear()
        assertEquals(emptyList<RecentMusicHistoryEntry>(), store.read())
    }

    @Test fun failedClearDoesNotPretendSuccessOrModifyStoredHistory() {
        val original = RecentMusicHistoryCodec.encode(listOf(entry()))
        val store = RecentMusicHistoryPersistence({ original }, { false })
        assertThrows(IllegalStateException::class.java) { store.clear() }
        assertEquals(listOf(entry()), store.read())
    }
}
