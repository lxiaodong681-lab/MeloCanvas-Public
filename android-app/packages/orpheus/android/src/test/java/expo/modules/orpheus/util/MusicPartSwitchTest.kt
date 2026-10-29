package expo.modules.orpheus.util

import expo.modules.orpheus.model.TrackRecord
import expo.modules.orpheus.widget.WidgetStamp
import org.junit.Assert.*
import org.junit.Test

class MusicPartSwitchTest {
    private fun track(cid: Int, entry: String? = null) = TrackRecord().apply {
        sourceId = "bilibili:BV1vT411i7ET:$cid"; id = entry ?: sourceId!!
        url = "orpheus://bilibili?bvid=BV1vT411i7ET&cid=$cid&quality=30232"; duration = 120.0 + cid
    }
    private fun stored() = StoredPlaybackSessions(active = PlaybackSessionSnapshot(
        tracks = listOf(track(1, "playlist-item:first"), track(1, "playlist-item:second"), track(2, "playlist-item:third")),
        currentEntryId = "playlist-item:second", currentSourceId = track(1).sourceId,
        positionSeconds = 47.0, durationSeconds = 121.0, speed = 1.25f,
        playing = false, playWhenReady = true, repeatMode = 2,
        shuffleEntryIds = listOf("playlist-item:third", "playlist-item:second", "playlist-item:first")),
        inactive = PlaybackSessionSnapshot(mode = "listening", tracks = listOf(track(5)),
            currentEntryId = track(5).id, currentSourceId = track(5).sourceId, positionSeconds = 88.0, speed = 1.5f),
        widgetStamp = WidgetStamp.create())
    private fun replace(value: StoredPlaybackSessions, target: TrackRecord = track(3, "playlist-item:second")) =
        MusicPartSwitch.replace(value, target, "playlist-item:second", track(1).sourceId!!, 50L)
    private fun rejects(action: () -> Unit) = assertThrows(IllegalArgumentException::class.java, action)

    @Test fun replacesOnlyCurrentOccurrenceAndRoundtripsTheLatestNativeStrategiesAndBothQueues() {
        val before = stored()
        val selected = track(3, "playlist-item:second")
        val next = replace(before, selected)
        assertSame(before.active.tracks[0], next.active.tracks[0])
        assertSame(selected, next.active.tracks[1])
        assertSame(before.active.tracks[2], next.active.tracks[2])
        assertSame(before.inactive, next.inactive)
        assertNotEquals(before.widgetStamp, next.widgetStamp)
        val restored = requireNotNull(PlaybackSessionCodec.decode(PlaybackSessionCodec.encode(next)))
        assertEquals("playlist-item:second", restored.active.currentEntryId)
        assertEquals(track(3).sourceId, restored.active.currentSourceId)
        assertEquals(0.0, restored.active.positionSeconds, 0.0)
        assertEquals(123.0, restored.active.durationSeconds, 0.0)
        assertEquals(1.25f, restored.active.speed)
        assertFalse(restored.active.playing)
        assertTrue(restored.active.playWhenReady)
        assertEquals(2, restored.active.repeatMode)
        assertEquals(before.active.shuffleEntryIds, restored.active.shuffleEntryIds)
        val inactive = requireNotNull(restored.inactive)
        assertEquals(88.0, inactive.positionSeconds, 0.0)
        assertEquals(1.5f, inactive.speed)
        assertNull(restored.fm)
        val playing = replace(before.copy(active = before.active.copy(playing = true, playWhenReady = true)))
        assertTrue(playing.active.playing)
        assertTrue(playing.active.playWhenReady)
    }

    @Test fun directLegacyOccurrenceSurvivesMultipleSwitchesAndColdSerialization() {
        val old = track(1)
        val initial = StoredPlaybackSessions(PlaybackSessionSnapshot(tracks = listOf(old),
            currentEntryId = old.id, currentSourceId = old.sourceId), widgetStamp = WidgetStamp.create())
        val second = MusicPartSwitch.replace(initial, track(2, old.id), old.id, old.sourceId!!)
        val read = requireNotNull(PlaybackSessionCodec.decode(PlaybackSessionCodec.encode(second)))
        val third = MusicPartSwitch.replace(read, track(3, old.id), old.id, track(2).sourceId!!)
        assertEquals(old.id, third.active.currentEntryId)
        assertEquals(track(3).sourceId, third.active.currentSourceId)
        assertTrue(PlaybackSessionCodec.validStored(third))
    }

    @Test fun changedOccurrenceOrPartModeAndFmCannotOverwriteAnotherSession() {
        val before = stored()
        rejects { replace(before.copy(active = before.active.copy(currentEntryId = "playlist-item:first"))) }
        rejects { replace(before.copy(active = before.active.copy(tracks = listOf(track(2, "playlist-item:second")),
            currentSourceId = track(2).sourceId, shuffleEntryIds = null))) }
        rejects { replace(before.copy(active = before.inactive!!, inactive = before.active)) }
        val fm = FmPlaybackSessions.start(before, listOf(track(1, "playlist-item:second")))
        rejects { replace(fm) }
        assertEquals(track(1).sourceId, before.active.currentSourceId)
        assertEquals(47.0, before.active.positionSeconds, 0.0)
    }

    @Test fun samePartDoesNotRestartAndOfflineRoutingCannotBeDropped() {
        val before = stored()
        assertSame(before, replace(before, track(1, "playlist-item:second")))
        before.active.tracks[1].url += "&meloOffline=1"
        rejects { replace(before) }
        val target = track(3, "playlist-item:second").apply { url += "&meloOffline=1" }
        assertTrue(replace(before, target).active.tracks[1].url.endsWith("&meloOffline=1"))
    }

    @Test fun targetMustKeepTheExactOccurrenceRealBvCidAndStableUri() {
        val before = stored()
        rejects { replace(before, track(3, "playlist-item:other")) }
        rejects { replace(before, track(3, "playlist-item:second").apply { url = url.replace("cid=3", "cid=4") }) }
        rejects { replace(before, track(3, "playlist-item:second").apply {
            sourceId = "bilibili:BV1Q541167Qg:3"; url = url.replace("BV1vT411i7ET", "BV1Q541167Qg")
        }) }
        rejects { replace(before, track(3, "playlist-item:second").apply { url = "https://example.com/audio?token=example" }) }
        rejects { replace(before, track(3, "playlist-item:second").apply { sourceId = null }) }
    }

    @Test fun cancelledPreparationCannotCommitAndLateCurrentChangeIsRecheckedInsideTheGuard() {
        val guard = PlaybackReplacementGuard()
        val before = stored()
        var live = before
        val cancelled = guard.begin()
        guard.cancelIfCurrent(cancelled)
        assertNull(guard.commit(cancelled) { live = replace(live) })
        assertSame(before, live)
        val current = guard.begin()
        live = before.copy(active = before.active.copy(currentEntryId = "playlist-item:first"))
        val changed = live
        rejects { guard.commit(current) { live = replace(live) } }
        assertSame(changed, live)
        assertFalse(guard.isPending())
    }
}
