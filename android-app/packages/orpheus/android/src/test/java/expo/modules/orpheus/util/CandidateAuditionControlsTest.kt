package expo.modules.orpheus.util

import androidx.media3.common.Player
import org.junit.Assert.*
import org.junit.Test

class CandidateAuditionControlsTest {
    @Test fun rejectsQueueAndPlaybackModeChangesButAllowsCandidateTransport() {
        for (command in listOf(Player.COMMAND_SET_MEDIA_ITEM, Player.COMMAND_CHANGE_MEDIA_ITEMS, Player.COMMAND_RELEASE,
            Player.COMMAND_SET_REPEAT_MODE, Player.COMMAND_SET_SHUFFLE_MODE))
            assertTrue(CandidateAuditionControls.blocks(command))
        for (command in listOf(Player.COMMAND_PLAY_PAUSE, Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM,
            Player.COMMAND_SEEK_BACK, Player.COMMAND_SEEK_FORWARD, Player.COMMAND_STOP))
            assertFalse(CandidateAuditionControls.blocks(command))
    }
}
