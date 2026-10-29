package expo.modules.orpheus.util

import android.content.Context
import com.tencent.mmkv.MMKV

/** Shared by the service and bridge, including while JavaScript is suspended. */
object RecentMusicHistoryStorage {
    private var kv: MMKV? = null
    private var writeFailure: Exception? = null
    private const val KEY = "recent_music"

    @Synchronized
    fun initialize(context: Context) {
        if (kv == null) {
            MMKV.initialize(context)
            kv = MMKV.mmkvWithID("melocanvas_recent_music_v1")
            check(kv != null) { "最近播放存储不可用。" }
        }
    }

    private fun persistence(): RecentMusicHistoryPersistence {
        val storage = checkNotNull(kv) { "最近播放存储尚未就绪。" }
        return RecentMusicHistoryPersistence({
            val raw = storage.decodeString(KEY)
            check(raw != null || !storage.containsKey(KEY)) { "最近播放记录不可读取，原记录已保留。" }
            raw
        }, { storage.encode(KEY, it) })
    }

    @Synchronized
    fun read(): List<RecentMusicHistoryEntry> {
        writeFailure?.let { throw IllegalStateException("最近播放记录保存失败，请稍后重试。", it) }
        return persistence().read()
    }

    @Synchronized
    fun clear() {
        persistence().clear()
        writeFailure = null
    }

    @Synchronized
    fun record(entry: RecentMusicHistoryEntry) {
        try {
            persistence().record(entry)
            writeFailure = null
        } catch (error: Exception) {
            writeFailure = error
            throw error
        }
    }
}
