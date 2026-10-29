package expo.modules.orpheus.util

import expo.modules.orpheus.model.TrackRecord
import org.junit.Assert.*
import org.junit.Test

class MusicPlaybackOrderTest {
    private fun track(id: String, cid: Int) = TrackRecord().apply {
        this.id = id; sourceId = "bilibili:BV1vT411i7ET:$cid"
        url = "orpheus://bilibili?bvid=BV1vT411i7ET&cid=$cid&quality=30232"
    }
    private val a = track("playlist-item:a", 1)
    private val duplicateA = track("playlist-item:a2", 1)
    private val b = track("playlist-item:b", 2)
    private fun session() = PlaybackSessionSnapshot(tracks = listOf(a, b, duplicateA),
        currentEntryId = a.id, currentSourceId = a.sourceId, positionSeconds = 69.75, repeatMode = 2,
        shuffleEntryIds = listOf(a.id, duplicateA.id, b.id))

    @Test fun currentSelectionKeepsPositionButAnotherOccurrenceOrChangedSourceDoesNot() {
        val current = session()
        assertTrue(MusicPlaybackOrder.canResume(current, listOf(a, b, duplicateA), a.id))
        assertFalse(MusicPlaybackOrder.canResume(current, current.tracks, duplicateA.id))
        assertFalse(MusicPlaybackOrder.canResume(current.copy(mode = "listening"), current.tracks, a.id))
        assertFalse(MusicPlaybackOrder.canResume(current, listOf(a, b), a.id))
        assertFalse(MusicPlaybackOrder.canResume(current, listOf(track(a.id, 3), b, duplicateA), a.id))
        val target = current.copy(tracks = listOf(a, b), positionSeconds = 0.0)
        assertEquals(69.75, MusicPlaybackOrder.retainCurrentPosition(current, target).positionSeconds, 0.0)
        assertEquals(0.0, MusicPlaybackOrder.retainCurrentPosition(current,
            target.copy(currentEntryId = b.id, currentSourceId = b.sourceId)).positionSeconds, 0.0)
    }

    @Test fun manualOrderSurvivesSameAndDifferentQueuesWithoutReshufflingAnUnchangedTraversal() {
        val current = session()
        val same = MusicPlaybackOrder.inherit(current.copy(repeatMode = 0, shuffleEntryIds = null), current)
        assertEquals(current.shuffleEntryIds, same.shuffleEntryIds)
        val newQueue = current.copy(tracks = listOf(b, track("playlist-item:c", 3)), currentEntryId = b.id,
            currentSourceId = b.sourceId, repeatMode = 0, shuffleEntryIds = null)
        val shuffled = MusicPlaybackOrder.inherit(newQueue, current)
        assertEquals(2, shuffled.repeatMode)
        assertEquals(newQueue.tracks.map { it.id }.toSet(), shuffled.shuffleEntryIds!!.toSet())
        assertEquals(b.id, shuffled.shuffleEntryIds.first())
        for (repeat in listOf(0, 1)) {
            val inherited = MusicPlaybackOrder.inherit(newQueue, current.copy(repeatMode = repeat, shuffleEntryIds = null))
            assertEquals(repeat, inherited.repeatMode); assertNull(inherited.shuffleEntryIds)
        }
    }

    private fun plan(order: String, mode: String = "music", restricted: Boolean = false,
        pending: Boolean = false, current: String? = "entry", expected: String = "entry") =
        MusicPlaybackOrder.plan(order, mode, restricted, pending, current, expected)

    @Test fun threeModesSetBothNativeFlags() {
        assertEquals(MusicPlaybackOrder(0, false), plan("sequential"))
        assertEquals(MusicPlaybackOrder(1, false), plan("repeat-one"))
        assertEquals(MusicPlaybackOrder(2, true), plan("shuffle"))
    }

    @Test fun staleOrRestrictedPlaybackCannotChangeOrder() {
        for (action in listOf(
            { plan("unknown") }, { plan("shuffle", mode = "listening") },
            { plan("shuffle", restricted = true) }, { plan("shuffle", pending = true) },
            { plan("shuffle", current = "other") }, { plan("shuffle", current = null) },
            { plan("shuffle", current = "", expected = "") },
        )) assertThrows(IllegalArgumentException::class.java) { action() }
    }
}
