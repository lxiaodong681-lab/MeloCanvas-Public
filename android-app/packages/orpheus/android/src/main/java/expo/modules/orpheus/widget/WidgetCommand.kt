package expo.modules.orpheus.widget

data class WidgetPlaybackFrame(
    val mode: String,
    val entryId: String?,
    val stamp: String?,
    val title: String,
    val subtitle: String,
    val positionMs: Long,
    val durationMs: Long,
    val playing: Boolean,
    val artwork: String? = null,
    val hasPrevious: Boolean = false,
    val hasNext: Boolean = false,
) {
    val controlsAvailable: Boolean get() = !entryId.isNullOrBlank() && WidgetStamp.valid(stamp)
}

data class WidgetCommand(val widgetId: Int, val action: String, val mode: String, val entryId: String, val stamp: String) {
    fun matches(frame: WidgetPlaybackFrame): Boolean =
        widgetId > 0 && action in actions && mode in setOf("music", "listening") &&
            entryId.isNotBlank() && entryId == frame.entryId && mode == frame.mode && stamp == frame.stamp &&
            stampPattern.matches(stamp) && when (action) {
                "previous", "next" -> mode == "music"
                "back15", "forward15" -> mode == "listening"
                else -> true
            }

    fun execute(frame: WidgetPlaybackFrame, consumePlay: () -> Unit, cancelPreparation: () -> Unit, transport: () -> Unit): Boolean {
        if (!matches(frame)) return false
        if (action == "play") consumePlay()
        cancelPreparation()
        transport()
        return true
    }

    companion object {
        val actions = setOf("play", "pause", "previous", "next", "back15", "forward15")
        val stampPattern = Regex("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")
        fun shouldStopStartedWork(firstStart: Boolean, wasPlaying: Boolean, nowPlaying: Boolean): Boolean =
            firstStart && !wasPlaying && !nowPlaying
        fun seekPosition(positionMs: Long, durationMs: Long, forward: Boolean): Long {
            val position = positionMs.coerceAtLeast(0)
            val shifted = if (forward) position.coerceAtMost(Long.MAX_VALUE - 15000) + 15000 else (position - 15000).coerceAtLeast(0)
            return if (durationMs > 0) shifted.coerceAtMost(durationMs) else shifted
        }
    }
}
