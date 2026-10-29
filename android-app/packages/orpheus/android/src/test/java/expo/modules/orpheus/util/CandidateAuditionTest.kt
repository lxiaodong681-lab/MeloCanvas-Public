package expo.modules.orpheus.util

import expo.modules.orpheus.model.TrackRecord
import expo.modules.orpheus.widget.WidgetStamp
import org.junit.Assert.*
import org.junit.Test

class CandidateAuditionTest {
    private fun track(cid: Int, entry: String? = null) = TrackRecord().apply {
        sourceId = "bilibili:BV1vT411i7ET:$cid"; id = entry ?: sourceId!!
        url = "orpheus://bilibili?bvid=BV1vT411i7ET&cid=$cid&quality=30232"
        title = "翻唱 Live P$cid"; duration = 500.0
    }
    private fun music() = PlaybackSessionSnapshot(tracks = listOf(track(1, "playlist-item:a"), track(1, "playlist-item:b")),
        currentEntryId = "playlist-item:b", currentSourceId = track(1).sourceId, positionSeconds = 81.227,
        playing = true, playWhenReady = true, repeatMode = 2, shuffleEntryIds = listOf("playlist-item:b", "playlist-item:a"))
    private fun listening() = PlaybackSessionSnapshot(mode = "listening", tracks = listOf(track(2)), currentEntryId = track(2).id,
        currentSourceId = track(2).sourceId, positionSeconds = 42.123, speed = 1.7f, playing = true, playWhenReady = true,
        listeningResumeOverrides = mapOf(track(2).id to 42.123), listeningResumeBlocked = setOf(track(2).id))
    private fun original() = StoredPlaybackSessions(music(), listening(), widgetStamp = WidgetStamp.create())

    @Test fun enteringWritesPausedOriginalBeforeAudibleChangeAndRestartRestoresIt() {
        val original = original()
        val audition = CandidateAuditionSession()
        var disk: String? = null
        audition.start(track(99), 1, { original }, { disk = PlaybackSessionCodec.encode(it) }, { live ->
            val restarted = requireNotNull(PlaybackSessionCodec.decode(requireNotNull(disk)))
            assertEquals(original.active.tracks.map { it.id }, restarted.active.tracks.map { it.id })
            assertEquals(81.227, restarted.active.positionSeconds, 0.0)
            assertFalse(restarted.active.playWhenReady)
            assertFalse(restarted.active.playing)
            assertEquals(original.inactive!!.currentEntryId, restarted.inactive!!.currentEntryId)
            assertEquals(track(99).id, live.active.currentSourceId)
            assertEquals("翻唱 Live P99", live.active.tracks.single().title)
            assertNull(live.fm)
        })
    }

    @Test fun repeatedCandidatePreservesFirstSnapshotAndRejectsLateExitAndCancellation() {
        val audition = CandidateAuditionSession()
        var writes = 0
        audition.start(track(99), 1, ::original, { writes++ }, {})
        val firstId = audition.id!!
        val first = audition.original
        audition.start(track(100), 2, { error("must not recapture audition") }, { writes++ }, {})
        assertSame(first, audition.original)
        assertEquals(1, writes)
        assertFalse(audition.ownedBy(1))
        assertTrue(audition.ownedBy(2))
        var cancelled = false
        assertThrows(IllegalStateException::class.java) { audition.end(firstId, { cancelled = true }, {}) }
        assertFalse(cancelled)
        audition.end(audition.id!!) { assertSame(first, it) }
        assertNull(audition.id)
        assertFalse(audition.end(firstId) { error("duplicate exit must not apply") })
    }

    @Test fun prewriteFailureDoesNotMutateLiveStateAndFailedRestoreRemainsRetryable() {
        val audition = CandidateAuditionSession()
        assertThrows(IllegalStateException::class.java) {
            audition.start(track(99), 1, ::original, { error("disk full") }, { error("must not touch live") })
        }
        assertNull(audition.original)
        audition.start(track(99), 2, ::original, {}, {})
        val id = audition.id!!
        assertThrows(IllegalStateException::class.java) { audition.end(id) { error("apply failed") } }
        assertEquals(id, audition.id)
        audition.end(id) { assertFalse(it.active.playWhenReady) }
        assertNull(audition.original)
    }

    @Test fun candidateApplyFailureRollsBackOriginalPausedWithoutWritingCandidate() {
        val audition = CandidateAuditionSession()
        var applications = 0
        var writes = 0
        assertThrows(IllegalStateException::class.java) {
            audition.start(track(99), 1, ::original, { writes++ }, {
                applications++
                if (applications == 1) error("decoder failure")
                assertEquals("playlist-item:b", it.active.currentEntryId)
                assertFalse(it.active.playWhenReady)
            })
        }
        assertEquals(2, applications)
        assertEquals(1, writes)
        assertNull(audition.original)
    }

    @Test fun listeningAndFmContextsRetainExactIdentityProgressAndResumeProtection() {
        val base = original()
        val fm = FmPlaybackSessions.start(base, listOf(track(7), track(8)))
        val cases = listOf(base, base.copy(active = listening(), inactive = music()), fm,
            FmPlaybackSessions.replace(fm, listening(), null))
        for (before in cases) {
            val audition = CandidateAuditionSession()
            audition.start(track(99), 1, { before }, {}, {})
            audition.end(audition.id!!) { after ->
                assertEquals(before.active.copy(playing = false, playWhenReady = false), after.active)
                assertEquals(before.inactive, after.inactive)
                assertEquals(before.fm, after.fm)
                assertEquals(PlaybackSessionCodec.encode(after), PlaybackSessionCodec.encode(requireNotNull(PlaybackSessionCodec.decode(PlaybackSessionCodec.encode(after)))))
            }
        }
    }
    @Test fun emptyAndLocalOriginalsRestoreWithoutCandidateIdentityOrAutoplay() {
        val localId = "12345678-90ab-4cde-8fab-123456789abc"
        val local = TrackRecord().apply {
            id = "playlist-item:local-copy"; sourceId = LocalAudioIdentity.sourceId(localId)
            url = LocalAudioIdentity.uri(localId); duration = 180.0
        }
        val localSession = PlaybackSessionSnapshot(tracks = listOf(local), currentEntryId = local.id,
            currentSourceId = local.sourceId, positionSeconds = 10.999, playing = true, playWhenReady = true)
        for (active in listOf(PlaybackSessionSnapshot(), localSession)) {
            val audition = CandidateAuditionSession()
            val original = StoredPlaybackSessions(active, widgetStamp = WidgetStamp.create())
            audition.start(track(99), 1, { original }, { assertTrue(PlaybackSessionCodec.validStored(it)) }, {})
            audition.end(audition.id!!) {
                assertEquals(active.currentSourceId, it.active.currentSourceId)
                assertEquals(active.currentEntryId, it.active.currentEntryId)
                assertEquals(active.positionSeconds, it.active.positionSeconds, 0.0)
                assertFalse(it.active.playWhenReady)
            }
        }
    }

    @Test fun failedCandidateAndRollbackRetainFirstOriginalForRetry() {
        val audition = CandidateAuditionSession()
        val failure = assertThrows(IllegalStateException::class.java) {
            audition.start(track(99), 1, ::original, {}, { error("apply failure") })
        }
        assertEquals(1, failure.suppressed.size)
        assertNotNull(audition.id)
        assertTrue(audition.ownedBy(1))
        val saved = audition.original!!
        audition.end(audition.id!!) {
            assertSame(saved, it)
            assertFalse(it.active.playWhenReady)
        }
        assertNull(audition.original)
    }

    @Test fun cancellationAfterCommitRestoresOnlyOwnedCandidate() {
        val guard = PlaybackReplacementGuard()
        val audition = CandidateAuditionSession()
        fun cancel(token: Long) {
            if (guard.cancelIfCurrent(token) && audition.ownedBy(token))
                audition.end(audition.id!!) { assertFalse(it.active.playWhenReady) }
        }
        val first = guard.begin()
        guard.commit(first) { audition.start(track(99), first, ::original, {}, {}) }
        assertFalse(guard.isPending())
        cancel(first)
        assertNull(audition.original)
        val second = guard.begin()
        guard.commit(second) { audition.start(track(100), second, ::original, {}, {}) }
        cancel(first)
        assertTrue(audition.ownedBy(second))
        cancel(second)
        assertNull(audition.original)
    }

}
