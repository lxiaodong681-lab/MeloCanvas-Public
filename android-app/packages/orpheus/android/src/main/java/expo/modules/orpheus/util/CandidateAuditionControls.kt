package expo.modules.orpheus.util

import androidx.media3.common.Player

/** Transport controls may affect the candidate, but no controller may change its queue. */
object CandidateAuditionControls {
    fun blocks(command: Int): Boolean = when (command) {
        Player.COMMAND_SET_MEDIA_ITEM,
        Player.COMMAND_CHANGE_MEDIA_ITEMS,
        Player.COMMAND_RELEASE,
        Player.COMMAND_SET_REPEAT_MODE,
        Player.COMMAND_SET_SHUFFLE_MODE -> true
        else -> false
    }
}
