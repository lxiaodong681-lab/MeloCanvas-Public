package expo.modules.orpheus.util

import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class PlaybackNetworkGateTest {
    @Test fun defaultOffPermitsPlaybackWithoutWifi() {
        val gate = PlaybackNetworkGate()
        assertFalse(gate.blocked())
        gate.begin().use { it.check() }
        assertEquals(false, gate.state()["enabled"])
    }
    @Test fun enabledWithoutWifiRejectsBeforeAnyRequest() {
        val gate = PlaybackNetworkGate()
        gate.update(newEnabled = true)
        assertTrue(gate.blocked())
        assertTrue(runCatching { gate.begin() }.exceptionOrNull() is IOException)
    }
    @Test fun wifiLossCancelsOnlyOwnedRequestsAndNeverRevivesOldLease() {
        val gate = PlaybackNetworkGate()
        gate.update(true, true)
        val old = gate.begin()
        var cancelled = 0
        old.register { cancelled++ }
        assertTrue(gate.update(newWifi = false))
        assertEquals(1, cancelled)
        assertFalse(gate.update(newWifi = false))
        assertEquals(1, cancelled)
        gate.update(newWifi = true)
        assertTrue(runCatching { old.check() }.exceptionOrNull() is IOException)
        gate.begin().use { it.check() } // only a new explicit playback request can obtain a fresh lease
        old.close()
    }
    @Test fun requestRegisteredAfterLossAndReturnIsStillCancelled() {
        val gate = PlaybackNetworkGate()
        gate.update(true, true)
        val old = gate.begin()
        gate.update(newWifi = false)
        gate.update(newWifi = true)
        var cancelled = false
        assertTrue(runCatching { old.register { cancelled = true } }.exceptionOrNull() is IOException)
        assertTrue(cancelled)
        old.close()
    }
    @Test fun enablingOnCellularInterruptsExistingPlaybackAndDisablingDoesNotReviveIt() {
        val gate = PlaybackNetworkGate()
        val old = gate.begin()
        var cancelled = false
        old.register { cancelled = true }
        gate.update(newEnabled = true)
        assertTrue(cancelled)
        gate.update(newEnabled = false)
        assertTrue(runCatching { old.check() }.exceptionOrNull() is IOException)
        gate.begin().use { it.check() }
        old.close()
    }
    @Test fun finishedRequestsAreReleasedAndOneCancellationCannotBlockOthers() {
        val gate = PlaybackNetworkGate()
        gate.update(true, true)
        var finishedCancelled = false
        gate.begin().use { it.register { finishedCancelled = true } }
        var activeCancelled = false
        val active = gate.begin()
        active.register { throw IllegalStateException("cancel failed") }
        active.register { activeCancelled = true }
        gate.update(newWifi = false)
        assertFalse(finishedCancelled)
        assertTrue(activeCancelled)
        active.close()
    }
    @Test fun lossAfterPreflightBeforeCommitCancelsReplacementEvenIfWifiReturns() {
        val gate = PlaybackNetworkGate()
        gate.update(true, true)
        val guard = PlaybackReplacementGuard()
        val token = guard.begin()
        val lease = gate.begin()
        guard.onFinished(token) { lease.close() }
        lease.register { guard.cancelIfCurrent(token) }
        // IO completed, but its ownership must survive until the main-thread commit.
        gate.update(newWifi = false)
        gate.update(newWifi = true)
        var committed = false
        guard.commit(token) { committed = true }
        assertFalse(committed)
    }
    @Test fun successfulCommitReleasesNetworkOwnership() {
        val gate = PlaybackNetworkGate()
        gate.update(true, true)
        val guard = PlaybackReplacementGuard()
        val token = guard.begin()
        val lease = gate.begin()
        guard.onFinished(token) { lease.close() }
        lease.register { guard.cancelIfCurrent(token) }
        assertEquals("committed", guard.commit(token) { "committed" })
        gate.update(newWifi = false)
        assertTrue(guard.isCurrent(token)) // completed request no longer receives policy cancellation
    }
    @Test fun oldDataSourceCannotReopenAsDelayedLoaderRetryAfterWifiReturns() {
        val gate = PlaybackNetworkGate()
        gate.update(true, true)
        val sourceEpoch = gate.epoch()
        gate.begin(sourceEpoch).use { it.check() }
        gate.update(newWifi = false)
        gate.update(newWifi = true)
        assertTrue(runCatching { gate.begin(sourceEpoch) }.exceptionOrNull() is IOException)
        gate.begin(gate.epoch()).use { it.check() }
    }
}
