package expo.modules.orpheus.util

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer

@UnstableApi
class SleepTimeController(
    private val player: ExoPlayer,
    private val onListeningTimerChanged: () -> Unit = {},
) {
    private val handler = Handler(Looper.getMainLooper())
    private val listening = ListeningSleepTimerState()
    private var legacyStopTargetMs: Long? = null
    private val stopRunnable = Runnable { expireIfDue() }

    /** Retain the original unscoped duration API for existing non-Melo callers. */
    fun start(durationMs: Long) {
        cancel()
        if (durationMs <= 0) return
        legacyStopTargetMs = SystemClock.elapsedRealtime() + durationMs
        handler.postDelayed(stopRunnable, durationMs)
    }

    fun setListening(sourceId: String, mode: String, durationMs: Long?) {
        // Validate first: malformed bridge calls must leave the old timer intact.
        listening.set(sourceId, mode, durationMs, SystemClock.elapsedRealtime())
        legacyStopTargetMs = null
        handler.removeCallbacks(stopRunnable)
        refreshEndPolicy()
        listening.snapshot(SystemClock.elapsedRealtime())?.remainingMs?.let { handler.postDelayed(stopRunnable, it) }
        onListeningTimerChanged()
    }

    fun cancel() {
        val changed = listening.clear()
        legacyStopTargetMs = null
        handler.removeCallbacks(stopRunnable)
        refreshEndPolicy()
        if (changed) onListeningTimerChanged()
    }

    fun onSourceChanged(playbackMode: String, sourceId: String?) {
        if (listening.reconcilePlayback(playbackMode, sourceId)) {
            handler.removeCallbacks(stopRunnable)
            refreshEndPolicy()
            onListeningTimerChanged()
        }
        expireIfDue()
    }

    /** Media3 pauses before automatic advancement/repeat, rather than pausing the next P. */
    fun onPartEnded(): Boolean {
        if (!listening.consumePartEnd()) return false
        handler.removeCallbacks(stopRunnable)
        refreshEndPolicy()
        player.pause()
        onListeningTimerChanged()
        return true
    }

    fun expireIfDue() {
        val now = SystemClock.elapsedRealtime()
        val listeningExpired = listening.consumeElapsed(now)
        val legacyExpired = legacyStopTargetMs?.let { now >= it } == true
        if (listeningExpired || legacyExpired) {
            legacyStopTargetMs = null
            handler.removeCallbacks(stopRunnable)
            refreshEndPolicy()
            player.pause()
            if (listeningExpired) onListeningTimerChanged()
        }
    }

    fun listeningSnapshot(): Map<String, Any?>? {
        expireIfDue()
        return listening.snapshot(SystemClock.elapsedRealtime())?.toMap()
    }

    /** Compatibility API returns a display-only UTC deadline; decisions always use elapsed time. */
    fun getStopTimeMs(): Long? {
        expireIfDue()
        val now = SystemClock.elapsedRealtime()
        val remaining = listening.snapshot(now)?.remainingMs ?: legacyStopTargetMs?.minus(now) ?: return null
        return System.currentTimeMillis() + remaining
    }

    private fun refreshEndPolicy() {
        player.setPauseAtEndOfMediaItems(listening.snapshot(SystemClock.elapsedRealtime())?.mode == "part")
    }
}
