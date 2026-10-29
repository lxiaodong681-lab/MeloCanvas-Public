package expo.modules.orpheus.widget

import android.content.Context
import android.util.AtomicFile
import java.io.File

object WidgetThemeStore {
    private fun file(context: Context) = AtomicFile(File(context.filesDir, "melocanvas-widget-theme-v1.json"))

    @Synchronized
    fun load(context: Context): WidgetThemeProjection? {
        val file = file(context)
        if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) return null
        val raw = file.openRead().use { input ->
            val bytes = ByteArray(8193)
            var count = 0
            while (count < bytes.size) {
                val read = input.read(bytes, count, bytes.size - count)
                if (read < 0) break
                check(read > 0) { "Saved widget theme read made no progress" }
                count += read
            }
            require(count <= 8192) { "Saved widget theme is too large" }
            bytes.copyOf(count).toString(Charsets.UTF_8)
        }
        return WidgetThemeProjection.parse(raw)
    }

    @Synchronized
    fun save(context: Context, raw: String): String {
        val next = WidgetThemeProjection.parse(raw)
        val result = next.updateResult(load(context))
        if (result != "applied") return result
        val file = file(context)
        val stream = file.startWrite()
        try {
            stream.write(next.encode().toByteArray(Charsets.UTF_8))
            file.finishWrite(stream)
        } catch (error: Exception) {
            file.failWrite(stream)
            throw error
        }
        return result
    }
}
