package expo.modules.orpheus.util

import expo.modules.orpheus.model.TrackRecord

data class MusicPlaybackOrder(val repeatMode: Int, val shuffle: Boolean) {
    companion object {
        /** Manual music order is a durable preference, even when a different list is selected. */
        fun inherit(target: PlaybackSessionSnapshot, previous: PlaybackSessionSnapshot?): PlaybackSessionSnapshot {
            if (target.mode != "music" || previous == null) return target
            val ids = target.tracks.map { it.id }
            val oldOrder = previous.shuffleEntryIds
            val order = if (oldOrder == null) null
                else if (oldOrder.toSet() == ids.toSet()) oldOrder
                else listOfNotNull(target.currentEntryId) + ids.filter { it != target.currentEntryId }.shuffled()
            return target.copy(repeatMode = previous.repeatMode, shuffleEntryIds = order)
        }

        /** Same occurrence and playable URI; another copy of the same song is a distinct selection. */
        fun canResume(current: PlaybackSessionSnapshot, tracks: List<TrackRecord>, entryId: String): Boolean =
            current.mode == "music" && current.currentEntryId == entryId &&
                current.tracks.size == tracks.size && current.tracks.zip(tracks).all { (a, b) ->
                    a.id == b.id && (a.sourceId ?: a.id) == (b.sourceId ?: b.id) && a.url == b.url
                }

        fun retainCurrentPosition(current: PlaybackSessionSnapshot, target: PlaybackSessionSnapshot): PlaybackSessionSnapshot {
            if (current.mode != "music" || target.mode != "music" || current.currentEntryId != target.currentEntryId) return target
            val before = current.tracks.firstOrNull { it.id == current.currentEntryId } ?: return target
            val after = target.tracks.firstOrNull { it.id == target.currentEntryId } ?: return target
            return if ((before.sourceId ?: before.id) == (after.sourceId ?: after.id) && before.url == after.url)
                target.copy(positionSeconds = current.positionSeconds) else target
        }

        fun plan(order: String, mode: String, restricted: Boolean, pending: Boolean,
            currentEntryId: String?, expectedEntryId: String): MusicPlaybackOrder {
            require(mode == "music" && !restricted && !pending) { "当前不能切换音乐播放模式" }
            require(expectedEntryId.isNotBlank() && currentEntryId == expectedEntryId) { "当前歌曲已变化，请重试" }
            return when (order) {
                "sequential" -> MusicPlaybackOrder(0, false)
                "repeat-one" -> MusicPlaybackOrder(1, false)
                "shuffle" -> MusicPlaybackOrder(2, true)
                else -> throw IllegalArgumentException("未知播放模式")
            }
        }
    }
}
