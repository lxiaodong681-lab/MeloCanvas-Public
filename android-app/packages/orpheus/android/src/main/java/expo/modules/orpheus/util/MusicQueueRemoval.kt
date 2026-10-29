package expo.modules.orpheus.util

/** One in-memory undo receipt. Every observed queue mutation retires earlier receipts. */
class MusicQueueRemoval<T> {
    data class Receipt<T>(val token: String, val title: String, val payload: T,
        val index: Int, val currentEntryId: String, val afterIds: List<String>, val revision: Long)
    private var revision = 0L
    private var receipt: Receipt<T>? = null

    fun queueChanged() {
        revision++
        receipt = null
    }

    fun remember(token: String, title: String, payload: T, index: Int,
        currentEntryId: String, afterIds: List<String>) {
        require(token.isNotEmpty() && index in 0..afterIds.size && currentEntryId in afterIds)
        receipt = Receipt(token, title, payload, index, currentEntryId, afterIds.toList(), revision)
    }

    fun observe(mode: String, hasFm: Boolean, shuffle: Boolean, currentEntryId: String?, ids: List<String>) {
        val saved = receipt ?: return
        if (mode != "music" || hasFm || shuffle || saved.currentEntryId != currentEntryId ||
            saved.afterIds != ids || saved.revision != revision) queueChanged()
    }

    fun snapshot(): Map<String, Any>? = receipt?.let { mapOf("token" to it.token, "title" to it.title) }

    fun requireUndo(token: String, mode: String, hasFm: Boolean, pending: Boolean,
        shuffle: Boolean, unreadable: Boolean, currentEntryId: String?, ids: List<String>): Receipt<T> {
        observe(mode, hasFm, shuffle, currentEntryId, ids)
        check(!pending && !unreadable) { "Playback preparation is pending or session storage is unreadable" }
        return checkNotNull(receipt?.takeIf { it.token == token && it.revision == revision }) {
            "This queue removal can no longer be undone"
        }
    }
}
