package expo.modules.orpheus.util

/** Pure occurrence-based move plan for the ordinary sequential music queue. */
object MusicQueueNext {
    data class Move(val fromIndex: Int, val toIndex: Int)

    fun plan(mode: String, hasFm: Boolean, preparationPending: Boolean, shuffleEnabled: Boolean,
        currentEntryId: String?, queueEntryIds: List<String>, expectedCurrentEntryId: String,
        entryId: String, expectedQueueEntryIds: List<String>, sessionUnreadable: Boolean = false): Move? {
        check(mode == "music" && !hasFm && !shuffleEnabled) { "Only the ordinary sequential music queue can be arranged" }
        check(!sessionUnreadable) { "Playback session storage is unreadable" }
        check(!preparationPending) { "Playback preparation is pending" }
        check(currentEntryId != null && currentEntryId == expectedCurrentEntryId &&
            queueEntryIds == expectedQueueEntryIds) { "The music queue changed before this action" }
        check(queueEntryIds.all { it.isNotEmpty() } && queueEntryIds.distinct().size == queueEntryIds.size) { "Ambiguous queue entries" }
        val current = queueEntryIds.indexOf(currentEntryId)
        val from = queueEntryIds.indexOf(entryId)
        require(current >= 0 && from >= 0 && from != current) { "Choose an existing non-current queue entry" }
        // Media3's destination is the final index, after removing the source occurrence.
        val to = if (from < current) current else current + 1
        return if (from == to) null else Move(from, to)
    }
}
