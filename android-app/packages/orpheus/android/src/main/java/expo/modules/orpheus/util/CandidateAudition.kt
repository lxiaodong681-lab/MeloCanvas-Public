package expo.modules.orpheus.util

import expo.modules.orpheus.model.TrackRecord
import expo.modules.orpheus.widget.WidgetStamp

/** The durable value is always the original session, never the audition. */
object CandidateAudition {
    fun returnState(original: StoredPlaybackSessions): StoredPlaybackSessions = original.copy(
        active = original.active.copy(playing = false, playWhenReady = false),
        widgetStamp = WidgetStamp.create(),
    )

    fun temporary(track: TrackRecord): StoredPlaybackSessions {
        require(PlaybackSourceIdentity.isValid(track.sourceId ?: track.id, track.url)) { "Invalid candidate source" }
        val session = PlaybackSessionSnapshot(
            tracks = listOf(track), currentEntryId = track.id,
            currentSourceId = track.sourceId ?: track.id,
            durationSeconds = track.duration ?: 0.0,
            playing = true, playWhenReady = true,
            updatedAt = System.currentTimeMillis(),
        )
        require(PlaybackSessionCodec.validSession(session)) { "Invalid candidate session" }
        return StoredPlaybackSessions(session, widgetStamp = WidgetStamp.create())
    }
}

/** All methods run on Main. Keep ownership after a failed restore so the user can retry. */
class CandidateAuditionSession {
    var original: StoredPlaybackSessions? = null
        private set
    var id: String? = null
        private set
    private var token: Long? = null

    fun start(track: TrackRecord, preparation: Long, capture: () -> StoredPlaybackSessions,
        persist: (StoredPlaybackSessions) -> Unit, apply: (StoredPlaybackSessions) -> Unit) {
        val temporary = CandidateAudition.temporary(track)
        val saved = original ?: CandidateAudition.returnState(capture())
        if (original == null) persist(saved) // No live mutation until durable original is secured.
        original = saved
        id = WidgetStamp.create()
        token = preparation
        try {
            apply(temporary)
        } catch (failure: Exception) {
            runCatching { apply(saved) }.onSuccess { clear() }.onFailure { failure.addSuppressed(it) }
            throw failure
        }
    }

    fun end(expectedId: String, beforeApply: () -> Unit = {}, apply: (StoredPlaybackSessions) -> Unit): Boolean {
        val saved = original ?: return false
        check(id == expectedId) { "候选试听已更换，请重新返回。" }
        beforeApply()
        apply(saved)
        clear()
        return true
    }

    fun ownedBy(preparation: Long): Boolean = token == preparation && original != null
    private fun clear() { original = null; id = null; token = null }
}
