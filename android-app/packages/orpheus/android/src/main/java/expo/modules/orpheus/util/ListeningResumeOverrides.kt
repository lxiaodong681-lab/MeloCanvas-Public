package expo.modules.orpheus.util

import expo.modules.orpheus.model.TrackRecord

/** Per-new-session restored positions. Never a mutation of the running queue during restore. */
object ListeningResumeOverrides {
    fun validBlocked(mode: String, tracks: List<TrackRecord>, blocked: Set<String>): Boolean =
        blocked.isEmpty() || (mode == "listening" && blocked.all { source -> tracks.any { (it.sourceId ?: it.id) == source } })

    fun isBlocked(sourceId: String, active: Set<String>, inactive: PlaybackSessionSnapshot?, fm: FmPlaybackContext?): Boolean =
        sourceId in active || sourceId in (inactive?.listeningResumeBlocked ?: emptySet()) ||
            sourceId in (fm?.returnListening?.listeningResumeBlocked ?: emptySet())

    fun afterSave(blocked: Set<String>, sourceId: String, saved: Boolean): Set<String> =
        if (saved) blocked - sourceId else blocked

    fun valid(mode: String, tracks: List<TrackRecord>, points: Map<String, Double>): Boolean {
        if (points.isEmpty()) return true
        if (mode != "listening" || points.size > tracks.size) return false
        return points.all { (sourceId, position) ->
            val track = tracks.firstOrNull { (it.sourceId ?: it.id) == sourceId }
            track != null && position.isFinite() && position >= 0.0 && position <= Long.MAX_VALUE / 1000.0 &&
                (track.duration == null || track.duration!! <= 0.0 || position <= track.duration!!)
        }
    }
}
