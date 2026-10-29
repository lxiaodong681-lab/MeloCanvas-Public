package expo.modules.orpheus.util

import java.io.IOException

/** Pure rules shared by actual Media3 adapters and synthetic fixtures. */
object OfflineIntegrity {
    const val DEFAULT_STORAGE_LIMIT = 1024L * 1024 * 1024
    /** Missing settings (new install or upgrade) inherit the default; explicit values win. */
    fun storageLimit(stored: Long?): Long = stored ?: DEFAULT_STORAGE_LIMIT
    fun complete(metadataLength: Long, recordedLength: Long, covers: (Long, Long) -> Boolean): Boolean =
        metadataLength > 0 && recordedLength == metadataLength && covers(0, metadataLength)
    fun reserve(length: Long, used: Long, cap: Long, free: Long, reserve: Long) {
        if (length <= 0) throw IOException("音源未提供完整长度，无法安全离线保存")
        if (cap <= 0 || used < 0 || length > cap - used) throw IOException("离线容量不足，请手动清理或提高上限")
        if (length > free - reserve) throw IOException("设备存储不足，请释放空间后重试")
    }
}
class OfflineTransferLength(length: Long) {
    var remaining = length
        private set
    init { require(length > 0) }
    fun read(count: Int) {
        if (count == -1) {
            if (remaining != 0L) throw IOException("音源提前结束，离线文件不完整")
        } else {
            require(count >= 0)
            remaining -= count
            if (remaining < 0) throw IOException("音源长度变化，离线文件未通过验证")
        }
    }
}

/** A route wrapper owns exactly one online source; open/retry is not a new user request. */
class OfflineUpstreamOwner<T>(create: () -> T) {
    val source: T = create()
}
