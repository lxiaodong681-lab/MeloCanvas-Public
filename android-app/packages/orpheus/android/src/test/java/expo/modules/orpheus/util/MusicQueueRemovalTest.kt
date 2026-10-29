package expo.modules.orpheus.util

import org.junit.Assert.*
import org.junit.Test

class MusicQueueRemovalTest {
    private val ids = listOf("local:current", "bilibili:next")
    private fun state(): MusicQueueRemoval<String> = MusicQueueRemoval<String>().apply {
        queueChanged() // The successful removal's playlist event is dispatched before remember.
        remember("receipt", "Removed audio", "native-media-item", 1, "local:current", ids)
    }
    private fun undo(s: MusicQueueRemoval<String>, token: String = "receipt", mode: String = "music",
        fm: Boolean = false, pending: Boolean = false, shuffle: Boolean = false,
        unreadable: Boolean = false, current: String = "local:current", queue: List<String> = ids) =
        s.requireUndo(token, mode, fm, pending, shuffle, unreadable, current, queue)

    @Test fun restoresOnlyNativePayloadAndOriginalIndex() {
        val saved = undo(state())
        assertEquals("native-media-item", saved.payload)
        assertEquals(1, saved.index)
        assertEquals(mapOf("token" to "receipt", "title" to "Removed audio"), state().snapshot())
    }
    @Test fun anyLaterQueueMutationPermanentlyRetiresReceiptEvenIfSequenceReturns() {
        val s = state()
        s.queueChanged() // A -> B
        s.queueChanged() // B -> A
        assertThrows(IllegalStateException::class.java) { undo(s) }
        assertNull(s.snapshot())
    }
    @Test fun currentVisitOrModeChangeCannotResurrectAnOldReceipt() {
        for (change in listOf<(MusicQueueRemoval<String>) -> Unit>(
            { it.observe("music", false, false, "bilibili:next", ids) },
            { it.observe("listening", false, false, "local:current", ids) },
            { it.observe("music", true, false, "local:current", ids) },
            { it.observe("music", false, true, "local:current", ids) },
        )) {
            val s = state(); change(s)
            assertThrows(IllegalStateException::class.java) { undo(s) }
        }
    }
    @Test fun sequenceMismatchRetiresReceiptAndWrongOldTokenCannotConsumeNewOne() {
        val s = state()
        assertThrows(IllegalStateException::class.java) { undo(s, token = "old") }
        assertEquals("receipt", undo(s).token)
        assertThrows(IllegalStateException::class.java) { undo(s, queue = ids.reversed()) }
        assertThrows(IllegalStateException::class.java) { undo(s) }
    }
    @Test fun pendingOrUnreadableStateCannotRestore() {
        val s = state()
        assertThrows(IllegalStateException::class.java) { undo(s, pending = true) }
        assertThrows(IllegalStateException::class.java) { undo(s, unreadable = true) }
        assertEquals("receipt", undo(s).token)
    }
    @Test fun newestRemovalReplacesPreviousAndPositionUpdatesDoNotRetireIt() {
        val s = state()
        s.remember("new", "Another item", "new-native-item", 0, "local:current", ids)
        s.observe("music", false, false, "local:current", ids)
        assertThrows(IllegalStateException::class.java) { undo(s) }
        assertEquals("new-native-item", undo(s, token = "new").payload)
    }
}
