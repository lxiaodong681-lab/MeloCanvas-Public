package expo.modules.orpheus.widget

/** Button availability from a validated saved queue; this never starts playback. */
internal data class WidgetQueueNavigation(val hasPrevious: Boolean, val hasNext: Boolean) {
    companion object {
        fun fromSaved(
            entryIds: List<String>,
            currentEntryId: String?,
            repeatMode: Int,
            shuffleEntryIds: List<String>?,
        ): WidgetQueueNavigation {
            if (currentEntryId == null || currentEntryId !in entryIds) return WidgetQueueNavigation(false, false)
            val order = shuffleEntryIds ?: entryIds
            val index = order.indexOf(currentEntryId)
            if (index < 0) return WidgetQueueNavigation(false, false)
            // Media3 repeat ONE/ALL are 1/2. Manual skip retains the service's
            // repeat-one wrap behavior; OFF follows the saved traversal order.
            val wraps = repeatMode == 1 || repeatMode == 2
            return WidgetQueueNavigation(wraps || index > 0, wraps || index < order.lastIndex)
        }
    }
}
