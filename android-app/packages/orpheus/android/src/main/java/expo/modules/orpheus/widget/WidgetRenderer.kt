package expo.modules.orpheus.widget

import android.appwidget.AppWidgetManager
import android.content.Context
import android.graphics.*
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.widget.RemoteViews
import com.bumptech.glide.Glide
import expo.modules.orpheus.R
import expo.modules.orpheus.service.OrpheusMusicService
import expo.modules.orpheus.util.PlaybackSessionStorage
import java.util.concurrent.Executors

object WidgetRenderer {
    private val main = Handler(Looper.getMainLooper())
    private val artworkExecutor = Executors.newSingleThreadExecutor()
    private var artworkBusy = false
    private var artworkKey: String? = null
    private var artworkBitmap: Bitmap? = null
    private var failedArtworkKey: String? = null

    fun updateAll(context: Context) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            main.post { updateAll(context.applicationContext) }
            return
        }
        val ids = MeloWidgetProvider.ids(context)
        if (ids.isEmpty()) return
        val frame = OrpheusMusicService.instance?.widgetFrame() ?: runCatching {
            PlaybackSessionStorage.initialize(context)
            val stored = PlaybackSessionStorage.get()
            val active = stored?.active
            val current = active?.tracks?.firstOrNull { it.id == active.currentEntryId }
            if (active == null || current == null) emptyFrame()
            else {
                val navigation = WidgetQueueNavigation.fromSaved(
                    active.tracks.map { it.id }, current.id, active.repeatMode, active.shuffleEntryIds,
                )
                WidgetPlaybackFrame(active.mode, current.id, stored?.widgetStamp,
                    current.title ?: "未命名音源", current.artist ?: "", (active.positionSeconds * 1000).toLong(),
                    (active.durationSeconds * 1000).toLong(), false, current.artwork,
                    navigation.hasPrevious, navigation.hasNext)
            }
        }.getOrElse { Log.w("MeloWidget", "Cannot read saved widget content", it); emptyFrame() }
        val theme = runCatching { WidgetThemeStore.load(context) }.getOrElse {
            Log.w("MeloWidget", "Using built-in widget fallback", it); null
        } ?: WidgetThemeProjection.modern
        val manager = AppWidgetManager.getInstance(context)
        for (id in ids) {
            runCatching {
                val options = manager.getAppWidgetOptions(id)
                val defaultHeight = if (manager.getAppWidgetInfo(id)?.provider?.className == MeloLargeWidgetProvider::class.java.name) 180 else 72
                val large = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, defaultHeight) >= 180
                manager.updateAppWidget(id, views(context, id, frame, theme, large))
            }.onFailure { Log.e("MeloWidget", "Widget $id render failed", it) }
        }
        requestArtwork(context.applicationContext, frame.artwork)
    }

    private fun emptyFrame() = WidgetPlaybackFrame("music", null, null, "音绘 · 随时继续", "轻触打开播放器", 0, 0, false)

    private fun views(context: Context, id: Int, frame: WidgetPlaybackFrame, theme: WidgetThemeProjection, large: Boolean): RemoteViews {
        val views = RemoteViews(context.packageName, if (large) R.layout.melo_widget_large else R.layout.melo_widget_compact)
        val primary = Color.parseColor(theme.colors.getValue("textPrimary"))
        val secondary = Color.parseColor(theme.colors.getValue("textSecondary"))
        val accent = Color.parseColor(theme.colors.getValue("accent"))
        views.setImageViewBitmap(R.id.melo_widget_background, background(theme, large))
        views.setTextViewText(R.id.melo_widget_title, frame.title)
        views.setTextViewText(R.id.melo_widget_subtitle, listOf(if (frame.mode == "listening") "听视频" else "音乐", frame.subtitle).filter { it.isNotBlank() }.joinToString(" · "))
        views.setTextColor(R.id.melo_widget_title, primary)
        views.setTextColor(R.id.melo_widget_subtitle, secondary)
        views.setContentDescription(R.id.melo_widget_open, "打开音绘播放器 ${frame.title} ${frame.subtitle}")
        if (context.resources.configuration.fontScale >= 1.4f) {
            views.setViewVisibility(R.id.melo_widget_subtitle, View.GONE)
            views.setInt(R.id.melo_widget_title, "setMaxLines", 1)
        } else {
            views.setViewVisibility(R.id.melo_widget_subtitle, View.VISIBLE)
            views.setInt(R.id.melo_widget_title, "setMaxLines", if (large) 2 else 1)
        }
        WidgetIntents.open(context)?.let { views.setOnClickPendingIntent(R.id.melo_widget_open, it) }
        views.setImageViewBitmap(R.id.melo_widget_cover,
            artworkBitmap?.takeIf { artworkKey == frame.artwork } ?: placeholder(theme))
        views.setImageViewBitmap(R.id.melo_widget_play_background, button(theme, accent))
        views.setImageViewResource(R.id.melo_widget_play, if (frame.playing) R.drawable.outline_pause_24 else R.drawable.outline_play_arrow_24)
        views.setInt(R.id.melo_widget_play, "setColorFilter", WidgetThemeProjection.playIconColor(theme.colors.getValue("accent")))
        val playable = frame.controlsAvailable
        views.setBoolean(R.id.melo_widget_play, "setEnabled", playable)
        views.setContentDescription(R.id.melo_widget_play, if (frame.playing) "暂停" else "播放")
        WidgetIntents.control(context, id, if (frame.playing) "pause" else "play", frame)?.let {
            views.setOnClickPendingIntent(R.id.melo_widget_play, it)
        }
        if (large) {
            views.setImageViewBitmap(R.id.melo_widget_progress, progress(theme, frame))
            views.setTextViewText(R.id.melo_widget_time, "${time(frame.positionMs)} / ${time(frame.durationMs)}")
            views.setTextColor(R.id.melo_widget_time, secondary)
            views.setContentDescription(R.id.melo_widget_progress_open, "查看播放进度 ${time(frame.positionMs)} / ${time(frame.durationMs)}")
            WidgetIntents.open(context)?.let { views.setOnClickPendingIntent(R.id.melo_widget_progress_open, it) }
            for ((viewId, forward) in listOf(R.id.melo_widget_previous to false, R.id.melo_widget_next to true)) {
                val listening = frame.mode == "listening"
                val action = if (listening) { if (forward) "forward15" else "back15" } else if (forward) "next" else "previous"
                if (listening) views.setImageViewBitmap(viewId, seekIcon(primary, forward))
                else {
                    views.setImageViewResource(viewId, if (forward) R.drawable.outline_skip_next_24 else R.drawable.outline_skip_previous_24)
                }
                views.setInt(viewId, "setColorFilter", primary)
                views.setContentDescription(viewId, if (listening) { if (forward) "前进15秒" else "后退15秒" } else if (forward) "下一首" else "上一首")
                views.setBoolean(viewId, "setEnabled", playable && (listening || if (forward) frame.hasNext else frame.hasPrevious))
                WidgetIntents.control(context, id, action, frame)?.let { views.setOnClickPendingIntent(viewId, it) }
            }
        }
        return views
    }

    private fun background(theme: WidgetThemeProjection, large: Boolean): Bitmap {
        // <=720x360 RGBA (1MiB), independent of launcher/density. No package URI.
        val bitmap = Bitmap.createBitmap(720, if (large) 360 else 144, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        val rect = RectF(7f, 7f, bitmap.width - 12f, bitmap.height - 12f)
        val shape = Path()
        val radii = when (theme.card) {
            "leaf" -> floatArrayOf(48f, 48f, 12f, 12f, 48f, 48f, 12f, 12f)
            "comic" -> FloatArray(8) { 18f }
            else -> FloatArray(8) { 32f }
        }
        shape.addRoundRect(rect, radii, Path.Direction.CW)
        if (theme.card == "comic") {
            canvas.save(); canvas.translate(5f, 5f)
            paint.color = Color.parseColor(theme.colors.getValue("border")); canvas.drawPath(shape, paint); canvas.restore()
        }
        paint.color = Color.parseColor(theme.colors.getValue("card")); canvas.drawPath(shape, paint)
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = if (theme.card == "comic") 3f else 1.5f
        paint.color = Color.parseColor(theme.colors.getValue("border")); canvas.drawPath(shape, paint)
        canvas.save(); canvas.clipPath(shape)
        paint.style = Paint.Style.FILL
        paint.color = Color.parseColor(theme.colors.getValue("accent")); paint.alpha = 24
        if (theme.decoration == "botanical") {
            repeat(5) { i ->
                canvas.save(); canvas.rotate(-35f + i * 8, 625f, 45f + i * 32)
                canvas.drawOval(580f, 18f + i * 30, 690f, 48f + i * 30, paint); canvas.restore()
            }
        } else if (theme.decoration == "stars") {
            repeat(6) { i ->
                val x = 500f + (i % 3) * 70; val y = 22f + (i / 3) * 65
                val star = Path().apply { moveTo(x, y - 10); lineTo(x + 4, y - 3); lineTo(x + 11, y); lineTo(x + 4, y + 3); lineTo(x, y + 10); lineTo(x - 4, y + 3); lineTo(x - 11, y); lineTo(x - 4, y - 3); close() }
                canvas.drawPath(star, paint)
            }
        }
        canvas.restore()
        return bitmap
    }

    private fun button(theme: WidgetThemeProjection, color: Int): Bitmap {
        val bitmap = Bitmap.createBitmap(96, 96, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val path = Path()
        val radii = when (theme.button) { "leaf" -> floatArrayOf(38f,38f,12f,12f,38f,38f,12f,12f); "comic" -> FloatArray(8) { 14f }; else -> FloatArray(8) { 48f } }
        path.addRoundRect(RectF(2f,2f,94f,94f), radii, Path.Direction.CW)
        canvas.drawPath(path, Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color })
        return bitmap
    }

    private fun placeholder(theme: WidgetThemeProjection): Bitmap {
        val bitmap = Bitmap.createBitmap(144, 144, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor(theme.colors.getValue("accent")); alpha = 30 }
        canvas.drawRoundRect(0f, 0f, 144f, 144f, 18f, 18f, paint)
        paint.alpha = 255; paint.textSize = 65f; paint.textAlign = Paint.Align.CENTER
        canvas.drawText("♪", 72f, 94f, paint)
        return bitmap
    }

    private fun progress(theme: WidgetThemeProjection, frame: WidgetPlaybackFrame): Bitmap {
        val bitmap = Bitmap.createBitmap(640, 12, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor(theme.colors.getValue("border")) }
        val end = if (frame.durationMs > 0) (640.0 * frame.positionMs.coerceIn(0, frame.durationMs) / frame.durationMs).toFloat() else 0f
        val radius = if (theme.progress == "anime") 1f else 6f
        canvas.drawRoundRect(0f, 2f, 640f, 10f, radius, radius, paint)
        paint.color = Color.parseColor(theme.colors.getValue("accent"))
        canvas.drawRoundRect(0f, 2f, end, 10f, radius, radius, paint)
        return bitmap
    }

    private fun seekIcon(color: Int, forward: Boolean): Bitmap {
        val bitmap = Bitmap.createBitmap(72, 72, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color; style = Paint.Style.STROKE; strokeWidth = 4f }
        canvas.drawArc(8f, 8f, 64f, 64f, if (forward) 225f else 315f, if (forward) 275f else -275f, false, paint)
        paint.style = Paint.Style.FILL
        val arrow = Path().apply {
            if (forward) { moveTo(56f, 8f); lineTo(56f, 24f); lineTo(40f, 8f) }
            else { moveTo(16f, 8f); lineTo(16f, 24f); lineTo(32f, 8f) }; close()
        }
        canvas.drawPath(arrow, paint)
        paint.textSize = 28f; paint.textAlign = Paint.Align.CENTER
        canvas.drawText("15", 36f, 46f, paint)
        return bitmap
    }

    private fun time(ms: Long): String {
        val seconds = ms.coerceAtLeast(0) / 1000
        return "%d:%02d".format(seconds / 60, seconds % 60)
    }

    private fun requestArtwork(context: Context, uri: String?) {
        if (uri.isNullOrBlank() || uri == artworkKey || uri == failedArtworkKey || artworkBusy) return
        artworkBusy = true
        artworkExecutor.execute {
            var bitmap: Bitmap? = null
            val target = Glide.with(context).asBitmap().load(uri).onlyRetrieveFromCache(true).submit(256, 256)
            try { bitmap = target.get().copy(Bitmap.Config.ARGB_8888, false) }
            catch (_: Exception) { /* Missing artwork uses the real theme placeholder. */ }
            finally { Glide.with(context).clear(target) }
            main.post {
                artworkBusy = false
                if (bitmap != null) { artworkKey = uri; artworkBitmap = bitmap; failedArtworkKey = null }
                else failedArtworkKey = uri
                updateAll(context)
            }
        }
    }

    /** Reuse the existing MediaSession loader's completion, without a Widget network request/timer. */
    fun artworkAvailable(context: Context, uri: String, source: Bitmap) {
        if (MeloWidgetProvider.ids(context).isEmpty()) return
        val scale = minOf(1.0, 256.0 / source.width, 256.0 / source.height)
        val scaled = Bitmap.createScaledBitmap(source, (source.width * scale).toInt().coerceAtLeast(1),
            (source.height * scale).toInt().coerceAtLeast(1), true)
        val copy = scaled.copy(Bitmap.Config.ARGB_8888, false)
        if (scaled !== source) scaled.recycle()
        main.post {
            artworkKey = uri
            artworkBitmap = copy
            failedArtworkKey = null
            updateAll(context.applicationContext)
        }
    }
}
