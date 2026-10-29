package expo.modules.orpheus.widget

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import expo.modules.orpheus.service.OrpheusMusicService

object WidgetIntents {
    const val ACTION = "expo.modules.orpheus.WIDGET_CONTROL_V1"

    fun open(context: Context): PendingIntent? {
        val intent = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
        intent.action = Intent.ACTION_VIEW
        intent.data = Uri.parse("melocanvas://player")
        intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    fun control(context: Context, id: Int, action: String, frame: WidgetPlaybackFrame): PendingIntent? {
        val entry = frame.entryId ?: return null
        val stamp = frame.stamp ?: return null
        val intent = Intent(context, OrpheusMusicService::class.java).setAction(ACTION)
        // Extras are not PendingIntent identity. In particular old A→B→A views
        // must never acquire a fresh stamp through FLAG_UPDATE_CURRENT.
        intent.data = Uri.Builder().scheme("melocanvas-widget").authority("control-v1")
            .appendPath(id.toString()).appendPath(action).appendPath(frame.mode).appendPath(entry).appendPath(stamp).build()
        intent.putExtra("widgetId", id).putExtra("command", action).putExtra("expectedMode", frame.mode)
            .putExtra("expectedEntryId", entry).putExtra("widgetStamp", stamp)
        // An old visible button can be clicked after process death. Every user
        // control therefore uses the same bounded foreground-start handshake.
        return PendingIntent.getForegroundService(context, 0, intent, PendingIntent.FLAG_IMMUTABLE)
    }

    fun read(context: Context, intent: Intent): WidgetCommand? {
        if (intent.action != ACTION) return null
        val id = intent.getIntExtra("widgetId", -1)
        if (!MeloWidgetProvider.owns(context, id)) return null
        val command = WidgetCommand(id, intent.getStringExtra("command") ?: return null,
            intent.getStringExtra("expectedMode") ?: return null,
            intent.getStringExtra("expectedEntryId") ?: return null,
            intent.getStringExtra("widgetStamp") ?: return null)
        val expected = Uri.Builder().scheme("melocanvas-widget").authority("control-v1")
            .appendPath(id.toString()).appendPath(command.action).appendPath(command.mode)
            .appendPath(command.entryId).appendPath(command.stamp).build()
        return command.takeIf { intent.data == expected }
    }
}
