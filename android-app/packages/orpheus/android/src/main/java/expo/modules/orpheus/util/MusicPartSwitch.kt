package expo.modules.orpheus.util

import expo.modules.orpheus.model.TrackRecord
import expo.modules.orpheus.widget.WidgetStamp

/** Main-thread decision over the latest authority, never a JS reconstruction of both queues. */
object MusicPartSwitch {
    fun replace(sessions: StoredPlaybackSessions, target: TrackRecord,
        expectedCurrentEntryId: String, expectedSourceId: String,
        now: Long = System.currentTimeMillis()): StoredPlaybackSessions {
        require(PlaybackSessionCodec.validStored(sessions)) { "Invalid native playback state" }
        val active = sessions.active
        require(active.mode == "music") { "请在音乐模式下切换分 P。" }
        require(sessions.fm == null) { "请先退出 FM，再切换分 P。" }
        require(active.currentEntryId == expectedCurrentEntryId && active.currentSourceId == expectedSourceId) {
            "当前播放条目已变化，请重新选择分 P。"
        }
        val index = active.tracks.indexOfFirst { it.id == expectedCurrentEntryId }
        require(index >= 0 && (active.tracks[index].sourceId ?: active.tracks[index].id) == expectedSourceId) {
            "当前播放条目已变化，请重新选择分 P。"
        }
        val targetSource = requireNotNull(target.sourceId) { "分 P 音源身份无效。" }
        require(target.id == expectedCurrentEntryId &&
            PlaybackSourceIdentity.isValidEntry(target.id, targetSource, target.url, "music") &&
            PlaybackSourceIdentity.sameBilibiliVideo(expectedSourceId, targetSource)) {
            "只能切换当前视频的同一 BV 分 P。"
        }
        if (targetSource == expectedSourceId) return sessions
        val offline = active.tracks[index].url.substringAfter('?', "").split('&').contains("meloOffline=1")
        require(!offline || target.url.substringAfter('?', "").split('&').contains("meloOffline=1")) {
            "离线播放分 P 必须保留完整下载限制。"
        }
        val tracks = active.tracks.toMutableList().apply { this[index] = target }.toList()
        return sessions.copy(active = active.copy(tracks = tracks, currentSourceId = targetSource,
            positionSeconds = 0.0, durationSeconds = target.duration ?: 0.0, updatedAt = now),
            widgetStamp = WidgetStamp.create()).also {
            require(PlaybackSessionCodec.validStored(it)) { "Invalid native playback state" }
        }
    }
}
