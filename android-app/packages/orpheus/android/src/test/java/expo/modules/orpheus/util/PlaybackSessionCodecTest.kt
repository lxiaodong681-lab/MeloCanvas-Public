package expo.modules.orpheus.util

import expo.modules.orpheus.model.TrackRecord
import org.junit.Assert.*
import org.junit.Test

class PlaybackSessionCodecTest {
    private fun localMusic(): PlaybackSessionSnapshot {
        val localId = "12345678-90ab-4cde-8fab-123456789abc"
        val source = LocalAudioIdentity.sourceId(localId)
        val item = TrackRecord().apply {
            id = source; sourceId = source; url = LocalAudioIdentity.uri(localId); duration = 180.0
        }
        return PlaybackSessionSnapshot(tracks = listOf(item), currentEntryId = source,
            currentSourceId = source, positionSeconds = 42.5, durationSeconds = 180.0,
            playing = true, playWhenReady = true)
    }

    @Test fun repeatedLocalPlaylistOccurrencesSurviveColdStorageAndFmFreeze() {
        val local = localMusic()
        val original = local.tracks.single()
        fun occurrence(id: String) = TrackRecord().apply {
            this.id = "playlist-item:$id"; sourceId = original.sourceId
            url = original.url; duration = original.duration
        }
        val first = occurrence("local-first")
        val second = occurrence("local-second")
        val repeated = local.copy(tracks = listOf(first, second), currentEntryId = second.id)
        val restored = requireNotNull(PlaybackSessionCodec.decode(PlaybackSessionCodec.encode(StoredPlaybackSessions(repeated))))
        assertEquals(listOf(first.id, second.id), restored.active.tracks.map { it.id })
        assertEquals(second.id, restored.active.currentEntryId)
        assertEquals(original.sourceId, restored.active.currentSourceId)
        assertEquals(42.5, restored.active.positionSeconds, 0.0)
        val frozen = FmPlaybackSessions.start(restored, listOf(track(source)))
        val frozenRoundTrip = requireNotNull(PlaybackSessionCodec.decode(PlaybackSessionCodec.encode(frozen)))
        val returned = FmPlaybackSessions.exit(frozenRoundTrip, requireNotNull(frozenRoundTrip.fm).id)
        assertEquals(second.id, returned.active.currentEntryId)
        assertEquals(listOf(first.id, second.id), returned.active.tracks.map { it.id })
        assertFalse(PlaybackSessionCodec.validSession(repeated.copy(mode = "listening")))
        try {
            FmPlaybackSessions.start(restored, repeated.tracks)
            fail("Local playlist occurrences cannot become generated FM")
        } catch (_: IllegalArgumentException) { }
    }

    @Test fun localColdSnapshotRoundTripNeedsNoFilesystemAndKeepsBothModes() {
        // No local file exists here. Availability must not become storage corruption.
        val local = localMusic()
        for (stored in listOf(StoredPlaybackSessions(local, listening()), StoredPlaybackSessions(listening(), local))) {
            val restored = requireNotNull(PlaybackSessionCodec.decode(PlaybackSessionCodec.encode(stored)))
            val music = if (restored.active.mode == "music") restored.active else requireNotNull(restored.inactive)
            assertEquals(local.currentEntryId, music.currentEntryId)
            assertEquals(local.currentSourceId, music.currentSourceId)
            assertEquals(local.tracks[0].url, music.tracks[0].url)
            assertEquals(42.5, music.positionSeconds, 0.0)
        }
    }

    @Test fun fmCanFreezeAndReturnLocalManualMusicButCannotGenerateLocalFm() {
        val local = localMusic()
        val started = FmPlaybackSessions.start(StoredPlaybackSessions(local), listOf(track(source)))
        val restored = requireNotNull(PlaybackSessionCodec.decode(PlaybackSessionCodec.encode(started)))
        assertEquals(local.currentEntryId, restored.fm?.manualMusic?.currentEntryId)
        val returned = FmPlaybackSessions.exit(restored, requireNotNull(restored.fm).id)
        assertEquals(local.currentEntryId, returned.active.currentEntryId)
        assertEquals(42.5, returned.active.positionSeconds, 0.0)
        try {
            FmPlaybackSessions.start(StoredPlaybackSessions(playlist()), local.tracks)
            fail("Local audio cannot enter generated FM")
        } catch (_: IllegalArgumentException) { }
        assertFalse(PlaybackSessionCodec.validStored(started.copy(active = local)))
    }

    @Test fun localListeningAndMismatchedOrRawFileSnapshotsRemainInvalid() {
        assertFalse(PlaybackSessionCodec.validSession(localMusic().copy(mode = "listening")))
        for (bad in listOf("file:///tmp/audio", "content://audio/123", "https://example.com/audio",
            "orpheus://local-audio?id=12345678-90ab-4cde-8fab-123456789abd")) {
            val local = localMusic()
            local.tracks[0].url = bad
            assertFalse(bad, PlaybackSessionCodec.validSession(local))
        }
    }

    private val source = "bilibili:BV1vT411i7ET:123"
    private val uri = "orpheus://bilibili?bvid=BV1vT411i7ET&cid=123&quality=30232"
    private fun track(entryId: String) = TrackRecord().apply {
        id = entryId; sourceId = source; url = uri; duration = 300.0
    }
    private fun playlist() = PlaybackSessionSnapshot(
        tracks = listOf(track("playlist-item:a1"), TrackRecord().apply {
            id = "playlist-item:b"; sourceId = "bilibili:BV1vT411i7ET:456"
            url = uri.replace("cid=123", "cid=456"); duration = 300.0
        }, track("playlist-item:a2")),
        currentSourceId = source, currentEntryId = "playlist-item:a2", positionSeconds = 86.0,
        durationSeconds = 300.0, speed = 1f, playing = true,
    )
    private fun listening() = PlaybackSessionSnapshot(mode = "listening", tracks = listOf(track(source)),
        currentEntryId = source, currentSourceId = source, positionSeconds = 14.0)

    @Test fun v3RoundTripKeepsSecondOccurrenceAndBothQueues() {
        val session = playlist()
        val stored = StoredPlaybackSessions(session, PlaybackSessionSnapshot(
            mode = "listening", tracks = listOf(track(source)), currentSourceId = source,
            currentEntryId = source, positionSeconds = 14.0, speed = 1.5f,
        ))
        val raw = PlaybackSessionCodec.encode(stored)
        assertTrue(raw.contains("\"version\":3"))
        val decoded = requireNotNull(PlaybackSessionCodec.decode(raw))
        assertEquals(3, decoded.version)
        assertEquals(3, decoded.active.tracks.size)
        assertEquals(2, decoded.active.tracks.indexOfFirst { it.id == decoded.active.currentEntryId })
        assertEquals(source, decoded.active.currentSourceId)
        assertEquals(86.0, decoded.active.positionSeconds, 0.0)
        assertEquals(source, decoded.inactive?.currentEntryId)
        assertEquals("listening", decoded.inactive?.mode)
        assertEquals(14.0, decoded.inactive!!.positionSeconds, 0.0)
    }

    @Test fun legacyV1WithAbsentOrExplicitVersionPreservesIdentityAndPosition() {
        val active = """{"tracks":[{"id":"$source","url":"$uri"}],"currentSourceId":"$source","positionSeconds":61.5,"playing":true}"""
        val inactive = active.replace("{\"tracks\"", "{\"mode\":\"listening\",\"tracks\"")
        for (version in listOf("", ",\"version\":1")) {
            val restored = requireNotNull(PlaybackSessionCodec.decode("""{"active":$active,"inactive":$inactive$version}"""))
            assertEquals(3, restored.version)
            assertEquals(source, restored.active.currentEntryId)
            assertEquals(source, restored.active.tracks[0].sourceId)
            assertEquals(61.5, restored.active.positionSeconds, 0.0)
            assertEquals(source, restored.inactive?.currentEntryId)
            assertNotNull(PlaybackSessionCodec.decode(PlaybackSessionCodec.encode(restored)))
        }
    }

    @Test fun newV2CannotGuessTheCurrentOccurrenceOrTrustAMismatchedSource() {
        val raw = PlaybackSessionCodec.encode(StoredPlaybackSessions(playlist()))
        assertNull(PlaybackSessionCodec.decode(raw.replace("\"currentEntryId\":\"playlist-item:a2\"", "\"currentEntryId\":null")))
        assertNull(PlaybackSessionCodec.decode(raw.replace("\"version\":3", "\"version\":4")))
        val mismatched = playlist().copy(currentSourceId = "bilibili:BV1vT411i7ET:456")
        assertFalse(PlaybackSessionCodec.validSession(mismatched))
        assertFalse(PlaybackSessionCodec.validSession(playlist().copy(tracks = listOf(track("playlist-item:a1"), track("playlist-item:a1")))))
        assertFalse(PlaybackSessionCodec.validSession(playlist().also { it.tracks[2].sourceId = null }))
        assertFalse(PlaybackSessionCodec.validSession(playlist().also { it.tracks[2].url = uri.replace("cid=123", "cid=999") }))
    }

    @Test fun actualV2FieldsMigrateWithoutInventingFmOrLosingThirdOccurrenceAndIntent() {
        val raw = """{"version":2,"active":{"mode":"music","tracks":[
            {"id":"playlist-item:a","sourceId":"$source","url":"$uri"},
            {"id":"playlist-item:a2","sourceId":"$source","url":"$uri"}],
            "currentEntryId":"playlist-item:a2","currentSourceId":"$source","positionSeconds":20.227,"playing":true}}"""
        val restored = requireNotNull(PlaybackSessionCodec.decode(raw))
        assertEquals(3, restored.version)
        assertNull(restored.fm)
        assertEquals("playlist-item:a2", restored.active.currentEntryId)
        assertEquals(20.227, restored.active.positionSeconds, 0.0)
        assertTrue(restored.active.playWhenReady)
        assertEquals(0, restored.active.repeatMode)
        assertNull(restored.active.shuffleEntryIds)
    }

    @Test fun legacyV2InvalidInactiveSessionIsIgnoredWithoutDiscardingValidActiveQueue() {
        val raw = PlaybackSessionCodec.encode(StoredPlaybackSessions(playlist(), listening())).replace("\"version\":3", "\"version\":2")
        val split = raw.indexOf("\"inactive\":")
        val corrupted = raw.take(split) + raw.drop(split).replace("\"currentEntryId\":\"$source\"", "\"currentEntryId\":null")
        val decoded = requireNotNull(PlaybackSessionCodec.decode(corrupted))
        assertEquals("playlist-item:a2", decoded.active.currentEntryId)
        assertNull(decoded.inactive)
    }

    @Test fun widgetStampRoundTripsWithoutChangingEitherQueueAndMissingOrMalformedStampOnlyDropsWidgetAccess() {
        val active = playlist()
        val stamp = expo.modules.orpheus.widget.WidgetStamp.create()
        val raw = PlaybackSessionCodec.encode(StoredPlaybackSessions(active, listening(), widgetStamp = stamp))
        val restored = requireNotNull(PlaybackSessionCodec.decode(raw))
        assertEquals(stamp, restored.widgetStamp)
        assertEquals("playlist-item:a2", restored.active.currentEntryId)
        assertEquals(1, restored.inactive?.tracks?.size)
        for (bad in listOf("null", "123", "{}", "[]", "true", "\"bad\"")) {
            val decoded = requireNotNull(PlaybackSessionCodec.decode(raw.replace("\"widgetStamp\":\"$stamp\"", "\"widgetStamp\":$bad")))
            assertNull(decoded.widgetStamp)
            assertEquals(3, decoded.active.tracks.size)
            assertEquals(86.0, decoded.active.positionSeconds, 0.0)
            assertEquals(source, decoded.inactive?.currentEntryId)
        }
        val legacy = raw.replace(",\"widgetStamp\":\"$stamp\"", "")
        val withoutStamp = requireNotNull(PlaybackSessionCodec.decode(legacy))
        assertNull(withoutStamp.widgetStamp)
        assertEquals("playlist-item:a2", withoutStamp.active.currentEntryId)
        assertTrue(expo.modules.orpheus.widget.WidgetStamp.valid(expo.modules.orpheus.widget.WidgetStamp.restored(withoutStamp.widgetStamp)))
    }
}
