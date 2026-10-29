package expo.modules.orpheus.util

import androidx.media3.common.Player
import org.junit.Assert.*
import org.junit.Test

class PlaybackControlCommandsTest {
    @Test fun transportAndQueueCommandsRejectOldPreparationAndAllowANewRequest() {
        val commands = listOf(
            Player.COMMAND_PLAY_PAUSE, Player.COMMAND_PREPARE, Player.COMMAND_STOP,
            Player.COMMAND_SEEK_TO_DEFAULT_POSITION, Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM,
            Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM, Player.COMMAND_SEEK_TO_PREVIOUS,
            Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM, Player.COMMAND_SEEK_TO_NEXT,
            Player.COMMAND_SEEK_TO_MEDIA_ITEM, Player.COMMAND_SEEK_BACK, Player.COMMAND_SEEK_FORWARD,
            Player.COMMAND_SET_SPEED_AND_PITCH, Player.COMMAND_SET_SHUFFLE_MODE,
            Player.COMMAND_SET_REPEAT_MODE, Player.COMMAND_SET_MEDIA_ITEM,
            Player.COMMAND_CHANGE_MEDIA_ITEMS, Player.COMMAND_RELEASE,
        )
        for (command in commands) {
            val guard = PlaybackReplacementGuard()
            val old = guard.begin()
            var cancelled = false
            guard.register(old) { cancelled = true }
            assertTrue("transport command $command", PlaybackControlCommands.invalidatesReplacement(command))
            if (PlaybackControlCommands.invalidatesReplacement(command)) guard.cancel()
            assertTrue(cancelled)
            assertNull(guard.commit(old) { error("old preparation committed after $command") })
            assertEquals("new", guard.commit(guard.begin()) { "new" })
        }
    }

    @Test fun observationAndUnrelatedCommandsDoNotCancelPreparation() {
        val guard = PlaybackReplacementGuard()
        val token = guard.begin()
        for (command in listOf(
            Player.COMMAND_GET_CURRENT_MEDIA_ITEM, Player.COMMAND_GET_TIMELINE,
            Player.COMMAND_GET_METADATA, Player.COMMAND_GET_AUDIO_ATTRIBUTES,
            Player.COMMAND_GET_VOLUME, Player.COMMAND_GET_DEVICE_VOLUME,
            Player.COMMAND_GET_TEXT, Player.COMMAND_GET_TRACKS,
            Player.COMMAND_SET_PLAYLIST_METADATA, Player.COMMAND_SET_VOLUME,
            Player.COMMAND_INVALID,
        )) {
            assertFalse("non-transport command $command", PlaybackControlCommands.invalidatesReplacement(command))
        }
        assertTrue(guard.isCurrent(token))
        assertEquals("committed", guard.commit(token) { "committed" })
        assertTrue(guard.isCurrent(token))
    }
}
