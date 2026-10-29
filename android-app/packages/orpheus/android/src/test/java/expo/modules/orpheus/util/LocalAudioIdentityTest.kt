package expo.modules.orpheus.util

import org.junit.Assert.*
import org.junit.Test

class LocalAudioIdentityTest {
    private val id = "12345678-90ab-4cde-8fab-123456789abc"
    private val source = "local:$id"
    private val uri = "orpheus://local-audio?id=$id"

    @Test fun canonicalIdRoundTripsWithoutAnyPath() {
        assertTrue(LocalAudioIdentity.validId(id))
        assertEquals(source, LocalAudioIdentity.sourceId(id))
        assertEquals(uri, LocalAudioIdentity.uri(id))
        assertEquals(id, LocalAudioIdentity.idFromUri(uri))
        assertTrue(LocalAudioIdentity.isValid(source, uri))
    }

    @Test fun aliasesPathsQueryAmbiguityAndOtherSchemesAreRejected() {
        for (invalid in listOf("", id.uppercase(), "../$id", "$id.mp3", "$id/", " $id", "1-2-3-4-5")) {
            assertFalse(invalid, LocalAudioIdentity.validId(invalid))
            assertNull(LocalAudioIdentity.idFromUri("orpheus://local-audio?id=$invalid"))
        }
        for (invalid in listOf("$uri&id=$id", "$uri&quality=30232", "$uri#fragment", "$uri/",
            "orpheus://local-audio/?id=$id", "orpheus://user@local-audio?id=$id",
            "orpheus://local-audio:80?id=$id", "orpheus://local-audio?id=%31${id.drop(1)}",
            "file:///data/user/0/org.melocanvas.app/files/melo-local-audio/$id", "content://audio/$id",
            "https://example.com/$id", "ORPHEUS://local-audio?id=$id")) {
            assertNull(invalid, LocalAudioIdentity.idFromUri(invalid))
            assertFalse(invalid, LocalAudioIdentity.isValid(source, invalid))
        }
        assertFalse(LocalAudioIdentity.isValid("local:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", uri))
    }

    @Test fun localMusicSupportsExplicitPlaylistOccurrencesWithoutSpoofing() {
        assertTrue(PlaybackSourceIdentity.isValidEntry(source, source, uri, "music"))
        assertTrue(PlaybackSourceIdentity.isValidEntry(source, null, uri, "music"))
        assertFalse(PlaybackSourceIdentity.isValidEntry(source, source, uri, "listening"))
        // PR49 explicitly supports local audio inside saved music playlists.
        assertTrue(PlaybackSourceIdentity.isValidEntry("playlist-item:a", source, uri, "music"))
        assertFalse(PlaybackSourceIdentity.isValidEntry("playlist-item:a", source, uri, "listening"))
        assertFalse(PlaybackSourceIdentity.isValidEntry("playlist-item:a", null, uri, "music"))
        assertFalse(PlaybackSourceIdentity.isValidEntry("playlist-item:", source, uri, "music"))
        assertFalse(PlaybackSourceIdentity.isValidEntry("playlist-item: ", source, uri, "music"))
        assertFalse(PlaybackSourceIdentity.isValidEntry("playlist-item:a", source, "file:///$id", "music"))
        assertFalse(PlaybackSourceIdentity.isValidEntry("playlist-item:a", "local:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", uri, "music"))
        assertFalse(PlaybackSourceIdentity.isValidEntry("bilibili:BV1vT411i7ET:123", source, uri, "music"))
        assertFalse(PlaybackSourceIdentity.isValidEntry(source, source, "file:///$id", "music"))
        assertFalse(PlaybackSourceIdentity.isValid(source, uri)) // Legacy Bilibili validation remains unchanged.
    }
}
