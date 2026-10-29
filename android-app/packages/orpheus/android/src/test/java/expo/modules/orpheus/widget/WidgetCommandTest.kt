package expo.modules.orpheus.widget

import expo.modules.orpheus.util.PlaybackReplacementGuard
import org.junit.Assert.*
import org.junit.Test

class WidgetCommandTest {
    private fun frame(stamp: String = WidgetStamp.create(), entry: String = "playlist-item:a1", mode: String = "music") =
        WidgetPlaybackFrame(mode, entry, stamp, "A", "真实上传者", 25000, 100000, false)
    private fun command(frame: WidgetPlaybackFrame, action: String = "play") = WidgetCommand(12, action, frame.mode, frame.entryId!!, frame.stamp!!)

    @Test fun aToBToARejectsTheOldVisitWithoutCancellingTheNewPreparation() {
        val first = frame()
        val oldButton = command(first)
        val second = frame(entry = "playlist-item:b")
        val last = frame(entry = first.entryId!!)
        assertFalse(oldButton.matches(second))
        assertFalse(oldButton.matches(last))
        val guard = PlaybackReplacementGuard()
        val preparing = guard.begin()
        assertFalse(oldButton.execute(last, { error("stale stamp consumed") }, { guard.cancel() }, { error("stale transport") }))
        assertTrue(guard.isCurrent(preparing))
        assertTrue(command(last).execute(last, {}, { guard.cancel() }, {}))
        assertFalse(guard.isCurrent(preparing))
    }

    @Test fun duplicateSourceOccurrenceAndOtherModeNeverAlias() {
        val first = frame()
        assertFalse(command(first).matches(first.copy(entryId = "playlist-item:a2")))
        assertFalse(command(first).matches(first.copy(mode = "listening")))
        assertFalse(command(first, "forward15").matches(first))
        assertFalse(command(first).copy(widgetId = -1).matches(first))
        assertFalse(command(first).matches(first.copy(stamp = null)))
    }

    @Test fun legacyColdContentRemainsVisibleButRequiresAppRecoveryBeforeControlsAreAuthorized() {
        val legacy = frame().copy(stamp = null)
        assertEquals("A", legacy.title)
        assertEquals(25000L, legacy.positionMs)
        assertFalse(legacy.playing)
        assertFalse(legacy.controlsAvailable)
        val recovered = legacy.copy(stamp = WidgetStamp.restored(null))
        assertTrue(recovered.controlsAvailable)
        assertEquals(legacy.entryId, recovered.entryId)
        assertEquals(legacy.positionMs, recovered.positionMs)
    }

    @Test fun failedConsumptionNeverCancelsPreparationOrPlaysAndCanBeRetried() {
        val old = frame()
        val button = command(old)
        val guard = PlaybackReplacementGuard()
        val token = guard.begin()
        var played = false
        var persisted = old
        assertTrue(runCatching {
            button.execute(old, { error("disk full") }, { guard.cancel() }, { played = true })
        }.isFailure)
        assertEquals(old, persisted)
        assertTrue(guard.isCurrent(token))
        assertFalse(played)
        assertTrue(button.execute(old, { persisted = old.copy(stamp = WidgetStamp.create()) }, { guard.cancel() }, { played = true }))
        assertTrue(played)
        assertFalse(guard.isCurrent(token))
        assertFalse(button.execute(persisted, { error("replayed") }, { error("replayed") }, { error("replayed") }))
    }

    @Test fun successfulConsumptionBeforeACrashDoesNotAuthorizeTheOldPlayAgain() {
        val old = frame()
        val button = command(old)
        var persisted = old
        assertTrue(runCatching {
            button.execute(old, { persisted = old.copy(stamp = WidgetStamp.create()) }, {}, { error("process ended before play") })
        }.isFailure)
        assertFalse(persisted.playing)
        assertFalse(button.matches(persisted))
        assertTrue(command(persisted).matches(persisted))
    }

    @Test fun pauseAndSeekKeepTheSameVisitAndDoNotConsumeAPlayReceipt() {
        for ((mode, action) in listOf("music" to "pause", "listening" to "back15", "listening" to "forward15")) {
            val frame = frame(mode = mode)
            var controlled = false
            assertTrue(command(frame, action).execute(frame, { error("non-play must not change stamp") }, {}, { controlled = true }))
            assertTrue(controlled)
            assertTrue(command(frame, action).matches(frame))
        }
    }

    @Test fun listeningSeekClampsAndCannotOverflow() {
        assertEquals(0L, WidgetCommand.seekPosition(1000, 100000, false))
        assertEquals(100000L, WidgetCommand.seekPosition(99000, 100000, true))
        assertEquals(40000L, WidgetCommand.seekPosition(25000, 100000, true))
        assertEquals(Long.MAX_VALUE, WidgetCommand.seekPosition(Long.MAX_VALUE, 0, true))
        assertEquals(15000L, WidgetCommand.seekPosition(-1, 0, true))
    }

    @Test fun cleanupDoesNotStopWarmOrNowPlayingWork() {
        assertTrue(WidgetCommand.shouldStopStartedWork(true, false, false))
        assertFalse(WidgetCommand.shouldStopStartedWork(true, true, false))
        assertFalse(WidgetCommand.shouldStopStartedWork(true, false, true))
        assertFalse(WidgetCommand.shouldStopStartedWork(false, false, false))
    }
}
