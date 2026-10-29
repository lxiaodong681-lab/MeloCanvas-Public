package expo.modules.orpheus.widget

import org.junit.Assert.assertEquals
import org.junit.Test

class WidgetQueueNavigationTest {
    private val entries = listOf("playlist-item:a1", "playlist-item:b1", "playlist-item:a2")

    @Test fun sequentialQueueKeepsRealHeadAndTailDisabled() {
        assertEquals(WidgetQueueNavigation(false, true), WidgetQueueNavigation.fromSaved(entries, entries[0], 0, null))
        assertEquals(WidgetQueueNavigation(true, true), WidgetQueueNavigation.fromSaved(entries, entries[1], 0, null))
        assertEquals(WidgetQueueNavigation(true, false), WidgetQueueNavigation.fromSaved(entries, entries[2], 0, null))
    }

    @Test fun repeatOneAndAllRetainManualWrapAtBothEndsAfterProcessDeath() {
        for (repeatMode in listOf(1, 2)) {
            assertEquals(WidgetQueueNavigation(true, true), WidgetQueueNavigation.fromSaved(entries, entries.first(), repeatMode, null))
            assertEquals(WidgetQueueNavigation(true, true), WidgetQueueNavigation.fromSaved(entries, entries.last(), repeatMode, null))
        }
    }

    @Test fun savedShuffleDefinesHeadMiddleAndTailByOccurrenceRatherThanArrayIndex() {
        val traversal = listOf(entries[1], entries[2], entries[0])
        assertEquals(WidgetQueueNavigation(false, true), WidgetQueueNavigation.fromSaved(entries, entries[1], 0, traversal))
        assertEquals(WidgetQueueNavigation(true, true), WidgetQueueNavigation.fromSaved(entries, entries[2], 0, traversal))
        assertEquals(WidgetQueueNavigation(true, false), WidgetQueueNavigation.fromSaved(entries, entries[0], 0, traversal))
    }

    @Test fun repeatedShuffledQueueKeepsBothDirectionsAvailableAtItsEdges() {
        val traversal = listOf(entries[2], entries[0], entries[1])
        for (repeatMode in listOf(1, 2)) {
            assertEquals(WidgetQueueNavigation(true, true), WidgetQueueNavigation.fromSaved(entries, traversal.first(), repeatMode, traversal))
            assertEquals(WidgetQueueNavigation(true, true), WidgetQueueNavigation.fromSaved(entries, traversal.last(), repeatMode, traversal))
        }
    }

    @Test fun aSingleOccurrenceOnlyOffersManualWrapWhenRepeatIsEnabled() {
        val single = entries.take(1)
        assertEquals(WidgetQueueNavigation(false, false), WidgetQueueNavigation.fromSaved(single, single[0], 0, null))
        for (repeatMode in listOf(1, 2))
            assertEquals(WidgetQueueNavigation(true, true), WidgetQueueNavigation.fromSaved(single, single[0], repeatMode, single))
    }

    @Test fun absentCurrentNeverEnablesButtonsEvenInRepeatMode() {
        for (repeatMode in listOf(0, 1, 2)) {
            assertEquals(WidgetQueueNavigation(false, false), WidgetQueueNavigation.fromSaved(emptyList(), null, repeatMode, null))
            assertEquals(WidgetQueueNavigation(false, false), WidgetQueueNavigation.fromSaved(entries, null, repeatMode, null))
            assertEquals(WidgetQueueNavigation(false, false), WidgetQueueNavigation.fromSaved(entries, "missing", repeatMode, null))
        }
    }
}
