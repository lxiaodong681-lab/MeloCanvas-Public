package expo.modules.bbplayernative

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.os.Build
import androidx.annotation.RequiresApi
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer

/** Import-time work only, called on Dispatchers.Default. The player receives small local PNGs. */
internal object ThemeStaticImage {
    fun dimensions(width: Int, height: Int, edge: Int): Pair<Int, Int> {
        require(edge in 32..1280) { "主题图片目标尺寸无效" }
        ThemeBackgroundLayout.checkSize(width, height)
        val scale = minOf(1.0, edge.toDouble() / maxOf(width, height))
        return maxOf(1, (width * scale).toInt()) to maxOf(1, (height * scale).toInt())
    }

    fun normalize(bytes: ByteArray, edge: Int): ByteArray {
        require(bytes.isNotEmpty() && bytes.size <= 8 * 1024 * 1024) { "主题图片不能超过 8 MiB" }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        require(bounds.outMimeType in setOf("image/png", "image/jpeg", "image/webp")) { "仅适配 PNG、JPG、WebP 静态图片" }
        val (width, height) = dimensions(bounds.outWidth, bounds.outHeight, edge)
        var source: Bitmap? = null
        var output: Bitmap? = null
        try {
            source = if (Build.VERSION.SDK_INT >= 28) decodeModern(bytes, width, height) else {
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply {
                    inPreferredConfig = Bitmap.Config.ARGB_8888
                    inScaled = false
                    var sample = 1
                    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= edge) sample *= 2
                    inSampleSize = sample
                })
            }
            requireNotNull(source) { "主题图片无法读取" }
            output = Bitmap.createScaledBitmap(source, width, height, true)
            val png = ByteArrayOutputStream()
            check(output.compress(Bitmap.CompressFormat.PNG, 100, png)) { "主题图片转换失败" }
            return png.toByteArray()
        } finally {
            if (output !== source) output?.recycle()
            source?.recycle()
        }
    }

    @RequiresApi(28)
    private fun decodeModern(bytes: ByteArray, width: Int, height: Int): Bitmap =
        ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(bytes))) { decoder, _, _ ->
            // decodeBitmap freezes the first frame; no animated drawable enters the theme renderer.
            decoder.setTargetSize(width, height)
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            decoder.setOnPartialImageListener { false }
        }
}
