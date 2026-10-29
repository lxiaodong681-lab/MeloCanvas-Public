package expo.modules.orpheus.util

/** A cancelled or superseded preparation must never commit to the live player. */
class PlaybackReplacementGuard {
    companion object {
        // The module and every MediaSession controller arbitrate the same service/player.
        val shared = PlaybackReplacementGuard()
    }

    private var generation = 0L
    private var owner: Any? = null
    private var pendingToken: Long? = null
    private val cancellations = mutableListOf<() -> Unit>()
    private val completions = mutableListOf<() -> Unit>()

    // Production reserves, controls and commits run on the player's main thread.
    // Synchronization also protects cancellation registration from IO preparation.
    @Synchronized
    fun begin(owner: Any? = null): Long {
        cancel()
        this.owner = owner
        pendingToken = generation
        return generation
    }

    @Synchronized
    fun cancel() {
        generation++
        owner = null
        pendingToken = null
        val pending = cancellations.toList()
        cancellations.clear()
        pending.forEach { it() }
        completeResources()
    }

    @Synchronized
    fun cancelIfCurrent(token: Long): Boolean {
        if (generation != token) return false
        cancel()
        return true
    }

    @Synchronized
    fun cancelOwned(owner: Any): Boolean {
        if (this.owner !== owner) return false
        cancel()
        return true
    }

    @Synchronized
    fun register(token: Long, cancel: () -> Unit) {
        if (generation == token) cancellations.add(cancel) else cancel()
    }

    /** Resources remain owned through the final main-thread commit, not only IO preflight. */
    @Synchronized
    fun onFinished(token: Long, close: () -> Unit) {
        if (generation == token && pendingToken == token) completions.add(close) else close()
    }

    private fun completeResources() {
        val resources = completions.toList()
        completions.clear()
        resources.forEach { it() }
    }

    @Synchronized
    fun isCurrent(token: Long): Boolean = generation == token

    @Synchronized
    fun isPending(): Boolean = pendingToken != null

    @Synchronized
    fun finishIfCurrent(token: Long): Boolean {
        if (generation != token || pendingToken != token) return false
        pendingToken = null
        cancellations.clear()
        completeResources()
        return true
    }

    @Synchronized
    fun <T> commit(token: Long, action: () -> T): T? {
        if (generation != token) return null
        cancellations.clear()
        return try { action() } finally { finishIfCurrent(token) }
    }
}
