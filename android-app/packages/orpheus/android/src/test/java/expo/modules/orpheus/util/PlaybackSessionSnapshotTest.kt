package expo.modules.orpheus.util

import expo.modules.orpheus.model.TrackRecord
import org.junit.Assert.*
import org.junit.Test

class PlaybackSessionSnapshotTest {
    @Test fun activeAndInactivePositionsSurviveOneValueRoundTrip() {
        val music = TrackRecord().apply {
            id = "bilibili:BV1vT411i7ET:123"
            url = "orpheus://bilibili?bvid=BV1vT411i7ET&cid=123"
        }
        val listening = TrackRecord().apply {
            id = "bilibili:BV1vT411i7ET:124"
            url = "orpheus://bilibili?bvid=BV1vT411i7ET&cid=124"
        }
        val stored = StoredPlaybackSessions(
            active = PlaybackSessionSnapshot(mode = "listening", tracks = listOf(listening), currentSourceId = listening.id, currentEntryId = listening.id, positionSeconds = 312.5, speed = 1.5f),
            inactive = PlaybackSessionSnapshot(mode = "music", tracks = listOf(music), currentSourceId = music.id, currentEntryId = music.id, positionSeconds = 87.25, speed = 1f),
        )
        val restored = requireNotNull(PlaybackSessionCodec.decode(PlaybackSessionCodec.encode(stored)))
        assertEquals("listening", restored.active.mode)
        assertEquals(312.5, restored.active.positionSeconds, 0.0)
        assertEquals(1.5f, restored.active.speed)
        assertEquals("music", restored.inactive?.mode)
        assertEquals(87.25, restored.inactive!!.positionSeconds, 0.0)
    }

    @Test fun omittedVersionAndModeUseBackwardCompatibleDefaults() {
        val restored = requireNotNull(PlaybackSessionCodec.decode("""{"active":{},"newField":"ignored"}"""))
        assertEquals(3, restored.version)
        assertNull(restored.active.currentEntryId)
        assertEquals("music", restored.active.mode)
        assertEquals(0.0, restored.active.positionSeconds, 0.0)
        assertNull(restored.inactive)
    }
}
