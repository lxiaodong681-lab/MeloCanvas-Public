package expo.modules.orpheus.service

import android.app.PendingIntent
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.os.Bundle
import android.util.Log
import androidx.annotation.OptIn
import androidx.core.net.toUri
import androidx.core.app.NotificationCompat
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.CommandButton
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import expo.modules.orpheus.OrpheusConfig
import expo.modules.orpheus.R
import expo.modules.orpheus.manager.FloatingLyricsManager
import expo.modules.orpheus.manager.LyricsConsumer
import expo.modules.orpheus.manager.LyriconBackend
import expo.modules.orpheus.manager.MeizuStatusBarLyricsBackend
import expo.modules.orpheus.manager.StatusBarLyricsManager
import expo.modules.orpheus.manager.SuperLyricBackend
import expo.modules.orpheus.manager.UnifiedLyricsManager
import expo.modules.orpheus.model.LyricsData
import expo.modules.orpheus.model.LyricsLine
import expo.modules.orpheus.model.TrackRecord
import expo.modules.orpheus.util.CustomCommands
import expo.modules.orpheus.util.PlaybackNetworkPolicy
import expo.modules.orpheus.util.OfflinePlaybackDataSource
import expo.modules.orpheus.util.LocalAudioIdentity
import expo.modules.orpheus.util.DownloadUtil
import expo.modules.orpheus.util.RecentMusicHistoryEntry
import expo.modules.orpheus.util.RecentMusicHistoryStorage
import expo.modules.orpheus.util.RecentMusicPlaybackObserver
import expo.modules.orpheus.util.PlaybackSourceIdentity
import expo.modules.orpheus.util.GeneralStorage
import expo.modules.orpheus.util.GlideBitmapLoader
import expo.modules.orpheus.util.LoudnessStorage
import expo.modules.orpheus.util.MusicQueueRemoval
import expo.modules.orpheus.util.MusicQueueNext
import expo.modules.orpheus.util.MusicPlaybackOrder
import expo.modules.orpheus.util.MusicPartSwitch
import expo.modules.orpheus.util.SleepTimeController
import expo.modules.orpheus.util.TrackResumeStorage
import expo.modules.orpheus.util.PlaybackSessionSnapshot
import expo.modules.orpheus.util.PlaybackSessionCodec
import expo.modules.orpheus.util.playbackSourceId
import expo.modules.orpheus.util.PlaybackSessionStorage
import expo.modules.orpheus.util.PlaybackReplacementGuard
import expo.modules.orpheus.util.PlaybackControlCommands
import expo.modules.orpheus.util.StoredPlaybackSessions
import expo.modules.orpheus.util.FmPlaybackContext
import expo.modules.orpheus.util.CandidateAuditionControls
import expo.modules.orpheus.util.CandidateAuditionSession
import expo.modules.orpheus.util.FmPlaybackSessions
import expo.modules.orpheus.util.PlaybackSessionRead
import expo.modules.orpheus.util.toMediaItem
import expo.modules.orpheus.util.calculateLoudnessGain
import expo.modules.orpheus.util.fadeInTo
import expo.modules.orpheus.widget.WidgetCommand
import expo.modules.orpheus.widget.WidgetIntents
import expo.modules.orpheus.widget.WidgetPlaybackFrame
import expo.modules.orpheus.widget.WidgetRenderer
import expo.modules.orpheus.widget.WidgetStamp
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.math.abs

@OptIn(UnstableApi::class)
class OrpheusMusicService : MediaLibraryService() {

    private val networkPolicyListener: (Boolean) -> Unit = { interrupted ->
        if (interrupted || PlaybackNetworkPolicy.blocked()) enforcePlaybackNetworkPolicy()
    }

    private fun enforcePlaybackNetworkPolicy(): Boolean {
        val current = player ?: return false
        val uri = current.currentMediaItem?.localConfiguration?.uri?.toString() ?: return false
        if (OfflinePlaybackDataSource.isOfflineUri(uri) || LocalAudioIdentity.idFromUri(uri) != null || DownloadUtil.hasCompletePlaybackCache(this, uri)) return false
        // stop(), not pause() alone: pause permits continued buffering. Queue and position remain intact.
        current.pause()
        current.stop()
        return true
    }

    /** Called from the synchronous bridge; every transport also checks the gate. */
    fun onAccountSessionChanged() {
        PlaybackReplacementGuard.shared.cancel()
        if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) pauseForAccountGate()
        else serviceHandler.postAtFrontOfQueue { pauseForAccountGate() }
    }

    /** Main-thread, awaitable by the bridge; never creates a service or player. */
    fun pauseForAccountGate() {
        PlaybackReplacementGuard.shared.cancel()
        player?.let { current ->
            current.pause()
            current.stop() // Keep queue and position; drop old-account buffered audio.
        }
    }

    private fun enforceAccountSession(): Boolean {
        if (OrpheusConfig.hasPlaybackAccess()) return false
        player?.pause()
        player?.stop()
        return true
    }

    var player: ExoPlayer? = null
    private var mediaSession: MediaLibrarySession? = null
    private var sleepTimerManager: SleepTimeController? = null
    private var volumeFadeJob: Job? = null
    private var scope = MainScope()

    lateinit var floatingLyricsManager: FloatingLyricsManager
    lateinit var statusBarLyricsManager: StatusBarLyricsManager
    private val serviceHandler = android.os.Handler(android.os.Looper.getMainLooper())

    private var lastTrackFinishedAt: Long = 0
    private val durationCache = mutableMapOf<String, Long>()
    lateinit var shuffleManager: ShuffleManager
    lateinit var lyricsManager: UnifiedLyricsManager
    private var currentMediaId: String? = null
    private var playbackMode = "music"
    private var listeningResumeOverrides: Map<String, Double> = emptyMap()
    private var listeningResumeBlocked: Set<String> = emptySet()
    private val recentMusicObserver = RecentMusicPlaybackObserver()
    private val musicQueueRemoval = MusicQueueRemoval<MediaItem>()
    private var inactiveSession: PlaybackSessionSnapshot? = null
    private var fm: FmPlaybackContext? = null
    private val audition = CandidateAuditionSession()
    private val auditionReturn get() = audition.original
    private val auditionId get() = audition.id
    private var replacingPlayback = false
    private var playbackPersistenceError: String? = null
    private var sessionStorageUnreadable = false
    private var widgetStamp = WidgetStamp.create()
    private var widgetStampDurable = false
    private var hasHandledStart = false
    private val json = Json { ignoreUnknownKeys = true }

    private val lyricsUpdateRunnable = object : Runnable {
        override fun run() {
            player?.let { p ->
                if (p.isPlaying) {
                    val seconds = p.currentPosition / 1000.0
                    lyricsManager.updateTime(seconds)
                }
            }
            serviceHandler.postDelayed(this, 200)
        }
    }

    /**
     * 播放中每 5 秒保存一次逐首断点。突然终止时依靠最近一次周期保存恢复。
     */
    private val resumeSaveRunnable = object : Runnable {
        override fun run() {
            saveCurrentResumeRecord()
            serviceHandler.postDelayed(this, RESUME_SAVE_INTERVAL_MS)
        }
    }

    companion object {
        private const val RESUME_SAVE_INTERVAL_MS = 5000L

        var instance: OrpheusMusicService? = null
            private set(value) {
                field = value
                if (value != null) {
                    listeners.forEach { it(value) }
                }
            }

        private val listeners = CopyOnWriteArrayList<(OrpheusMusicService) -> Unit>()

        fun addOnServiceReadyListener(listener: (OrpheusMusicService) -> Unit) {
            instance?.let { listener(it) }
            listeners.add(listener)
        }

        fun removeOnServiceReadyListener(listener: (OrpheusMusicService) -> Unit) {
            listeners.remove(listener)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val widgetStart = intent?.action == WidgetIntents.ACTION
        val firstStart = !hasHandledStart
        val wasPlaying = player?.playWhenReady == true
        hasHandledStart = true
        // Every Widget control is an explicit user gesture. Promote immediately,
        // before validation/prepare or network completion can delay the FGS deadline.
        if (widgetStart) startWidgetForeground()
        super.onStartCommand(intent, flags, startId)
        if (widgetStart) {
            runCatching {
                val command = WidgetIntents.read(this, intent!!)
                if (command != null) executeWidgetCommand(command)
            }.onFailure { Log.e("MeloWidget", "Widget command failed; playback retained", it) }
            WidgetRenderer.updateAll(this)
            // Only end this newly started, still-paused work. A later start or a
            // live/buffering/focus-interrupted session must keep its foreground.
            if (WidgetCommand.shouldStopStartedWork(firstStart, wasPlaying, player?.playWhenReady == true) && stopSelfResult(startId)) {
                stopForeground(STOP_FOREGROUND_REMOVE)
                return START_NOT_STICKY
            }
            mediaSession?.let { onUpdateNotification(it, true) }
        }
        return START_STICKY
    }

    @OptIn(UnstableApi::class)
    private fun startWidgetForeground() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(
            DefaultMediaNotificationProvider.DEFAULT_CHANNEL_ID, "媒体播放", NotificationManager.IMPORTANCE_LOW,
        ))
        val notification = NotificationCompat.Builder(this, DefaultMediaNotificationProvider.DEFAULT_CHANNEL_ID)
            .setSmallIcon(R.drawable.outline_play_arrow_24)
            .setContentTitle(player?.currentMediaItem?.mediaMetadata?.title ?: "音绘")
            .setContentText("正在更新播放状态")
            .setContentIntent(WidgetIntents.open(this))
            .setOnlyAlertOnce(true).setSilent(true).setOngoing(true).build()
        startForeground(DefaultMediaNotificationProvider.DEFAULT_NOTIFICATION_ID, notification)
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        val player = mediaSession?.player
        if (player == null || !player.playWhenReady || player.mediaItemCount == 0) {
            stopSelf()
        }
        super.onTaskRemoved(rootIntent)
    }

    override fun onUpdateNotification(session: MediaSession, startInForegroundRequired: Boolean) {
        super.onUpdateNotification(session, true)
    }

    @OptIn(UnstableApi::class)
    override fun onCreate() {
        super.onCreate()
        instance = this
        PlaybackNetworkPolicy.initialize(this)
        PlaybackNetworkPolicy.addListener(networkPolicyListener)

        GeneralStorage.initialize(this)
        LoudnessStorage.initialize(this)
        TrackResumeStorage.initialize(this)
        PlaybackSessionStorage.initialize(this)
        runCatching { RecentMusicHistoryStorage.initialize(this) }
            .onFailure { Log.e("OrpheusMusicService", "Recent music storage initialization failed", it) }

        setMediaNotificationProvider(object : DefaultMediaNotificationProvider(this) {
            override fun getMediaButtons(
                session: MediaSession,
                playerCommands: Player.Commands,
                customLayout: ImmutableList<CommandButton>,
                showPlaying: Boolean
            ): ImmutableList<CommandButton> {
                val builder = ImmutableList.builder<CommandButton>()
                val player = session.player

                // Previous
                builder.add(
                    CommandButton.Builder(CommandButton.ICON_UNDEFINED)
                        .setPlayerCommand(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
                        .setCustomIconResId(R.drawable.outline_skip_previous_24)
                        .setDisplayName("上一首")
                        .setEnabled(playerCommands.contains(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM))
                        .build()
                )

                // Play/Pause
                if (showPlaying) {
                    builder.add(
                        CommandButton.Builder(CommandButton.ICON_UNDEFINED)
                            .setPlayerCommand(Player.COMMAND_PLAY_PAUSE)
                            .setCustomIconResId(R.drawable.outline_pause_24)
                            .setDisplayName("暂停")
                            .setEnabled(playerCommands.contains(Player.COMMAND_PLAY_PAUSE))
                            .build()
                    )
                } else {
                    builder.add(
                        CommandButton.Builder(CommandButton.ICON_UNDEFINED)
                            .setPlayerCommand(Player.COMMAND_PLAY_PAUSE)
                            .setCustomIconResId(R.drawable.outline_play_arrow_24)
                            .setDisplayName("播放")
                            .setEnabled(playerCommands.contains(Player.COMMAND_PLAY_PAUSE))
                            .build()
                    )
                }

                // Next
                builder.add(
                    CommandButton.Builder(CommandButton.ICON_UNDEFINED)
                        .setPlayerCommand(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
                        .setCustomIconResId(R.drawable.outline_skip_next_24)
                        .setDisplayName("下一首")
                        .setEnabled(playerCommands.contains(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM))
                        .build()
                )

                // Repeat Mode Toggle
                val repeatIcon = when (player.repeatMode) {
                    Player.REPEAT_MODE_ONE -> R.drawable.outline_repeat_one_24
                    Player.REPEAT_MODE_ALL -> R.drawable.outline_repeat_24
                    else -> R.drawable.outline_repeat_off_24
                }

                builder.add(
                    CommandButton.Builder(CommandButton.ICON_UNDEFINED)
                        .setSessionCommand(
                            SessionCommand(
                                CustomCommands.CMD_TOGGLE_REPEAT_MODE,
                                Bundle.EMPTY
                            )
                        )
                        .setCustomIconResId(repeatIcon)
                        .setDisplayName("Repeat Mode")
                        .setEnabled(true)
                        .build()
                )

                return builder.build()
            }
        })

        initializePlayer()
    }

    /**
     * 创建/重建 ExoPlayer、MediaSession 及相关组件。
     * 可多次调用，每次调用前应确保旧 player 已释放或为 null。
     */
    @OptIn(UnstableApi::class)
    private fun initializePlayer() {
        val dataSourceFactory = DownloadUtil.getPlayerDataSourceFactory(this)

        val mediaSourceFactory = DefaultMediaSourceFactory(this)
            .setDataSourceFactory(dataSourceFactory)
            .setLoadErrorHandlingPolicy(androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy(2))

        val renderersFactory = DefaultRenderersFactory(this)
            .experimentalSetMediaCodecAsyncCryptoFlagEnabled(false)

        player = ExoPlayer.Builder(this, renderersFactory)
            // System controllers using seekToPrevious must match the app's item navigation.
            .setMaxSeekToPreviousPositionMs(Long.MAX_VALUE)
            .setMediaSourceFactory(mediaSourceFactory)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .build(),
                true
            )
            .setHandleAudioBecomingNoisy(true)
            .build()

        shuffleManager = ShuffleManager { player }

        floatingLyricsManager = FloatingLyricsManager(this, player)
        floatingLyricsManager.onClearLyricsRequested = { trackId ->
            lyricEventListeners.forEach { it.onLyricCleared(trackId) }
            sendRequestClearLyricsEvent(trackId)
        }
        if (GeneralStorage.isDesktopLyricsShown()) {
            serviceHandler.post { floatingLyricsManager.show() }
        }

        statusBarLyricsManager = StatusBarLyricsManager(this)
        statusBarLyricsManager.backend = createStatusBarBackend(GeneralStorage.getStatusBarLyricsProvider())
        statusBarLyricsManager.enabled = GeneralStorage.isStatusBarLyricsEnabled()
        lyricsManager = UnifiedLyricsManager(
            floatingLyricsManager = floatingLyricsManager,
            statusBarLyricsManager = statusBarLyricsManager,
            currentPlaybackSeconds = { player?.currentPosition?.toDouble()?.div(1000.0) },
            onCarLyricsChanged = ::updateCurrentMetadata,
        )

        setupListeners()

        var launchIntent = packageManager.getLaunchIntentForPackage(packageName)

        if (launchIntent == null) {
            launchIntent = Intent().apply {
                setClassName(packageName, "$packageName.MainActivity")
            }
        }

        launchIntent.apply {
            action = Intent.ACTION_VIEW
            data = "orpheus://player".toUri()
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }

        val contentIntent = launchIntent.let {
            PendingIntent.getActivity(
                this,
                0,
                it,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
        }

        mediaSession = MediaLibrarySession.Builder(this, player!!, callback)
            .setId("OrpheusSession")
            .setSessionActivity(contentIntent)
            .setBitmapLoader(GlideBitmapLoader(this))
            .build()

        restorePlayerState(GeneralStorage.isRestoreEnabled())
        sleepTimerManager = SleepTimeController(player!!) {
            sleepTimerListeners.forEach { it() }
        }
        persistPlaybackSnapshot()
        WidgetRenderer.updateAll(this)
    }

    /**
     * 检查 player 是否存在，不存在则重建。
     * 供外部（如 ExpoOrpheusModule）调用。
     */
    @OptIn(UnstableApi::class)
    fun ensurePlayer(): ExoPlayer {
        if (player == null) {
            Log.w("OrpheusMusicService", "Player was null, reinitializing...")
            initializePlayer()
        }
        return player!!
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? {
        return mediaSession
    }

    override fun onDestroy() {
        PlaybackNetworkPolicy.removeListener(networkPolicyListener)
        if (instance === this) {
            PlaybackReplacementGuard.shared.cancel()
            instance = null
        }
        sleepTimerManager?.cancel()
        sleepTimerManager = null
        sleepTimerListeners.clear()
        serviceHandler.removeCallbacks(lyricsUpdateRunnable)
        serviceHandler.removeCallbacks(resumeSaveRunnable)
        saveCurrentResumeRecord()
        floatingLyricsManager.hide()
        statusBarLyricsManager.onStop()
        scope.cancel()
        mediaSession?.run {
            player.release()
            release()
            mediaSession = null
        }
        this.player = null
        WidgetRenderer.updateAll(this)
        super.onDestroy()
    }

    /**
     * Enable or disable shuffle mode. Delegates to ShuffleManager which uses
     * Media3's built-in shuffleModeEnabled flag for zero-cost queue traversal.
     */
    fun applyShuffleMode(enabled: Boolean) {
        require(auditionReturn == null) { "候选试听不支持随机播放" }
        require(!isFmMusic() || !enabled) { "私人 FM 仅支持顺序播放" }
        shuffleManager.setShuffleEnabled(enabled)
    }

    fun isCandidateAudition(): Boolean = auditionReturn != null

    fun requireNotCandidateAudition() {
        check(!isCandidateAudition()) { "请先结束候选试听，再更换播放队列。" }
    }

    fun isFmMusic(): Boolean = fm != null && playbackMode == "music"

    fun applyRepeatMode(mode: Int) {
        require(auditionReturn == null) { "候选试听不支持循环播放" }
        require(!isFmMusic() || mode == Player.REPEAT_MODE_OFF) { "私人 FM 播完停止，不支持循环" }
        player?.repeatMode = mode
    }

    /** One Main-thread action; never expose half of a repeat/shuffle change. */
    fun setMusicPlaybackOrder(order: String, expectedEntryId: String): Map<String, Any?> {
        val current = ensurePlayer()
        val target = MusicPlaybackOrder.plan(order, playbackMode, fm != null || auditionReturn != null,
            PlaybackReplacementGuard.shared.isPending(), current.currentMediaItem?.mediaId, expectedEntryId)
        check(!sessionStorageUnreadable) { "播放记录无法读取，暂时不能切换模式" }
        shuffleManager.setShuffleEnabled(target.shuffle)
        current.repeatMode = target.repeatMode
        persistPlaybackSnapshot()
        return playbackSnapshotMap()
    }

    /** Select by occurrence ID without replacing the queue or resetting its playback order. */
    fun selectMusicQueueEntry(expectedEntryId: String, entryId: String): Map<String, Any?> {
        val current = ensurePlayer()
        MusicPlaybackOrder.plan("sequential", playbackMode, fm != null || auditionReturn != null,
            PlaybackReplacementGuard.shared.isPending(), current.currentMediaItem?.mediaId, expectedEntryId)
        check(!sessionStorageUnreadable) { "播放记录无法读取" }
        val index = (0 until current.mediaItemCount).firstOrNull { current.getMediaItemAt(it).mediaId == entryId }
        require(index != null) { "队列条目已变化" }
        // Tapping the current row resumes in place; another occurrence still starts from zero.
        if (index != current.currentMediaItemIndex || current.playbackState == Player.STATE_ENDED)
            current.seekTo(index, 0L)
        if (current.playbackState == Player.STATE_IDLE || current.playerError != null) current.prepare()
        if (OrpheusConfig.hasPlaybackAccess()) current.play()
        return playbackSnapshotMap()
    }

    private val sleepTimerListeners = CopyOnWriteArrayList<() -> Unit>()

    fun addSleepTimerListener(listener: () -> Unit) { sleepTimerListeners.addIfAbsent(listener) }
    fun removeSleepTimerListener(listener: () -> Unit) { sleepTimerListeners.remove(listener) }

    /** Reorder an existing occurrence without restarting, seeking or replacing playback. */
    fun moveMusicQueueEntryNext(expectedCurrentEntryId: String, entryId: String,
        expectedQueueEntryIds: List<String>): Map<String, Any?> {
        val current = ensurePlayer()
        val queueIds = List(current.mediaItemCount) { current.getMediaItemAt(it).mediaId }
        val move = MusicQueueNext.plan(playbackMode, fm != null || auditionReturn != null,
            PlaybackReplacementGuard.shared.isPending(),
            shuffleManager.isEnabled || current.shuffleModeEnabled,
            current.currentMediaItem?.mediaId, queueIds,
            expectedCurrentEntryId, entryId, expectedQueueEntryIds, sessionStorageUnreadable)
        if (move != null) {
            current.moveMediaItem(move.fromIndex, move.toIndex)
            // Surface the existing persistence warning contract in the returned snapshot.
            persistPlaybackSnapshot()
        }
        return playbackSnapshotMap()
    }

    fun removeMusicQueueEntry(expectedCurrentEntryId: String, entryId: String,
        expectedQueueEntryIds: List<String>): Map<String, Any?> {
        val current = ensurePlayer()
        val ids = List(current.mediaItemCount) { current.getMediaItemAt(it).mediaId }
        val shuffled = shuffleManager.isEnabled || current.shuffleModeEnabled
        // Removing a physical occurrence lets Media3 prune its shuffle traversal.
        // The move-only sequential restriction is not needed for this operation.
        MusicQueueNext.plan(playbackMode, fm != null || auditionReturn != null, PlaybackReplacementGuard.shared.isPending(),
            false, current.currentMediaItem?.mediaId,
            ids, expectedCurrentEntryId, entryId, expectedQueueEntryIds, sessionStorageUnreadable)
        val index = ids.indexOf(entryId)
        val removed = current.getMediaItemAt(index)
        current.removeMediaItem(index)
        // Media3 dispatches the playlist timeline change immediately. Publish only after
        // the removal succeeds; that event has already retired any earlier receipt.
        val afterIds = List(current.mediaItemCount) { current.getMediaItemAt(it).mediaId }
        check(afterIds == ids.filterIndexed { i, _ -> i != index } &&
            current.currentMediaItem?.mediaId == expectedCurrentEntryId) { "Queue changed while removing entry" }
        if (!shuffled) musicQueueRemoval.remember(java.util.UUID.randomUUID().toString(),
            removed.mediaMetadata.title?.toString() ?: entryId, removed, index, expectedCurrentEntryId, afterIds)
        persistPlaybackSnapshot()
        return playbackSnapshotMap()
    }

    fun undoMusicQueueRemoval(token: String): Map<String, Any?> {
        val current = ensurePlayer()
        val ids = List(current.mediaItemCount) { current.getMediaItemAt(it).mediaId }
        val saved = musicQueueRemoval.requireUndo(token, playbackMode, fm != null || auditionReturn != null,
            PlaybackReplacementGuard.shared.isPending(), shuffleManager.isEnabled || current.shuffleModeEnabled,
            sessionStorageUnreadable, current.currentMediaItem?.mediaId, ids)
        current.addMediaItem(saved.index, saved.payload)
        musicQueueRemoval.queueChanged()
        persistPlaybackSnapshot()
        return playbackSnapshotMap()
    }

    private fun musicQueueUndoSnapshot(): Map<String, Any>? {
        val current = ensurePlayer()
        musicQueueRemoval.observe(playbackMode, fm != null || auditionReturn != null,
            shuffleManager.isEnabled || current.shuffleModeEnabled, current.currentMediaItem?.mediaId,
            List(current.mediaItemCount) { current.getMediaItemAt(it).mediaId })
        return musicQueueRemoval.snapshot()
    }

    fun setListeningSleepTimer(expectedSourceId: String, mode: String, durationMs: Long?): Map<String, Any?> {
        check(!PlaybackReplacementGuard.shared.isPending()) { "Playback preparation is pending" }
        val current = ensurePlayer()
        check(playbackMode == "listening" && current.currentMediaItem?.playbackSourceId() == expectedSourceId) {
            "Listening playback changed before the timer action"
        }
        checkNotNull(sleepTimerManager).setListening(expectedSourceId, mode, durationMs)
        return playbackSnapshotMap()
    }

    private fun reconcileListeningSleepTimer() {
        if (auditionReturn != null) return
        sleepTimerManager?.onSourceChanged(playbackMode, player?.currentMediaItem?.playbackSourceId())
    }

    fun startSleepTimer(durationMs: Long) {
        sleepTimerManager?.start(durationMs)
    }

    fun cancelSleepTimer() {
        sleepTimerManager?.cancel()
    }

    fun getSleepTimerRemaining(): Long? {
        return sleepTimerManager?.getStopTimeMs()
    }

    var callback: MediaLibrarySession.Callback = @UnstableApi
    object : MediaLibrarySession.Callback {

        @OptIn(UnstableApi::class)
        override fun onPlayerCommandRequest(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
            playerCommand: Int
        ): Int {
            if (!OrpheusConfig.hasPlaybackAccess() && playerCommand != Player.COMMAND_STOP)
                return SessionResult.RESULT_ERROR_INVALID_STATE
            if (isCandidateAudition() && CandidateAuditionControls.blocks(playerCommand))
                return SessionResult.RESULT_ERROR_NOT_SUPPORTED
            // Media3 dispatches controller commands on the player's application looper.
            // Direct restore/replace/automatic transitions do not enter this callback.
            if (PlaybackControlCommands.invalidatesReplacement(playerCommand)) {
                PlaybackReplacementGuard.shared.cancel()
            }
            if ((isFmMusic() || auditionReturn != null) && (playerCommand == Player.COMMAND_SET_REPEAT_MODE ||
                    playerCommand == Player.COMMAND_SET_SHUFFLE_MODE)) return SessionResult.RESULT_ERROR_NOT_SUPPORTED
            return super.onPlayerCommandRequest(session, controller, playerCommand)
        }

        @OptIn(UnstableApi::class)
        override fun onConnect(
            session: MediaSession,
            controller: MediaSession.ControllerInfo
        ): MediaSession.ConnectionResult {
            val sessionCommands = MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon()
                .add(SessionCommand(CustomCommands.CMD_TOGGLE_REPEAT_MODE, Bundle.EMPTY))
                .build()

            return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                .setAvailableSessionCommands(sessionCommands)
                .build()
        }

        @OptIn(UnstableApi::class)
        override fun onCustomCommand(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
            customCommand: SessionCommand,
            args: Bundle
        ): ListenableFuture<SessionResult> {
            if (customCommand.customAction == CustomCommands.CMD_TOGGLE_REPEAT_MODE) {
                PlaybackReplacementGuard.shared.cancel()
                val player = session.player
                if (isFmMusic() || auditionReturn != null) {
                    player.repeatMode = Player.REPEAT_MODE_OFF
                    return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
                }
                val newMode = when (player.repeatMode) {
                    Player.REPEAT_MODE_OFF -> Player.REPEAT_MODE_ALL
                    Player.REPEAT_MODE_ALL -> Player.REPEAT_MODE_ONE
                    Player.REPEAT_MODE_ONE -> Player.REPEAT_MODE_OFF
                    else -> Player.REPEAT_MODE_OFF
                }
                player.repeatMode = newMode
                return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
            }
            return super.onCustomCommand(session, controller, customCommand, args)
        }

        override fun onPlaybackResumption(
            mediaSession: MediaSession,
            controller: MediaSession.ControllerInfo,
            isPlayback: Boolean
        ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
            return Futures.immediateFuture(
                MediaSession.MediaItemsWithStartPosition(
                    emptyList(), // 没有媒体项
                    C.INDEX_UNSET, // 索引未定
                    C.TIME_UNSET   // 进度未定
                )
            )
        }
    }

    @OptIn(UnstableApi::class)
    private fun restorePlayerState(restorePosition: Boolean) {
        val player = player ?: return

        val read = PlaybackSessionStorage.read()
        sessionStorageUnreadable = read == PlaybackSessionRead.Unreadable
        if (sessionStorageUnreadable) {
            // Legacy cache may be the FM physical queue. It cannot recover lost v3 ownership.
            playbackPersistenceError = "原生播放记录损坏或版本不受支持；原记录与本地暂存队列已保留，暂不能恢复播放。"
            widgetStampDurable = false
            playbackMode = "music"
            listeningResumeOverrides = emptyMap()
            listeningResumeBlocked = emptySet()
            inactiveSession = null
            fm = null
            player.playWhenReady = false
            player.clearMediaItems()
            currentMediaId = null
            return
        }
        val stored = (read as? PlaybackSessionRead.Available)?.sessions
        val active = stored?.active
        if (active != null && validSession(active)) {
            widgetStamp = WidgetStamp.restored(stored?.widgetStamp)
            inactiveSession = stored?.inactive?.takeIf { validSession(it) }
            fm = stored?.fm
            playbackMode = active.mode
            listeningResumeOverrides = active.listeningResumeOverrides
            listeningResumeBlocked = active.listeningResumeBlocked
            TrackResumeStorage.setStrategy(if (active.mode == "listening") TrackResumeStorage.STRATEGY_PODCAST else TrackResumeStorage.STRATEGY_NONE)
            replacingPlayback = true
            try {
                val index = active.tracks.indexOfFirst { it.id == active.currentEntryId }.coerceAtLeast(0)
                if (active.tracks.isEmpty()) player.clearMediaItems()
                else player.setMediaItems(active.tracks.map { it.toMediaItem(this) }, index, (active.positionSeconds * 1000).toLong())
                player.setPlaybackSpeed(active.speed)
                shuffleManager.restoreEntryOrder(active.shuffleEntryIds)
                player.repeatMode = active.repeatMode
                player.playWhenReady = false
                if (active.tracks.isNotEmpty() && OrpheusConfig.hasPlaybackAccess()) player.prepare()
                currentMediaId = player.currentMediaItem?.mediaId
            } finally {
                replacingPlayback = false
            }
            return
        }

        val restoredItems = GeneralStorage.restoreQueue(this)

        if (restoredItems.isNotEmpty()) {
            player.setMediaItems(restoredItems)

            val savedIndex = GeneralStorage.getSavedIndex()
            val savedPosition = GeneralStorage.getSavedPosition()
            val savedShuffleMode = GeneralStorage.getShuffleMode()
            val savedRepeatMode = GeneralStorage.getRepeatMode()

            // 起播位置优先级：会话恢复位置 > podcast 逐首断点 > 从头开始
            val startPositionMs = when {
                restorePosition -> savedPosition
                TrackResumeStorage.getStrategy() == TrackResumeStorage.STRATEGY_PODCAST -> {
                    restoredItems.getOrNull(savedIndex)
                        ?.let { TrackResumeStorage.get(it.playbackSourceId()) }
                        ?.let { (it.position * 1000).toLong() } ?: 0L
                }
                else -> 0L
            }

            if (savedIndex >= 0 && savedIndex < restoredItems.size) {
                player.seekTo(savedIndex, startPositionMs)
            } else {
                player.seekTo(0, 0L)
            }

            // Restore shuffle state without re-shuffling the saved queue order
            shuffleManager.restoreShuffleEnabled(savedShuffleMode)
            player.repeatMode = savedRepeatMode

            currentMediaId = player.currentMediaItem?.mediaId

            // Restoring a process must never produce sound before the user's play action.
            player.playWhenReady = false
            if (OrpheusConfig.hasPlaybackAccess()) player.prepare()

            // 软件冷启动时，恢复的歌曲并不会触发 onMediaTransition 事件，我们需要手动补发一个
            if (player.currentMediaItem != null) {
                sendTrackStartEvent(
                    player.currentMediaItem,
                    Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED
                )
            }
        }
    }

    interface TrackEventListener {
        fun onPlaybackSessionChanged() {}
        fun onRecentMusicHistoryChanged() {}
        fun onTrackStarted(trackId: String, reason: Int)
        fun onTrackFinished(trackId: String, finalPosition: Double, duration: Double)
    }

    interface LyricEventListener {
        fun onLyricCleared(trackId: String)
    }

    private val trackEventListeners = CopyOnWriteArrayList<TrackEventListener>()
    private val lyricEventListeners = CopyOnWriteArrayList<LyricEventListener>()

    fun addTrackEventListener(listener: TrackEventListener) {
        trackEventListeners.add(listener)
    }

    fun removeTrackEventListener(listener: TrackEventListener) {
        trackEventListeners.remove(listener)
    }

    fun addLyricEventListener(listener: LyricEventListener) {
        lyricEventListeners.add(listener)
    }

    fun removeLyricEventListener(listener: LyricEventListener) {
        lyricEventListeners.remove(listener)
    }

    @OptIn(UnstableApi::class)
    private fun sendTrackStartEvent(mediaItem: androidx.media3.common.MediaItem?, reason: Int) {
        if (mediaItem == null) return

        // Notify local listeners
        trackEventListeners.forEach { it.onTrackStarted(mediaItem.mediaId, reason) }

        try {
            val intent = Intent(this, OrpheusHeadlessTaskService::class.java)
            intent.putExtra("eventName", "onTrackStarted")
            intent.putExtra("trackId", mediaItem.mediaId)
            intent.putExtra("reason", reason)
            startService(intent)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun sendTrackFinishedEvent(trackId: String, finalPosition: Double, duration: Double) {
        // Notify local listeners
        trackEventListeners.forEach { it.onTrackFinished(trackId, finalPosition, duration) }

        try {
            val intent = Intent(this, OrpheusHeadlessTaskService::class.java)
            intent.putExtra("eventName", "onTrackFinished")
            intent.putExtra("trackId", trackId)
            intent.putExtra("finalPosition", finalPosition)
            intent.putExtra("duration", duration)
            startService(intent)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun sendTrackPausedEvent() {
        try {
            val intent = Intent(this, OrpheusHeadlessTaskService::class.java)
            intent.putExtra("eventName", "onTrackPaused")
            startService(intent)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun sendTrackResumedEvent() {
        try {
            val intent = Intent(this, OrpheusHeadlessTaskService::class.java)
            intent.putExtra("eventName", "onTrackResumed")
            startService(intent)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun sendRequestClearLyricsEvent(trackId: String) {
        try {
            val intent = Intent(this, OrpheusHeadlessTaskService::class.java)
            intent.putExtra("eventName", "onRequestClearLyrics")
            intent.putExtra("trackId", trackId)
            startService(intent)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun recordRecentMusicPlayback(current: Player) {
        if (auditionReturn != null) return
        val item = current.currentMediaItem
        if (!recentMusicObserver.observe(playbackMode, item?.mediaId, current.isPlaying)) return
        if (item == null) return
        val sourceId = item.playbackSourceId()
        val url = item.localConfiguration?.uri?.toString() ?: return
        if (!PlaybackSourceIdentity.isValidEntry(item.mediaId, sourceId, url, "music")) return
        try {
            RecentMusicHistoryStorage.record(RecentMusicHistoryEntry(
                sourceId = sourceId,
                title = item.mediaMetadata.title?.toString().orEmpty(),
                artist = item.mediaMetadata.artist?.toString().orEmpty(),
                artwork = item.mediaMetadata.artworkUri?.toString().orEmpty(),
                playedAt = System.currentTimeMillis(),
            ))
        } catch (error: Exception) {
            recentMusicObserver.recordFailed()
            // Playback continues; the bridge rejects instead of presenting stale data as success.
            Log.e("OrpheusMusicService", "Recent music history could not be saved", error)
        }
        trackEventListeners.forEach { it.onRecentMusicHistoryChanged() }
    }

    private fun setupListeners() {
        player?.addListener(object : Player.Listener {
            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                if (playWhenReady && enforceAccountSession()) return
                if (playWhenReady && PlaybackNetworkPolicy.blocked() && enforcePlaybackNetworkPolicy()) return
                if (replacingPlayback || auditionReturn != null) return
                if (!playWhenReady && reason == Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM) {
                    if (sleepTimerManager?.onPartEnded() == true) {
                        // pauseAtEndOfMediaItems stops before transition, so the usual
                        // transition/STATE_ENDED completion paths may not run for this P.
                        player?.currentMediaItem?.let { item ->
                            resolveDurationMs(item)?.let { duration ->
                                resumeSaved(item.playbackSourceId(), TrackResumeStorage.complete(item.playbackSourceId(), duration / 1000.0, playbackMode == "listening"))
                            }
                        }
                    }
                } else if (playWhenReady) {
                    sleepTimerManager?.expireIfDue()
                }
            }

            override fun onIsPlayingChanged(isPlaying: Boolean) {
                android.util.Log.d("StatusBarLyrics", "[Service] onIsPlayingChanged: $isPlaying | state=${player?.playbackState} mediaId=${player?.currentMediaItem?.mediaId}")
                lyricsManager.setPlaybackState(isPlaying)
                if (isPlaying) {
                    serviceHandler.removeCallbacks(lyricsUpdateRunnable)
                    serviceHandler.post(lyricsUpdateRunnable)
                    serviceHandler.removeCallbacks(resumeSaveRunnable)
                    serviceHandler.post(resumeSaveRunnable)
                    sendTrackResumedEvent()
                } else {
                    serviceHandler.removeCallbacks(lyricsUpdateRunnable)
                    serviceHandler.removeCallbacks(resumeSaveRunnable)
                    saveCurrentResumeRecord()
                    sendTrackPausedEvent()
                }
                if (!replacingPlayback) WidgetRenderer.updateAll(this@OrpheusMusicService)
            }

            @OptIn(UnstableApi::class)
            override fun onMediaItemTransition(
                mediaItem: androidx.media3.common.MediaItem?,
                reason: Int
            ) {
                val mediaId = mediaItem?.mediaId
                recentMusicObserver.transition(mediaId, reason == Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT)
                if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT) musicQueueRemoval.queueChanged()
                musicQueueRemoval.observe(playbackMode, fm != null || auditionReturn != null,
                    shuffleManager.isEnabled || (player?.shuffleModeEnabled == true), mediaId,
                    player?.let { p -> List(p.mediaItemCount) { p.getMediaItemAt(it).mediaId } } ?: emptyList())
                if (!replacingPlayback) reconcileListeningSleepTimer()
                if (!replacingPlayback && (mediaId != currentMediaId || reason == Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT)) {
                    // Observe each visit, not just the final identity in onEvents:
                    // A→B→A (and repeating A) must retire the original A's buttons.
                    widgetStamp = WidgetStamp.create()
                    widgetStampDurable = false
                }
                val reasonStr = when (reason) {
                    Player.MEDIA_ITEM_TRANSITION_REASON_AUTO -> "AUTO"
                    Player.MEDIA_ITEM_TRANSITION_REASON_SEEK -> "SEEK"
                    Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED -> "PLAYLIST_CHANGED"
                    Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT -> "REPEAT"
                    else -> "UNKNOWN($reason)"
                }
                android.util.Log.d("StatusBarLyrics", "[Service] onMediaItemTransition: id=$mediaId reason=$reasonStr ts=${System.currentTimeMillis()}")

                // If the same track is still current (e.g. an item was added/removed elsewhere
                // in the queue causing a PLAYLIST_CHANGED transition with the same media ID),
                // we should NOT reset lyrics or notify JS as it causes a UI flash and audio stutter.
                if (reason != Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT && mediaId == currentMediaId) {
                    Log.d("OrpheusMusicService", "Ignoring onMediaItemTransition as track hasn't changed.")
                    saveCurrentQueue()
                    return
                }
                currentMediaId = mediaId

                // 自然循环到同一音频：清除该音频断点，从头播放
                if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT && auditionReturn == null) {
                    mediaItem?.let { TrackResumeStorage.clear(it.playbackSourceId(), playbackMode == "listening") }
                } else {
                    applyTrackResume(mediaItem)
                }

                sendTrackStartEvent(mediaItem, reason)

                lyricsManager.clearConsumers(LyricsConsumer.all())
                lyricsManager.setPlaybackState(player?.isPlaying == true)
                floatingLyricsManager.syncTrackInfo()

                saveCurrentQueue()
                val uri = mediaItem?.localConfiguration?.uri?.toString() ?: return

                val volumeData = LoudnessStorage.getLoudnessData(uri)
                applyVolumeForCurrentItem(volumeData)
            }

            override fun onShuffleModeEnabledChanged(shuffleModeEnabled: Boolean) {
                musicQueueRemoval.queueChanged()
            }

            override fun onTimelineChanged(timeline: Timeline, reason: Int) {
                if (reason == Player.TIMELINE_CHANGE_REASON_PLAYLIST_CHANGED) musicQueueRemoval.queueChanged()
                saveCurrentQueue()
                val player = player ?: return
                val currentItem = player.currentMediaItem ?: return
                val duration = player.duration
                if (duration != C.TIME_UNSET && duration > 0) {
                    durationCache[currentItem.mediaId] = duration
                }
            }

            override fun onEvents(player: Player, events: Player.Events) {
                if (!replacingPlayback) recordRecentMusicPlayback(player)
                if (!replacingPlayback) WidgetRenderer.updateAll(this@OrpheusMusicService)
            }

            override fun onPlaybackParametersChanged(playbackParameters: androidx.media3.common.PlaybackParameters) {
                persistPlaybackSnapshot()
            }

            @OptIn(UnstableApi::class)
            override fun onPositionDiscontinuity(
                oldPosition: Player.PositionInfo,
                newPosition: Player.PositionInfo,
                reason: Int
            ) {
                if (replacingPlayback || auditionReturn != null) return
                val isAutoTransition = reason == Player.DISCONTINUITY_REASON_AUTO_TRANSITION
                val isIndexChanged = oldPosition.mediaItemIndex != newPosition.mediaItemIndex
                val trackChanged = oldPosition.mediaItem?.mediaId != newPosition.mediaItem?.mediaId
                val lastMediaItem = oldPosition.mediaItem ?: return
                val currentTime = System.currentTimeMillis()

                // Debounce
                if ((currentTime - lastTrackFinishedAt) < 200) {
                    return
                }

                if (trackChanged) {
                    // 离开当前音频：使用离开时的位置补存旧音频，绝不能把新音频的位置写给旧音频
                    val oldDuration = durationCache[lastMediaItem.mediaId]
                    if (isAutoTransition) {
                        durationCache[lastMediaItem.mediaId]?.let {
                            resumeSaved(lastMediaItem.playbackSourceId(), TrackResumeStorage.complete(lastMediaItem.playbackSourceId(), it / 1000.0, playbackMode == "listening"))
                        }
                    } else {
                        saveResumeRecordFor(
                            lastMediaItem.playbackSourceId(),
                            oldPosition.positionMs,
                            oldDuration
                        )
                    }
                } else if (reason == Player.DISCONTINUITY_REASON_SEEK ||
                    reason == Player.DISCONTINUITY_REASON_SEEK_ADJUSTMENT
                ) {
                    // 同一音频内手动跳转：登记一次新位置
                    saveCurrentResumeRecord()
                }

                if (isAutoTransition || isIndexChanged) {
                    val duration = durationCache[lastMediaItem.mediaId] ?: return
                    lastTrackFinishedAt = currentTime

                    sendTrackFinishedEvent(
                        lastMediaItem.mediaId,
                        oldPosition.positionMs / 1000.0,
                        duration / 1000.0
                    )
                }
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState == Player.STATE_ENDED && auditionReturn == null) {
                    if (!replacingPlayback) sleepTimerManager?.onPartEnded()
                    // 队列最后一首自然播放完毕：清除断点
                    serviceHandler.removeCallbacks(resumeSaveRunnable)
                    player?.currentMediaItem?.let { item ->
                        resolveDurationMs(item)?.let { duration ->
                            resumeSaved(item.playbackSourceId(), TrackResumeStorage.complete(item.playbackSourceId(), duration / 1000.0, playbackMode == "listening"))
                        }
                    }
                    persistPlaybackSnapshot()
                } else if (playbackState == Player.STATE_IDLE) {
                    serviceHandler.removeCallbacks(resumeSaveRunnable)
                }
            }
        })
    }

    private fun saveCurrentQueue() {
        if (replacingPlayback || auditionReturn != null) return
        val player = player ?: return
        val queue = List(player.mediaItemCount) { i -> player.getMediaItemAt(i) }
        if (queue.isNotEmpty()) {
            GeneralStorage.saveQueue(queue)
        }
        persistPlaybackSnapshot()
    }

    /**
     * 保存当前音频和活动会话。手动回到开头也要覆盖旧断点。
     */
    fun saveCurrentResumeRecord() {
        if (replacingPlayback || auditionReturn != null) return
        val player = player ?: return
        persistPlaybackSnapshot()
        WidgetRenderer.updateAll(this)
        val item = player.currentMediaItem ?: return
        val durationMs = resolveDurationMs(item) ?: return
        GeneralStorage.savePosition(player.currentMediaItemIndex, player.currentPosition)
        resumeSaved(item.playbackSourceId(), TrackResumeStorage.save(item.playbackSourceId(), player.currentPosition / 1000.0, durationMs / 1000.0, playbackMode == "listening"))
    }

    private fun resumeSaved(sourceId: String, saved: Boolean) {
        if (playbackMode != "listening") return
        val next = expo.modules.orpheus.util.ListeningResumeOverrides.afterSave(listeningResumeBlocked, sourceId, saved)
        if (next != listeningResumeBlocked) {
            listeningResumeBlocked = next
            listeningResumeOverrides = listeningResumeOverrides - sourceId
            persistPlaybackSnapshot()
        }
    }

    private fun saveResumeRecordFor(sourceId: String?, positionMs: Long, durationMs: Long?) {
        if (auditionReturn != null || sourceId == null || durationMs == null || durationMs <= 0) return
        resumeSaved(sourceId, TrackResumeStorage.save(sourceId, positionMs / 1000.0, durationMs / 1000.0, playbackMode == "listening"))
    }

    private fun resolveDurationMs(item: MediaItem): Long? {
        val current = player?.duration ?: C.TIME_UNSET
        if (current != C.TIME_UNSET && current > 0) return current
        val cached = durationCache[item.mediaId]
        return if (cached != null && cached > 0) cached else null
    }

    /**
     * 进入新音频时按续播策略应用断点。同一音频的队列/元数据变化不会走到这里。
     */
    @OptIn(UnstableApi::class)
    private fun applyTrackResume(mediaItem: MediaItem?) {
        if (replacingPlayback || auditionReturn != null) return
        val player = player ?: return
        if (mediaItem == null) return
        if (TrackResumeStorage.getStrategy() != TrackResumeStorage.STRATEGY_PODCAST) return
        val sourceId = mediaItem.playbackSourceId()
        val restored = listeningResumeOverrides[sourceId]
        if (playbackMode == "listening" && restored != null) {
            // Only a new explicit queue carries these positions. Restore itself never touches the player.
            player.seekTo((restored * 1000).toLong())
            saveCurrentResumeRecord()
            persistPlaybackSnapshot()
            return
        }
        val record = TrackResumeStorage.get(sourceId, playbackMode == "listening") ?: return
        if (record.completed) return
        val targetMs = (record.position * 1000).toLong()
        if (targetMs <= 0) return
        player.seekTo(targetMs)
    }

    private fun validSession(session: PlaybackSessionSnapshot): Boolean = PlaybackSessionCodec.validSession(session)

    fun playbackSnapshot(): PlaybackSessionSnapshot {
        val current = player
        val tracks = current?.let { p ->
            List(p.mediaItemCount) { p.getMediaItemAt(it) }.mapNotNull { extractTrackRecord(it) }
        } ?: emptyList()
        val duration = current?.duration?.takeIf { it != C.TIME_UNSET && it > 0 }?.div(1000.0)
            ?: tracks.firstOrNull { it.id == current?.currentMediaItem?.mediaId }?.duration ?: 0.0
        val currentId = current?.currentMediaItem?.mediaId
        val currentSourceId = tracks.firstOrNull { it.id == currentId }?.let { it.sourceId ?: it.id }
        val position = if (currentId == null) 0.0 else (current?.currentPosition ?: 0L).coerceAtLeast(0) / 1000.0
        return PlaybackSessionSnapshot(
            playbackMode, tracks, currentSourceId,
            if (duration > 0) position.coerceAtMost(duration) else position,
            duration, current?.playbackParameters?.speed ?: 1f,
            current?.isPlaying == true, System.currentTimeMillis(), currentId,
            playWhenReady = current?.playWhenReady == true,
            repeatMode = current?.repeatMode ?: Player.REPEAT_MODE_OFF,
            shuffleEntryIds = shuffleManager.getTraversalOrder()?.map { tracks[it].id },
            listeningResumeOverrides = listeningResumeOverrides,
            listeningResumeBlocked = listeningResumeBlocked,
        )
    }

    fun playbackSnapshotMap(): Map<String, Any?> {
        // Expiration may pause the player, so read timer before capturing the playback fields.
        val timer = sleepTimerManager?.listeningSnapshot()
        return snapshotMap(playbackSnapshot()) + mapOf(
            "auditionId" to auditionId,
            "sleepTimer" to timer,
            "musicQueueUndo" to musicQueueUndoSnapshot(),
            "inactiveSession" to inactiveSession?.let { snapshotMap(it) },
            "fm" to fm?.let { mapOf("id" to it.id, "returnMode" to it.returnMode,
                "manualMusic" to it.manualMusic?.let { saved -> snapshotMap(saved) },
                "returnListening" to it.returnListening?.let { saved -> snapshotMap(saved) }) },
            "persistenceError" to playbackPersistenceError,
            "sessionStorageUnreadable" to sessionStorageUnreadable,
            "resumePoints" to TrackResumeStorage.getAll(listening = true).filterNot {
                expo.modules.orpheus.util.ListeningResumeOverrides.isBlocked(it.id, listeningResumeBlocked, inactiveSession, fm)
            }.map {
                mapOf("sourceId" to it.id, "positionSeconds" to it.position,
                    "durationSeconds" to it.duration, "completed" to it.completed, "updatedAt" to it.updatedAt)
            },
        )
    }

    private fun snapshotMap(snapshot: PlaybackSessionSnapshot): Map<String, Any?> = mapOf(
        "mode" to snapshot.mode, "tracks" to snapshot.tracks.map {
            mapOf("id" to it.id, "sourceId" to (it.sourceId ?: it.id), "url" to it.url, "title" to it.title,
                "artist" to it.artist, "artwork" to it.artwork, "duration" to it.duration)
        },
        "currentEntryId" to snapshot.currentEntryId, "currentSourceId" to snapshot.currentSourceId, "positionSeconds" to snapshot.positionSeconds,
        "durationSeconds" to snapshot.durationSeconds, "speed" to snapshot.speed,
        "playing" to snapshot.playing, "updatedAt" to snapshot.updatedAt,
        "playWhenReady" to snapshot.playWhenReady, "repeatMode" to snapshot.repeatMode,
        "shuffleEntryIds" to snapshot.shuffleEntryIds,
    )

    private fun persistPlaybackSnapshot() {
        if (replacingPlayback || auditionReturn != null || sessionStorageUnreadable) return
        runCatching { PlaybackSessionStorage.save(storedPlaybackSnapshot()) }
            .onSuccess { playbackPersistenceError = null; widgetStampDurable = true }
            .onFailure {
                widgetStampDurable = false
                playbackPersistenceError = it.message ?: it.javaClass.simpleName
                Log.e("Orpheus", "Failed to persist playback snapshot; keeping live playback", it)
            }
    }

    private fun storedPlaybackSnapshot(): StoredPlaybackSessions = StoredPlaybackSessions(
        playbackSnapshot(), inactiveSession, widgetStamp = widgetStamp, fm = fm)

    /** Called on Main before IO preflight: a current-row tap must not reopen its network stream. */
    fun canResumeMusicSelection(tracks: List<TrackRecord>, entryId: String): Boolean =
        !sessionStorageUnreadable && fm == null && auditionReturn == null &&
            ensurePlayer().playbackState != Player.STATE_ENDED &&
            MusicPlaybackOrder.canResume(playbackSnapshot(), tracks, entryId)

    fun resumeCurrentMusic(shouldPlay: Boolean): Map<String, Any?> {
        val previous = playbackSnapshot()
        val current = ensurePlayer()
        if (current.playbackState == Player.STATE_IDLE || current.playerError != null) current.prepare()
        current.playWhenReady = shouldPlay && OrpheusConfig.hasPlaybackAccess()
        persistPlaybackSnapshot()
        return mapOf("previous" to snapshotMap(previous), "current" to playbackSnapshotMap())
    }

    fun replacePlayback(target: PlaybackSessionSnapshot, fmContextId: String? = null): Map<String, Any?> {
        check(auditionReturn == null) { "请先结束候选试听，再更换播放队列。" }
        require(validSession(target) && target.tracks.isNotEmpty()) { "Invalid playback session" }
        saveCurrentResumeRecord()
        val previous = storedPlaybackSnapshot()
        val selected = if (fm == null && fmContextId == null && ensurePlayer().playbackState != Player.STATE_ENDED)
            MusicPlaybackOrder.retainCurrentPosition(previous.active, target) else target
        return commitPlaybackState(FmPlaybackSessions.replace(previous, selected, fmContextId))
    }

    fun switchMusicPart(target: TrackRecord, expectedCurrentEntryId: String, expectedSourceId: String): Map<String, Any?> {
        check(!sessionStorageUnreadable) { "原播放记录无法读取，暂不能切换分 P。" }
        check(auditionReturn == null) { "请先结束候选试听，再切换分 P。" }
        val previous = storedPlaybackSnapshot()
        val next = MusicPartSwitch.replace(previous, target, expectedCurrentEntryId, expectedSourceId)
        if (next === previous) return mapOf("previous" to snapshotMap(previous.active), "current" to playbackSnapshotMap())
        saveCurrentResumeRecord()
        return commitPlaybackState(next)
    }

    fun startFm(tracks: List<TrackRecord>): Map<String, Any?> {
        check(auditionReturn == null) { "请先结束候选试听。" }
        saveCurrentResumeRecord()
        return commitPlaybackState(FmPlaybackSessions.start(storedPlaybackSnapshot(), tracks))
    }

    fun fmReturnTarget(fmId: String): PlaybackSessionSnapshot =
        FmPlaybackSessions.returnTarget(storedPlaybackSnapshot(), fmId)

    fun exitFm(fmId: String): Map<String, Any?> {
        check(auditionReturn == null) { "请先结束候选试听。" }
        saveCurrentResumeRecord()
        return commitPlaybackState(FmPlaybackSessions.exit(storedPlaybackSnapshot(), fmId))
    }

    /** Main-thread transaction: prewrite the paused original before touching the live player. */
    fun startCandidateAudition(track: TrackRecord, token: Long): Map<String, Any?> {
        check(!sessionStorageUnreadable) { "原播放记录无法读取，暂不能试听。" }
        val wasDurable = widgetStampDurable
        replacingPlayback = true
        try {
            audition.start(track, token, ::storedPlaybackSnapshot, PlaybackSessionStorage::save, ::applyPlaybackState)
        } finally {
            replacingPlayback = false
            widgetStampDurable = auditionReturn == null && wasDurable
            trackEventListeners.forEach { it.onPlaybackSessionChanged() }
            WidgetRenderer.updateAll(this)
        }
        return playbackSnapshotMap()
    }

    fun endCandidateAudition(expectedId: String): Map<String, Any?> {
        val wasDurable = widgetStampDurable
        var restored = false
        replacingPlayback = true
        try {
            restored = audition.end(expectedId, { PlaybackReplacementGuard.shared.cancel() }, ::applyPlaybackState)
        } finally {
            replacingPlayback = false
            widgetStampDurable = auditionReturn == null && (restored || wasDurable)
            trackEventListeners.forEach { it.onPlaybackSessionChanged() }
        }
        reconcileListeningSleepTimer()
        WidgetRenderer.updateAll(this)
        return playbackSnapshotMap()
    }

    fun cancelCandidateAudition(token: Long) {
        if (audition.ownedBy(token)) auditionId?.let { endCandidateAudition(it) }
    }

    /** Internal restore does not enter the module/MediaSession transport cancellation paths. */
    private fun applyPlaybackState(state: StoredPlaybackSessions) {
        val current = ensurePlayer()
        val target = state.active
        current.pause()
        playbackMode = target.mode
        listeningResumeOverrides = target.listeningResumeOverrides
        listeningResumeBlocked = target.listeningResumeBlocked
        inactiveSession = state.inactive
        fm = state.fm
        widgetStamp = requireNotNull(state.widgetStamp)
        if (auditionReturn == null) TrackResumeStorage.setStrategy(if (target.mode == "listening") TrackResumeStorage.STRATEGY_PODCAST else TrackResumeStorage.STRATEGY_NONE)
        if (target.tracks.isEmpty()) current.clearMediaItems()
        else current.setMediaItems(target.tracks.map { it.toMediaItem(this) },
            target.tracks.indexOfFirst { it.id == target.currentEntryId }, (target.positionSeconds * 1000).toLong())
        current.setPlaybackSpeed(target.speed)
        shuffleManager.restoreEntryOrder(target.shuffleEntryIds, persistPreference = auditionReturn == null)
        current.repeatMode = target.repeatMode
        current.playWhenReady = OrpheusConfig.hasPlaybackAccess() && target.tracks.isNotEmpty() && target.playWhenReady
        if (target.tracks.isNotEmpty() && OrpheusConfig.hasPlaybackAccess()) current.prepare()
        currentMediaId = current.currentMediaItem?.mediaId
    }

    private fun commitPlaybackState(next: StoredPlaybackSessions): Map<String, Any?> {
        require(PlaybackSessionCodec.validStored(next)) { "Invalid native playback state" }
        val previous = storedPlaybackSnapshot()
        // Queue, backups, context and stamp share the same prewrite before any live change.
        PlaybackSessionStorage.save(next)
        sessionStorageUnreadable = false
        playbackPersistenceError = null
        musicQueueRemoval.queueChanged()
        replacingPlayback = true
        try {
            applyPlaybackState(next)
            widgetStampDurable = true
            next.active.tracks.firstOrNull { it.id == next.active.currentEntryId }?.let { selected ->
                resumeSaved(selected.sourceId ?: selected.id, TrackResumeStorage.save(selected.sourceId ?: selected.id, next.active.positionSeconds,
                    selected.duration ?: 0.0, next.active.mode == "listening"))
            }
        } catch (failure: Exception) {
            runCatching {
                applyPlaybackState(previous)
                PlaybackSessionStorage.save(previous)
                widgetStampDurable = true
            }.onFailure { widgetStampDurable = false; failure.addSuppressed(it) }
            throw failure
        } finally {
            replacingPlayback = false
        }
        reconcileListeningSleepTimer()
        val current = ensurePlayer()
        GeneralStorage.saveQueue(List(current.mediaItemCount) { current.getMediaItemAt(it) })
        GeneralStorage.savePosition(current.currentMediaItemIndex, current.currentPosition)
        WidgetRenderer.updateAll(this)
        return mapOf("previous" to snapshotMap(previous.active), "current" to playbackSnapshotMap())
    }

    fun appendFm(tracks: List<TrackRecord>, fmId: String, tail: String): Map<String, Any?> {
        if (auditionReturn != null || PlaybackReplacementGuard.shared.isPending())
            return mapOf("applied" to false, "current" to playbackSnapshotMap())
        val previous = storedPlaybackSnapshot()
        val next = FmPlaybackSessions.append(previous, tracks, fmId, tail)
            ?: return mapOf("applied" to false, "current" to playbackSnapshotMap())
        PlaybackSessionStorage.save(next)
        replacingPlayback = true
        try {
            if (playbackMode == "music") ensurePlayer().addMediaItems(tracks.map { it.toMediaItem(this) })
            inactiveSession = next.inactive
            widgetStampDurable = true
            playbackPersistenceError = null
        } catch (failure: Exception) {
            runCatching {
                val current = ensurePlayer()
                if (playbackMode == "music" && current.mediaItemCount > previous.active.tracks.size)
                    current.removeMediaItems(previous.active.tracks.size, current.mediaItemCount)
                inactiveSession = previous.inactive
                PlaybackSessionStorage.save(previous)
                widgetStampDurable = true
            }.onFailure { widgetStampDurable = false; failure.addSuppressed(it) }
            throw failure
        } finally {
            replacingPlayback = false
        }
        WidgetRenderer.updateAll(this)
        return mapOf("applied" to true, "current" to playbackSnapshotMap())
    }

    fun widgetFrame(): WidgetPlaybackFrame {
        val current = player
        val item = current?.currentMediaItem
        val track = item?.let { extractTrackRecord(it) }
        val duration = item?.let { resolveDurationMs(it) } ?: track?.duration
            ?.takeIf { it.isFinite() && it > 0 && it <= Long.MAX_VALUE / 1000.0 }?.let { (it * 1000).toLong() } ?: 0L
        val position = (current?.currentPosition ?: 0L).coerceAtLeast(0)
        val wrap = current?.repeatMode == Player.REPEAT_MODE_ONE && (current.mediaItemCount > 0)
        return WidgetPlaybackFrame(playbackMode, item?.mediaId,
            widgetStamp.takeIf { widgetStampDurable && auditionReturn == null }, track?.title ?: "音绘 · 随时继续", track?.artist ?: "",
            if (duration > 0) position.coerceAtMost(duration) else position, duration,
            current?.playWhenReady == true, track?.artwork,
            current?.hasPreviousMediaItem() == true || wrap, current?.hasNextMediaItem() == true || wrap)
    }

    /** Called only from this service's main-thread start dispatch. No preflight TOCTOU. */
    private fun executeWidgetCommand(command: WidgetCommand): Boolean {
        if (instance !== this) return false
        if (!OrpheusConfig.hasPlaybackAccess() && command.action != "pause") return false
        val current = player ?: return false
        return command.execute(widgetFrame(), consumePlay = {
            // Check the durable active too: cached display/playing flags never authorize playback.
            val stored = PlaybackSessionStorage.get()
            check(stored != null && stored.widgetStamp == command.stamp && stored.active.mode == command.mode &&
                stored.active.currentEntryId == command.entryId) { "Widget playback context has expired" }
            val nextStamp = WidgetStamp.create()
            // Consume exactly once before any audible side effect. A write failure
            // leaves both old queues/position and the old stamp untouched.
            PlaybackSessionStorage.save(storedPlaybackSnapshot().copy(widgetStamp = nextStamp))
            widgetStamp = nextStamp
            widgetStampDurable = true
        }, cancelPreparation = { PlaybackReplacementGuard.shared.cancel() }, transport = {
            when (command.action) {
            "play" -> {
                if (current.playbackState == Player.STATE_ENDED) current.seekTo(0)
                if (current.playbackState == Player.STATE_IDLE) current.prepare()
                current.play()
            }
            "pause" -> current.pause()
            "previous" -> {
                if (!current.hasPreviousMediaItem() && current.repeatMode == Player.REPEAT_MODE_ONE && current.mediaItemCount > 0)
                    current.seekTo(current.mediaItemCount - 1, C.TIME_UNSET)
                else if (current.hasPreviousMediaItem()) current.seekToPreviousMediaItem()
            }
            "next" -> {
                if (!current.hasNextMediaItem() && current.repeatMode == Player.REPEAT_MODE_ONE && current.mediaItemCount > 0)
                    current.seekTo(0, C.TIME_UNSET)
                else if (current.hasNextMediaItem()) current.seekToNext()
            }
            "back15", "forward15" -> current.seekTo(WidgetCommand.seekPosition(
                current.currentPosition, widgetFrame().durationMs, command.action == "forward15"))
            }
            saveCurrentResumeRecord()
        })
    }


    fun createStatusBarBackend(provider: String): expo.modules.orpheus.manager.StatusBarLyricsBackend {
        return when {
            provider == "lyricon" && android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O_MR1 -> {
                LyriconBackend(this)
            }
            provider == "meizu" -> {
                MeizuStatusBarLyricsBackend(this)
            }
            else -> {
                SuperLyricBackend(this)
            }
        }
    }

    fun setCarLyricsEnabled(enabled: Boolean) {
        lyricsManager.setCarLyricsEnabled(enabled)
    }

    fun setCarLyrics(lyrics: List<LyricsLine>, offset: Double = 0.0) {
        lyricsManager.submitLyrics(
            LyricsData(lyrics = lyrics, offset = offset),
            setOf(LyricsConsumer.CAR),
        )
    }

    fun clearCarLyrics() {
        lyricsManager.clearConsumers(setOf(LyricsConsumer.CAR))
    }

    private fun updateCurrentMetadata(currentLyric: String?) {
        val player = player ?: return
        val currentIndex = player.currentMediaItemIndex
        if (currentIndex == C.INDEX_UNSET || currentIndex >= player.mediaItemCount) return

        val currentItem = player.getMediaItemAt(currentIndex)
        val updatedMetadata = buildPlaybackMetadata(currentItem, currentLyric)
        if (currentItem.mediaMetadata == updatedMetadata) return

        val updatedItem = currentItem.buildUpon()
            .setMediaMetadata(updatedMetadata)
            .build()

        // Lyric-only metadata refresh should not trigger extra queue persistence.
        player.replaceMediaItem(currentIndex, updatedItem)
    }

    private fun buildPlaybackMetadata(item: MediaItem, currentLyric: String?): MediaMetadata {
        val originalTrack = extractTrackRecord(item)
        val baseTitle = originalTrack?.title ?: item.mediaMetadata.title?.toString().orEmpty()
        val baseArtist = originalTrack?.artist ?: item.mediaMetadata.artist?.toString().orEmpty()
        val displayArtist = listOf(baseTitle, baseArtist)
            .filter { it.isNotBlank() }
            .joinToString(" - ")

        return MediaMetadata.Builder()
            .setTitle(currentLyric?.takeIf { it.isNotBlank() } ?: baseTitle)
            .setArtist(
                if (currentLyric.isNullOrBlank()) {
                    baseArtist
                } else {
                    displayArtist
                }
            )
            .setArtworkUri(item.mediaMetadata.artworkUri)
            .setExtras(item.mediaMetadata.extras)
            .build()
    }

    private fun extractTrackRecord(item: MediaItem): TrackRecord? {
        val trackJson = item.mediaMetadata.extras?.getString("track_json") ?: return null
        return try {
            json.decodeFromString<TrackRecord>(trackJson)
        } catch (_: Exception) {
            null
        }
    }

    @OptIn(UnstableApi::class)
    private fun applyVolumeForCurrentItem(measuredI: Double) {
        Log.d("LoudnessNormalization", "measuredI: $measuredI")
        val player = player ?: return
        volumeFadeJob?.cancel()
        val isLoudnessNormalizationEnabled = GeneralStorage.isLoudnessNormalizationEnabled()
        if (!isLoudnessNormalizationEnabled) return
        val gain = run {
            val target = -14.0 // bilibili 的这个值似乎是固定的
            if (measuredI == 0.0) 1.0f else calculateLoudnessGain(measuredI, target)
        }

        val targetVol = 1.0f * gain
        val currentVolume = player.volume

        if (abs(currentVolume - targetVol) < 0.001f) {
            return
        }

        volumeFadeJob = player.fadeInTo(targetVol, 600L, scope)
    }
}
