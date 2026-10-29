package expo.modules.orpheus.util

import expo.modules.orpheus.model.TrackRecord
import expo.modules.orpheus.widget.WidgetStamp

/** Pure decisions over the one native session record; the service commits them on Main. */
object FmPlaybackSessions {
    fun music(sessions: StoredPlaybackSessions): PlaybackSessionSnapshot? =
        if (sessions.active.mode == "music") sessions.active else sessions.inactive?.takeIf { it.mode == "music" }

    fun validateTracks(tracks: List<TrackRecord>, maximum: Int = 5000) {
        require(tracks.isNotEmpty() && tracks.size <= maximum &&
            tracks.all { PlaybackSourceIdentity.isValidEntry(it.id, it.sourceId, it.url, "music") } &&
            tracks.all { PlaybackSourceIdentity.isValid(it.sourceId ?: it.id, it.url) } &&
            tracks.map { it.id }.distinct().size == tracks.size &&
            tracks.map { it.sourceId ?: it.id }.distinct().size == tracks.size) { "Invalid FM tracks" }
    }

    fun start(sessions: StoredPlaybackSessions, tracks: List<TrackRecord>): StoredPlaybackSessions {
        require(sessions.fm == null) { "FM already active; exit the existing context first" }
        validateTracks(tracks)
        val first = tracks.first()
        val target = PlaybackSessionSnapshot(tracks = tracks.toList(), currentEntryId = first.id,
            currentSourceId = first.sourceId ?: first.id, durationSeconds = first.duration ?: 0.0,
            playing = true, playWhenReady = true, updatedAt = System.currentTimeMillis())
        return sessions.copy(active = target,
            inactive = if (sessions.active.mode == "listening") sessions.active else sessions.inactive,
            widgetStamp = WidgetStamp.create(), fm = FmPlaybackContext(WidgetStamp.create(), sessions.active.mode,
                music(sessions), sessions.active.takeIf { it.mode == "listening" }))
    }

    fun replace(sessions: StoredPlaybackSessions, target: PlaybackSessionSnapshot, fmId: String?): StoredPlaybackSessions {
        val keepFm = target.mode == "listening" || fmId != null
        if (target.mode == "music" && fmId != null) {
            require(sessions.fm?.id == fmId) { "FM context has expired" }
            val original = requireNotNull(music(sessions))
            require(sameTracks(original.tracks, target.tracks) && target.repeatMode == 0 &&
                target.shuffleEntryIds == null) { "FM selection must retain its exact queue" }
        }
        val manual = if (sessions.fm != null) sessions.fm.manualMusic else music(sessions)
        val selected = if (target.mode == "music" && fmId == null) MusicPlaybackOrder.inherit(target, manual) else target
        return sessions.copy(active = selected,
            inactive = if (sessions.active.mode != target.mode) sessions.active else sessions.inactive,
            widgetStamp = WidgetStamp.create(), fm = sessions.fm.takeIf { keepFm })
    }

    fun returnTarget(sessions: StoredPlaybackSessions, fmId: String): PlaybackSessionSnapshot {
        val fm = requireNotNull(sessions.fm?.takeIf { it.id == fmId }) { "FM context has expired" }
        val target = if (fm.returnMode == "listening") requireNotNull(fm.returnListening)
            else fm.manualMusic ?: PlaybackSessionSnapshot()
        return if (target.tracks.isEmpty()) target.copy(playing = false, playWhenReady = false) else target
    }

    fun exit(sessions: StoredPlaybackSessions, fmId: String): StoredPlaybackSessions {
        val fm = requireNotNull(sessions.fm?.takeIf { it.id == fmId }) { "FM context has expired" }
        val target = returnTarget(sessions, fmId)
        return sessions.copy(active = target,
            inactive = if (fm.returnMode == "listening") fm.manualMusic
                else sessions.active.takeIf { it.mode == "listening" } ?: sessions.inactive?.takeIf { it.mode == "listening" },
            fm = null, widgetStamp = WidgetStamp.create())
    }

    /** null is a CAS conflict; validation failures are explicit and never partially append. */
    fun append(sessions: StoredPlaybackSessions, tracks: List<TrackRecord>, fmId: String,
        expectedTailEntryId: String): StoredPlaybackSessions? {
        validateTracks(tracks, 50)
        if (sessions.fm?.id != fmId) return null
        val music = music(sessions) ?: return null
        if (music.tracks.lastOrNull()?.id != expectedTailEntryId) return null
        val nextTracks = music.tracks + tracks
        validateTracks(nextTracks)
        val nextMusic = music.copy(tracks = nextTracks, updatedAt = System.currentTimeMillis())
        return if (sessions.active.mode == "music") sessions.copy(active = nextMusic)
            else sessions.copy(inactive = nextMusic)
    }

    private fun sameTracks(left: List<TrackRecord>, right: List<TrackRecord>): Boolean =
        left.size == right.size && left.zip(right).all { (a, b) ->
            a.id == b.id && a.sourceId == b.sourceId && a.url == b.url && a.title == b.title &&
                a.artist == b.artist && a.artwork == b.artwork && a.duration == b.duration
        }
}
