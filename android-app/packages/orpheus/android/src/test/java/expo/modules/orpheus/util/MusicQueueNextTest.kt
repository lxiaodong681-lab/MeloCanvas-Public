package expo.modules.orpheus.util

import org.junit.Assert.*
import org.junit.Test

class MusicQueueNextTest {
    private val queue = listOf("a", "b", "c", "d", "e")
    private fun plan(current: String = "c", target: String = "a", ids: List<String> = queue,
        expected: List<String> = ids, expectedCurrent: String = current, mode: String = "music",
        fm: Boolean = false, pending: Boolean = false, shuffle: Boolean = false) =
        MusicQueueNext.plan(mode, fm, pending, shuffle, current, ids, expectedCurrent, target, expected)

    @Test fun movesEarlierOccurrenceWithRemovalCompensation() {
        assertEquals(MusicQueueNext.Move(0, 2), plan())
        assertEquals(MusicQueueNext.Move(1, 2), plan(target = "b"))
    }
    @Test fun movesLaterOccurrenceAndLeavesImmediateNextUnchanged() {
        assertEquals(MusicQueueNext.Move(4, 3), plan(target = "e"))
        assertNull(plan(target = "d"))
    }
    @Test fun currentLastCanGainANewSuccessor() {
        assertEquals(MusicQueueNext.Move(0, 4), plan(current = "e"))
    }
    @Test fun allPositionsPreserveOtherOccurrenceOrderAndPutTargetImmediatelyNext() {
        for (current in queue) for (target in queue.filter { it != current }) {
            val result = queue.toMutableList()
            plan(current, target)?.let { result.add(it.toIndex, result.removeAt(it.fromIndex)) }
            assertEquals(target, result[result.indexOf(current) + 1])
            assertEquals(queue.filter { it != target }, result.filter { it != target })
        }
    }
    @Test fun unreadableSessionCannotBeMutated() {
        assertThrows(IllegalStateException::class.java) {
            MusicQueueNext.plan("music", false, false, false, "c", queue, "c", "a", queue, true)
        }
    }
    @Test fun rejectsDifferentModeFmShuffleAndPendingWithoutAPlan() {
        for (call in listOf<() -> Unit>(
            { plan(mode = "listening") }, { plan(fm = true) },
            { plan(shuffle = true) }, { plan(pending = true) },
        )) assertThrows(IllegalStateException::class.java, call)
    }
    @Test fun rejectsStaleCurrentAndAnyQueueChangeEvenWhenCurrentSurvives() {
        assertThrows(IllegalStateException::class.java) { plan(expectedCurrent = "b") }
        for (old in listOf(queue.reversed(), queue.dropLast(1), queue + "f", listOf("x", "b", "c", "d", "e"))) {
            assertThrows(IllegalStateException::class.java) { plan(expected = old) }
        }
    }
    @Test fun rejectsMissingCurrentMissingTargetAndCurrentTarget() {
        for (call in listOf<() -> Unit>(
            { plan(current = "missing") }, { plan(target = "missing") }, { plan(target = "c") },
        )) assertThrows(IllegalArgumentException::class.java, call)
    }
    @Test fun rejectsAmbiguousOccurrenceIds() {
        assertThrows(IllegalStateException::class.java) { plan(ids = listOf("a", "c", "a")) }
        assertThrows(IllegalStateException::class.java) { plan(ids = listOf("a", "c", "")) }
    }
    @Test fun repeatedStaleClickCannotMoveAgainAfterFirstReorder() {
        val next = queue.toMutableList()
        val move = requireNotNull(plan())
        next.add(move.toIndex, next.removeAt(move.fromIndex))
        assertThrows(IllegalStateException::class.java) { plan(ids = next, expected = queue) }
        assertNull(plan(ids = next, expected = next))
    }
}
