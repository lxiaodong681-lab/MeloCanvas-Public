package expo.modules.orpheus.widget

import java.util.UUID

/** Widget view ownership only; never an alternative to PlaybackReplacementGuard. */
object WidgetStamp {
    fun create(): String = UUID.randomUUID().toString()
    fun valid(stamp: String?): Boolean = stamp != null && WidgetCommand.stampPattern.matches(stamp)
    fun restored(stamp: String?): String = stamp?.takeIf { valid(it) } ?: create()
}
