package expo.modules.orpheus.util

import expo.modules.orpheus.model.TrackRecord
import expo.modules.orpheus.widget.WidgetStamp
import org.junit.Assert.*
import org.junit.Test

class FmPlaybackSessionsTest {
    private fun track(cid: Int, entry: String? = null) = TrackRecord().apply {
        sourceId = "bilibili:BV1vT411i7ET:$cid"; id = entry ?: sourceId!!
        url = "orpheus://bilibili?bvid=BV1vT411i7ET&cid=$cid&quality=30232"; duration = 500.0
    }
    private fun manual() = PlaybackSessionSnapshot(tracks = listOf(track(1, "playlist-item:a"),
        track(2, "playlist-item:b"), track(1, "playlist-item:a2")), currentEntryId = "playlist-item:a2",
        currentSourceId = track(1).sourceId, positionSeconds = 80.227, durationSeconds = 500.0,
        playing = false, playWhenReady = true, repeatMode = 2,
        shuffleEntryIds = listOf("playlist-item:a2", "playlist-item:a", "playlist-item:b"))
    private fun listening(cid: Int = 10) = PlaybackSessionSnapshot(mode = "listening", tracks = listOf(track(cid)),
        currentEntryId = track(cid).id, currentSourceId = track(cid).id, positionSeconds = 42.5,
        speed = 1.7f, playing = false, playWhenReady = true)
    private fun stored(active: PlaybackSessionSnapshot = manual(), inactive: PlaybackSessionSnapshot? = listening()) =
        StoredPlaybackSessions(active, inactive, widgetStamp = WidgetStamp.create())
    private fun roundtrip(value: StoredPlaybackSessions) = requireNotNull(PlaybackSessionCodec.decode(PlaybackSessionCodec.encode(value)))

    @Test fun manualFmListeningReturnFmThenExitRestoresExactOccurrenceStrategiesAndBufferingIntent() {
        val original = stored()
        val started = FmPlaybackSessions.start(original, listOf(track(20), track(21)))
        val fmId = started.fm!!.id
        assertEquals(original.active.currentEntryId, started.fm.manualMusic!!.currentEntryId)
        assertFalse(started.fm.manualMusic!!.playing)
        assertTrue(started.fm.manualMusic!!.playWhenReady)
        assertNotEquals(original.widgetStamp, started.widgetStamp)
        val away = FmPlaybackSessions.replace(started, listening(11), null)
        assertEquals(fmId, away.fm!!.id)
        assertEquals(started.active.currentEntryId, away.inactive!!.currentEntryId)
        val returned = FmPlaybackSessions.replace(away, away.inactive!!.copy(positionSeconds = 13.0), fmId)
        assertEquals(13.0, returned.active.positionSeconds, 0.0)
        val exited = roundtrip(FmPlaybackSessions.exit(returned, fmId))
        assertNull(exited.fm)
        assertEquals("playlist-item:a2", exited.active.currentEntryId)
        assertEquals(listOf("playlist-item:a", "playlist-item:b", "playlist-item:a2"), exited.active.tracks.map { it.id })
        assertEquals(80.227, exited.active.positionSeconds, 0.0)
        assertTrue(exited.active.playWhenReady)
        assertEquals(2, exited.active.repeatMode)
        assertEquals(original.active.shuffleEntryIds, exited.active.shuffleEntryIds)
        assertEquals(listening(11).currentEntryId, exited.inactive!!.currentEntryId)
    }

    @Test fun enteringFromListeningFreezesFirstReturnAndKeepsManualMusicSeparateThroughFurtherSwitches() {
        val original = stored(listening(), manual())
        val started = FmPlaybackSessions.start(original, listOf(track(20)))
        val laterListening = FmPlaybackSessions.replace(started, listening(11).copy(positionSeconds = 96.0), null)
        val exited = roundtrip(FmPlaybackSessions.exit(laterListening, started.fm!!.id))
        assertEquals("listening", exited.active.mode)
        assertEquals(listening().currentEntryId, exited.active.currentEntryId)
        assertEquals(42.5, exited.active.positionSeconds, 0.0)
        assertEquals(1.7f, exited.active.speed)
        assertTrue(exited.active.playWhenReady)
        assertEquals("playlist-item:a2", exited.inactive!!.currentEntryId)
        assertNull(exited.fm)
        assertEquals(42.5, laterListening.fm!!.returnListening!!.positionSeconds, 0.0)
    }

    @Test fun emptyManualReturnIsSilentAndDoesNotLoseTheListeningSide() {
        for (active in listOf(PlaybackSessionSnapshot(), PlaybackSessionSnapshot().copy(playWhenReady = true))) {
            val original = stored(active)
            val started = FmPlaybackSessions.start(original, listOf(track(20)))
            val exited = FmPlaybackSessions.exit(started, started.fm!!.id)
            assertTrue(exited.active.tracks.isEmpty())
            assertFalse(exited.active.playWhenReady)
            assertEquals("listening", exited.inactive!!.mode)
            assertNull(exited.fm)
        }
        val fromListening = FmPlaybackSessions.start(stored(listening(), null), listOf(track(20)))
        assertNull(fromListening.fm!!.manualMusic)
        assertNull(FmPlaybackSessions.exit(fromListening, fromListening.fm.id).inactive)
    }

    @Test fun explicitManualReplacementClearsFmButCannotOverwriteListening() {
        val started = FmPlaybackSessions.start(stored(), listOf(track(20)))
        val away = FmPlaybackSessions.replace(started, listening(11), null)
        val target = manual().copy(repeatMode = 0, shuffleEntryIds = null)
        val next = FmPlaybackSessions.replace(away, target, null)
        assertNull(next.fm)
        assertEquals(listening(11).currentEntryId, next.inactive!!.currentEntryId)
        assertEquals(2, next.active.repeatMode)
        assertEquals(manual().shuffleEntryIds, next.active.shuffleEntryIds)
        assertThrows(IllegalArgumentException::class.java) { FmPlaybackSessions.start(started, listOf(track(21))) }
    }

    @Test fun manualPreferenceSurvivesColdStartListeningAndACompletelyNewQueue() {
        for (original in listOf(stored(), stored(listening(), manual()))) {
            val restored = roundtrip(original)
            val target = PlaybackSessionSnapshot(tracks = listOf(track(30), track(31)), currentEntryId = track(30).id,
                currentSourceId = track(30).id)
            val next = roundtrip(FmPlaybackSessions.replace(restored, target, null))
            assertEquals(2, next.active.repeatMode)
            assertEquals(setOf(track(30).id, track(31).id), next.active.shuffleEntryIds!!.toSet())
            val temporaryFm = FmPlaybackSessions.start(next, listOf(track(40)))
            assertEquals(0, temporaryFm.active.repeatMode)
            assertNull(temporaryFm.active.shuffleEntryIds)
            val manualAgain = FmPlaybackSessions.replace(temporaryFm, target, null)
            assertEquals(next.active.shuffleEntryIds, manualAgain.active.shuffleEntryIds)
        }
    }

    @Test fun selectionRequiresTheSameContextAndEntireQueueAfterConcurrentAppend() {
        val started = FmPlaybackSessions.start(stored(), listOf(track(20), track(21)))
        val id = started.fm!!.id
        val appended = requireNotNull(FmPlaybackSessions.append(started, listOf(track(22)), id, track(21).id))
        assertThrows(IllegalArgumentException::class.java) { FmPlaybackSessions.replace(appended, started.active, id) }
        assertThrows(IllegalArgumentException::class.java) { FmPlaybackSessions.replace(started, started.active, WidgetStamp.create()) }
        assertThrows(IllegalArgumentException::class.java) { FmPlaybackSessions.exit(started, WidgetStamp.create()) }
        assertThrows(IllegalArgumentException::class.java) { FmPlaybackSessions.replace(started, started.active.copy(repeatMode = 1), id) }
        assertNotEquals(started.widgetStamp, FmPlaybackSessions.replace(started, roundtrip(started).active, id).widgetStamp)
    }

    @Test fun appendHasTailContextCasAndNeverChangesCursorTransportBackupOrStamp() {
        val started = FmPlaybackSessions.start(stored(), listOf(track(20))).let {
            it.copy(active = it.active.copy(positionSeconds = 12.5, playing = false, playWhenReady = true))
        }
        assertNull(FmPlaybackSessions.append(started, listOf(track(21)), WidgetStamp.create(), track(20).id))
        assertNull(FmPlaybackSessions.append(started, listOf(track(21)), started.fm!!.id, "old-tail"))
        for (state in listOf(started, FmPlaybackSessions.replace(started, listening(), null))) {
            val next = requireNotNull(FmPlaybackSessions.append(state, listOf(track(21)), state.fm!!.id, track(20).id))
            val music = FmPlaybackSessions.music(next)!!
            assertEquals(track(20).id, music.currentEntryId)
            assertEquals(12.5, music.positionSeconds, 0.0)
            assertTrue(music.playWhenReady)
            assertEquals(state.widgetStamp, next.widgetStamp)
            assertSame(state.fm, next.fm)
            assertEquals(2, music.tracks.size)
        }
    }

    @Test fun appendRejectsDuplicateEntryOrSourceMalformedTrackAndBudgets() {
        val started = FmPlaybackSessions.start(stored(), listOf(track(20)))
        val id = started.fm!!.id
        for (tracks in listOf(emptyList(), listOf(track(20)), listOf(track(20, "playlist-item:copy")),
            listOf(track(21).also { it.url = "https://example.test/signed" }), (100..150).map { track(it) })) {
            assertThrows(IllegalArgumentException::class.java) { FmPlaybackSessions.append(started, tracks, id, track(20).id) }
        }
        val full = FmPlaybackSessions.start(stored(), (1..5000).map { track(it) })
        assertThrows(IllegalArgumentException::class.java) { FmPlaybackSessions.append(full, listOf(track(5001)), full.fm!!.id, track(5000).id) }
    }

    @Test fun codecRetainsThreeQueuesAndRejectsContradictoryContextOrShuffleWithoutDiscardingBytes() {
        val started = FmPlaybackSessions.start(stored(listening(), manual()), listOf(track(20)))
        val copy = roundtrip(started)
        assertEquals(started.fm!!.id, copy.fm!!.id)
        assertEquals("playlist-item:a2", copy.fm.manualMusic!!.currentEntryId)
        assertEquals(listening().currentEntryId, copy.fm.returnListening!!.currentEntryId)
        assertFalse(PlaybackSessionCodec.validStored(started.copy(fm = started.fm.copy(id = "bad"))))
        assertFalse(PlaybackSessionCodec.validStored(started.copy(active = started.active.copy(repeatMode = 2))))
        assertFalse(PlaybackSessionCodec.validSession(manual().copy(shuffleEntryIds = listOf("playlist-item:a"))))
        assertFalse(PlaybackSessionCodec.validStored(started.copy(fm = started.fm.copy(returnListening = null))))
    }

    @Test fun unknownOrBrokenPersistentBytesCannotBeOverwrittenAndFailedWritesKeepOriginal() {
        val value = stored()
        for (original in listOf("{broken", """{"version":4,"opaque":"keep me"}""", """{"version":3,"active":{"mode":"broken"}}""")) {
            var raw: String? = original
            var writes = 0
            val persistence = PlaybackSessionPersistence({ raw }, { writes++; raw = it; true })
            assertNull(persistence.get())
            assertThrows(IllegalStateException::class.java) { persistence.save(value) }
            assertEquals(original, raw)
            assertEquals(0, writes)
        }
        var raw: String? = null
        val persistence = PlaybackSessionPersistence({ raw }, { raw = it; true })
        persistence.save(value)
        val before = raw
        val failed = PlaybackSessionPersistence({ raw }, { false })
        assertThrows(IllegalStateException::class.java) { failed.save(FmPlaybackSessions.start(value, listOf(track(20)))) }
        assertEquals(before, raw)
        assertEquals("playlist-item:a2", persistence.get()!!.active.currentEntryId)
    }

    @Test fun v3MalformedInactiveAndAmbiguousLegacySameModeStayUnreadableWithOriginalBytes() {
        val fm = FmPlaybackSessions.start(stored(), listOf(track(20)))
        val valid = PlaybackSessionCodec.encode(fm)
        val inactiveStart = valid.indexOf("\"inactive\":")
        val broken = valid.take(inactiveStart) + valid.drop(inactiveStart).replace("\"currentEntryId\":\"${track(10).id}\"", "\"currentEntryId\":null")
        assertNotEquals(valid, broken)
        val manual = PlaybackSessionCodec.encode(stored())
        val sameMode = manual.replace("\"mode\":\"listening\"", "\"mode\":\"music\"")
        for (raw in listOf(broken, sameMode, sameMode.replace("\"version\":3", "\"version\":2"),
            """{"version":1,"active":{},"inactive":{}}""")) {
            var bytes = raw
            var writes = 0
            val persistence = PlaybackSessionPersistence({ bytes }, { writes++; bytes = it; true })
            assertNull(persistence.get())
            assertThrows(IllegalStateException::class.java) { persistence.save(stored()) }
            assertEquals(raw, bytes)
            assertEquals(0, writes)
        }
    }

    @Test fun persistenceReadDistinguishesMissingFromUnreadableAndAvailable() {
        var raw: String? = null
        val persistence = PlaybackSessionPersistence({ raw }, { raw = it; true })
        assertSame(PlaybackSessionRead.Missing, persistence.read())
        raw = "{broken"
        assertSame(PlaybackSessionRead.Unreadable, persistence.read())
        raw = PlaybackSessionCodec.encode(stored())
        assertEquals("playlist-item:a2", (persistence.read() as PlaybackSessionRead.Available).sessions.active.currentEntryId)
    }
}
