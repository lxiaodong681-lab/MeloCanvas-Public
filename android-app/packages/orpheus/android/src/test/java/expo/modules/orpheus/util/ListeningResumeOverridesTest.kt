package expo.modules.orpheus.util

import expo.modules.orpheus.model.TrackRecord
import org.junit.Assert.*
import org.junit.Test

class ListeningResumeOverridesTest {
    private fun track(cid: Int) = TrackRecord().apply {
        id = "bilibili:BV1vT411i7ET:$cid"; sourceId = id
        url = "orpheus://bilibili?bvid=BV1vT411i7ET&cid=$cid&quality=30232"
        duration = 300.0
    }

    @Test fun onlyFinitePositionsOwnedByListeningQueueAreAccepted() {
        val tracks = listOf(track(123), track(456))
        assertTrue(ListeningResumeOverrides.valid("listening", tracks, mapOf(tracks[1].id to 60.0)))
        assertTrue(ListeningResumeOverrides.valid("listening", tracks, mapOf(tracks[1].id to 0.0)))
        assertFalse(ListeningResumeOverrides.valid("music", tracks, mapOf(tracks[1].id to 60.0)))
        assertFalse(ListeningResumeOverrides.valid("listening", tracks, mapOf("unknown" to 60.0)))
        for (position in listOf(-1.0, Double.NaN, Double.POSITIVE_INFINITY, 301.0)) {
            assertFalse(ListeningResumeOverrides.valid("listening", tracks, mapOf(tracks[1].id to position)))
        }
    }

    @Test fun pendingLaterPartPositionsSurviveColdStorageAndFmReturn() {
        val tracks = listOf(track(123), track(456))
        val listening = PlaybackSessionSnapshot(mode = "listening", tracks = tracks,
            currentSourceId = tracks[0].id, currentEntryId = tracks[0].id, positionSeconds = 30.0,
            listeningResumeOverrides = mapOf(tracks[1].id to 60.0),
            listeningResumeBlocked = tracks.map { it.id }.toSet())
        val stored = requireNotNull(PlaybackSessionCodec.decode(PlaybackSessionCodec.encode(StoredPlaybackSessions(listening))))
        assertEquals(listening.listeningResumeOverrides, stored.active.listeningResumeOverrides)
        assertEquals(listening.listeningResumeBlocked, stored.active.listeningResumeBlocked)
        val fm = FmPlaybackSessions.start(stored, listOf(track(789)))
        val cold = requireNotNull(PlaybackSessionCodec.decode(PlaybackSessionCodec.encode(fm)))
        val returned = FmPlaybackSessions.exit(cold, requireNotNull(cold.fm).id)
        assertEquals(listening.listeningResumeOverrides, returned.active.listeningResumeOverrides)
        assertEquals(listening.listeningResumeBlocked, returned.active.listeningResumeBlocked)
        assertTrue(ListeningResumeOverrides.isBlocked(tracks[0].id, emptySet(), stored.active, null))
        assertTrue(ListeningResumeOverrides.isBlocked(tracks[1].id, emptySet(), null, cold.fm))
        assertFalse(PlaybackSessionCodec.validSession(listening.copy(listeningResumeOverrides = mapOf("unknown" to 0.0))))
    }

    @Test fun noOpOrFailedPersistenceKeepsOldPointsMaskedUntilSuccessfulSave() {
        val source = track(123).id
        val blocked = setOf(source)
        // Zero duration is a real no-op before MMKV is accessed, not a successful save.
        assertFalse(TrackResumeStorage.save(source, 60.0, 0.0, true))
        assertFalse(TrackResumeStorage.save(source, 300.0, 300.0, true))
        assertFalse(TrackResumeStorage.complete(source, 0.0, true))
        assertEquals(blocked, ListeningResumeOverrides.afterSave(blocked, source, false))
        assertEquals(emptySet<String>(), ListeningResumeOverrides.afterSave(blocked, source, true))
        assertFalse(ListeningResumeOverrides.validBlocked("music", listOf(track(123)), blocked))
        assertFalse(ListeningResumeOverrides.validBlocked("listening", listOf(track(123)), setOf("other")))
    }
}
