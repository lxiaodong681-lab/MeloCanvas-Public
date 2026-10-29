package expo.modules.orpheus.util

import org.junit.Assert.*
import org.junit.Test

class ListeningSleepTimerStateTest {
    private val first = "bilibili:BV1234567890:11"
    private val second = "bilibili:BV1234567890:22"
    private val other = "bilibili:BVabcdefghij:33"

    @Test fun supportedDurationsUseElapsedDeadline() {
        for (duration in listOf(900_000L, 1_800_000L, 3_600_000L)) {
            val timer = ListeningSleepTimerState()
            timer.set(first, "duration", duration, 100)
            assertEquals(duration - 500, timer.snapshot(600)?.remainingMs)
            assertFalse(timer.consumeElapsed(100 + duration - 1))
            assertTrue(timer.consumeElapsed(100 + duration))
            assertNull(timer.snapshot(100 + duration))
            assertFalse(timer.consumeElapsed(Long.MAX_VALUE))
        }
    }

    @Test fun replacingDurationRetiresOldDeadline() {
        val timer = ListeningSleepTimerState()
        timer.set(first, "duration", 900_000, 0)
        timer.set(first, "duration", 3_600_000, 100)
        assertFalse(timer.consumeElapsed(900_000))
        assertEquals(2_700_100L, timer.snapshot(900_000)?.remainingMs)
    }

    @Test fun sameBvPartChangeKeepsExactDeadline() {
        val timer = ListeningSleepTimerState()
        timer.set(first, "duration", 900_000, 0)
        assertFalse(timer.reconcileSource(second))
        assertEquals(500_000L, timer.snapshot(400_000)?.remainingMs)
        assertTrue(timer.consumeElapsed(900_000))
    }

    @Test fun currentPartChoiceFollowsNewPartWithinSameBv() {
        val timer = ListeningSleepTimerState()
        timer.set(first, "part", null, 0)
        assertFalse(timer.reconcileSource(second))
        assertFalse(timer.consumeElapsed(Long.MAX_VALUE))
        assertEquals("part", timer.snapshot(12)?.mode)
        assertNull(timer.snapshot(12)?.remainingMs)
        assertTrue(timer.consumePartEnd())
        assertFalse(timer.consumePartEnd())
        assertNull(timer.snapshot(12))
    }

    @Test fun differentBvClearsInsteadOfPausingNewContent() {
        for (mode in listOf("part", "duration")) {
            val timer = ListeningSleepTimerState()
            timer.set(first, mode, if (mode == "duration") 900_000 else null, 0)
            assertTrue(timer.reconcileSource(other))
            assertFalse(timer.consumePartEnd())
            assertFalse(timer.consumeElapsed(Long.MAX_VALUE))
        }
    }

    @Test fun clearingQueueClearsBoundTimer() {
        val timer = ListeningSleepTimerState()
        timer.set(first, "part", null, 0)
        assertTrue(timer.reconcileSource(null))
        assertNull(timer.snapshot(0))
    }

    @Test fun offCancelsBothChoicesAndIsIdempotent() {
        for (mode in listOf("part", "duration")) {
            val timer = ListeningSleepTimerState()
            timer.set(first, mode, if (mode == "duration") 900_000 else null, 0)
            timer.set(first, "off", null, 1)
            assertNull(timer.snapshot(1))
            assertFalse(timer.clear())
            assertFalse(timer.consumePartEnd())
            assertFalse(timer.consumeElapsed(Long.MAX_VALUE))
        }
    }

    @Test fun minutesDoNotConsumeAtPartEnd() {
        val timer = ListeningSleepTimerState()
        timer.set(first, "duration", 900_000, 0)
        assertFalse(timer.consumePartEnd())
        assertNotNull(timer.snapshot(1))
    }

    @Test fun switchingModeRetiresPreviousStopCondition() {
        val timer = ListeningSleepTimerState()
        timer.set(first, "duration", 900_000, 0)
        timer.set(first, "part", null, 10)
        assertFalse(timer.consumeElapsed(Long.MAX_VALUE))
        timer.set(first, "duration", 900_000, 20)
        assertFalse(timer.consumePartEnd())
        assertEquals(900_000L, timer.snapshot(20)?.remainingMs)
    }

    @Test fun invalidInputsDoNotReplaceAnExistingTimer() {
        val timer = ListeningSleepTimerState()
        timer.set(first, "part", null, 0)
        for ((source, mode, duration) in listOf(
            Triple(first, "duration", 10_000L), Triple(first, "duration", -1L),
            Triple(first, "part", 900_000L), Triple(first, "off", 1L),
            Triple(first, "unknown", null), Triple("playlist-item:fake", "part", null),
            Triple("bilibili:BV1234567890:0", "part", null),
        )) {
            assertThrows(IllegalArgumentException::class.java) { timer.set(source, mode, duration, 0) }
            assertEquals("part", timer.snapshot(0)?.mode)
        }
    }

    @Test fun restartedProcessHasNoTimerToRestore() {
        val timer = ListeningSleepTimerState()
        assertNull(timer.snapshot(0))
        assertFalse(timer.consumeElapsed(Long.MAX_VALUE))
        assertFalse(timer.consumePartEnd())
    }
    @Test fun leavingListeningClearsSameBvTimerAndDoesNotRestoreIt() {
        for (mode in listOf("part", "duration")) {
            val timer = ListeningSleepTimerState()
            timer.set(first, mode, if (mode == "duration") 900_000 else null, 0)
            assertFalse(timer.reconcilePlayback("listening", second))
            // FM uses the music playback mode too; ownership is the listening session.
            assertTrue(timer.reconcilePlayback("music", second))
            assertFalse(timer.reconcilePlayback("listening", first))
            assertNull(timer.snapshot(10))
            assertFalse(timer.consumePartEnd())
            assertFalse(timer.consumeElapsed(Long.MAX_VALUE))
        }
    }

}
