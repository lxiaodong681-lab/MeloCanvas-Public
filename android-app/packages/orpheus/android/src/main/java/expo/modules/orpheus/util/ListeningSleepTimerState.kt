package expo.modules.orpheus.util

/** Volatile listening-session timer. Never persists a deadline across process restart. */
class ListeningSleepTimerState {
    data class Snapshot(val mode: String, val bvid: String, val remainingMs: Long?) {
        fun toMap(): Map<String, Any?> = mapOf("mode" to mode, "bvid" to bvid, "remainingMs" to remainingMs)
    }

    private var mode: String? = null
    private var ownerBvid: String? = null
    private var deadlineElapsedMs: Long? = null

    fun set(sourceId: String, choice: String, durationMs: Long?, elapsedMs: Long) {
        val bvid = bvidOf(sourceId) ?: throw IllegalArgumentException("Invalid listening source")
        require(choice == "off" || choice == "part" || choice == "duration") { "Invalid sleep timer mode" }
        require(if (choice == "duration") durationMs in setOf(900_000L, 1_800_000L, 3_600_000L) else durationMs == null) {
            "Invalid sleep timer duration"
        }
        if (choice == "off") { clear(); return }
        val deadline = if (choice == "duration") Math.addExact(elapsedMs, requireNotNull(durationMs)) else null
        mode = choice
        ownerBvid = bvid
        deadlineElapsedMs = deadline
    }

    fun clear(): Boolean {
        val changed = mode != null
        mode = null
        ownerBvid = null
        deadlineElapsedMs = null
        return changed
    }

    /** A different P in the same BV inherits both the deadline and end-of-current-P choice. */
    fun reconcileSource(sourceId: String?): Boolean =
        if (mode != null && bvidOf(sourceId) != ownerBvid) clear() else false

    /** Listening timers never follow a transition into music or FM, even for the same BV. */
    fun reconcilePlayback(playbackMode: String, sourceId: String?): Boolean =
        if (playbackMode != "listening") clear() else reconcileSource(sourceId)

    fun consumeElapsed(elapsedMs: Long): Boolean =
        if (deadlineElapsedMs?.let { elapsedMs >= it } == true) clear() else false

    fun consumePartEnd(): Boolean = if (mode == "part") clear() else false

    fun snapshot(elapsedMs: Long): Snapshot? {
        val currentMode = mode ?: return null
        return Snapshot(currentMode, requireNotNull(ownerBvid), deadlineElapsedMs?.let { (it - elapsedMs).coerceAtLeast(0) })
    }

    companion object {
        fun bvidOf(sourceId: String?): String? {
            val match = Regex("^bilibili:(BV[A-Za-z0-9]{10}):([1-9][0-9]*)$").matchEntire(sourceId ?: return null) ?: return null
            val cid = match.groupValues[2].toLongOrNull() ?: return null
            return match.groupValues[1].takeIf { cid <= 9_007_199_254_740_991L }
        }
    }
}
