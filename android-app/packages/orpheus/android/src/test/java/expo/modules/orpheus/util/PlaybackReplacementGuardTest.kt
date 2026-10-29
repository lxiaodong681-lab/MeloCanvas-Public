package expo.modules.orpheus.util

import org.junit.Assert.*
import org.junit.Test

class PlaybackReplacementGuardTest {
    @Test fun pendingFinishKeepsTokenCurrentAndOldFinallyCannotClearNewReservation() {
        val guard = PlaybackReplacementGuard()
        val old = guard.begin()
        assertTrue(guard.isPending())
        val next = guard.begin()
        assertFalse(guard.finishIfCurrent(old))
        assertTrue(guard.isPending())
        assertTrue(guard.finishIfCurrent(next))
        assertFalse(guard.isPending())
        assertTrue(guard.isCurrent(next))
        assertFalse(guard.finishIfCurrent(next))
    }

    @Test fun failedPreflightOrCommitReleasesOnlyItsPendingWithoutSwallowingCurrentErrors() {
        val guard = PlaybackReplacementGuard()
        val token = guard.begin()
        val failure = IllegalStateException("preflight unavailable")
        assertSame(failure, runCatching { try { throw failure } finally { guard.finishIfCurrent(token) } }.exceptionOrNull())
        assertFalse(guard.isPending())
        assertTrue(guard.isCurrent(token))
        val next = guard.begin()
        runCatching { guard.commit(next) { throw failure } }
        assertFalse(guard.isPending())
        assertTrue(guard.isCurrent(next))
    }

    @Test fun noNativeActivationStillCanFinishOrCancelEmptyPoolReservation() {
        val guard = PlaybackReplacementGuard()
        val empty = guard.begin()
        assertTrue(guard.finishIfCurrent(empty))
        assertFalse(guard.isPending())
        val cancelled = guard.begin()
        assertTrue(guard.cancelIfCurrent(cancelled))
        assertFalse(guard.isPending())
        assertFalse(guard.isCurrent(cancelled))
    }

    @Test fun cancelledPreparationCannotMutateSession() {
        val guard = PlaybackReplacementGuard()
        var session = "old"
        var cancelled = false
        val token = guard.begin()
        guard.register(token) { cancelled = true }
        guard.cancel()
        guard.commit(token) { session = "new" }
        assertTrue(cancelled)
        assertEquals("old", session)
    }

    @Test fun supersededPreparationCannotReplaceLatestSession() {
        val guard = PlaybackReplacementGuard()
        val first = guard.begin()
        val second = guard.begin()
        var session = "old"
        assertNull(guard.commit(first) { session = "stale" })
        guard.commit(second) { session = "latest" }
        assertEquals("latest", session)
    }

    @Test fun failureBeforeCommitLeavesSessionUntouched() {
        val guard = PlaybackReplacementGuard()
        var session = "old"
        guard.begin()
        runCatching { error("AudioOnlyUnavailable") }
        assertEquals("old", session)
        val next = guard.begin()
        guard.commit(next) { session = "valid" }
        assertEquals("valid", session)
    }

    @Test fun cancellationRegisteredAfterSupersessionRunsImmediately() {
        val guard = PlaybackReplacementGuard()
        val old = guard.begin()
        guard.begin()
        var cancelled = false
        guard.register(old) { cancelled = true }
        assertTrue(cancelled)
        assertFalse(guard.isCurrent(old))
    }

    @Test fun lateCleanupCannotCancelNewOwnerOrItsRegisteredPreparation() {
        val guard = PlaybackReplacementGuard()
        val oldOwner = Any()
        val newOwner = Any()
        val old = guard.begin(oldOwner)
        val current = guard.begin(newOwner)
        var cancelled = false
        guard.register(current) { cancelled = true }

        assertFalse(guard.cancelIfCurrent(old))
        assertFalse(guard.cancelOwned(oldOwner))
        assertTrue(guard.isCurrent(current))
        assertFalse(cancelled)
        assertTrue(guard.cancelOwned(newOwner))
        assertTrue(cancelled)
        assertFalse(guard.isCurrent(current))
    }

    @Test fun conditionalCancellationIsAtomicAndDoesNotReserveAnotherUsableOldToken() {
        val guard = PlaybackReplacementGuard()
        val old = guard.begin()
        assertTrue(guard.cancelIfCurrent(old))
        assertFalse(guard.cancelIfCurrent(old))
        assertNull(guard.commit(old) { error("stale commit executed") })
        val next = guard.begin()
        assertTrue(next > old)
        assertEquals("new", guard.commit(next) { "new" })
    }

    @Test fun commitAndInternalPlayerChangesKeepTokenCurrentForFinalQuery() {
        val guard = PlaybackReplacementGuard()
        val owner = Any()
        val token = guard.begin(owner)
        var session = "old paused at 80"
        var cancelled = false
        guard.register(token) { cancelled = true }
        assertEquals("new", guard.commit(token) {
            // Direct internal restore/replace work does not submit a controller command.
            session = "new"
            session
        })
        assertEquals("new", session)
        assertTrue(guard.isCurrent(token))
        assertFalse(cancelled)
        assertTrue(guard.cancelOwned(owner))
        assertFalse(guard.isCurrent(token))
        // Committed preparation registrations have already been detached.
        assertFalse(cancelled)
    }

    @Test fun failedCommitCanRollBackWithoutPublishingAnotherGeneration() {
        val guard = PlaybackReplacementGuard()
        val token = guard.begin()
        var session = "old paused at 80"
        assertTrue(runCatching {
            guard.commit(token) {
                try {
                    session = "partial"
                    error("persistent write failed")
                } catch (error: Exception) {
                    session = "old paused at 80"
                    throw error
                }
            }
        }.isFailure)
        assertEquals("old paused at 80", session)
        assertTrue(guard.isCurrent(token))
        assertEquals("next", guard.commit(guard.begin()) { "next" })
    }

    @Test fun serviceTeardownInvalidatesAnyOwnerWithoutResettingGeneration() {
        val guard = PlaybackReplacementGuard()
        val token = guard.begin(Any())
        guard.cancel()
        assertNull(guard.commit(token) { error("destroyed service committed") })
        val afterRestart = guard.begin(Any())
        assertTrue(afterRestart > token)
        assertTrue(guard.isCurrent(afterRestart))
    }
}
