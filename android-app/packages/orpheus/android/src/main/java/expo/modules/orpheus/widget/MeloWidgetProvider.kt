package expo.modules.orpheus.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.os.Bundle

open class MeloWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        WidgetRenderer.updateAll(context)
    }

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
        WidgetRenderer.updateAll(context)
    }

    companion object {
        fun ids(context: Context): IntArray {
            val manager = AppWidgetManager.getInstance(context)
            return listOf(MeloWidgetProvider::class.java, MeloLargeWidgetProvider::class.java)
                .flatMap { manager.getAppWidgetIds(ComponentName(context, it)).toList() }.toIntArray()
        }

        fun owns(context: Context, id: Int): Boolean = id > 0 && ids(context).contains(id)
    }
}

class MeloLargeWidgetProvider : MeloWidgetProvider()
