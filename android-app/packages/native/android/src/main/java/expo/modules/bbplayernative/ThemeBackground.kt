package expo.modules.bbplayernative

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorSpace
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RectF
import android.os.Build
import androidx.exifinterface.media.ExifInterface
import androidx.annotation.RequiresApi
import java.io.ByteArrayOutputStream
import java.io.ByteArrayInputStream
import java.io.IOException
import java.nio.ByteBuffer

internal object ThemeBackground {
    fun prepare(bytes: ByteArray, baseColor: String, transparency: Double, zoom: Double, horizontal: Double, vertical: Double): ByteArray {
        val overlayAlpha = ThemeBackgroundLayout.overlayAlpha(transparency)
        ThemeBackgroundLayout.checkCrop(zoom, horizontal, vertical)
        require(bytes.isNotEmpty() && bytes.size <= 16 * 1024 * 1024) { "请选择小于 16 MB 的图片" }
        require(Regex("#[0-9a-fA-F]{6}").matches(baseColor)) { "背景配色无效" }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        require(bounds.outMimeType in setOf("image/png", "image/jpeg", "image/webp")) { "请选择 JPG、PNG 或 WebP 图片" }
        ThemeBackgroundLayout.checkSize(bounds.outWidth, bounds.outHeight)
        var source: Bitmap? = null
        var output: Bitmap? = null
        try {
            source = if (Build.VERSION.SDK_INT >= 28) decodeModern(bytes, zoom) else decodeLegacy(bytes, bounds, zoom)
            requireNotNull(source) { "图片无法完整读取，请换一张图片" }
            output = Bitmap.createBitmap(720, 1280, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(output)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
            canvas.drawColor(Color.parseColor(baseColor))
            val frame = ThemeBackgroundLayout.cover(source.width, source.height, zoom, horizontal, vertical)
            canvas.drawBitmap(source, null, RectF(frame[0], frame[1], frame[2], frame[3]), paint)
            paint.color = Color.parseColor(baseColor)
            paint.alpha = overlayAlpha
            canvas.drawRect(0f, 0f, 720f, 1280f, paint)
            val png = ByteArrayOutputStream()
            check(output.compress(Bitmap.CompressFormat.PNG, 100, png)) { "背景生成失败" }
            return png.toByteArray()
        } finally { output?.recycle(); source?.recycle() }
    }

    @RequiresApi(28)
    private fun decodeModern(bytes: ByteArray, zoom: Double): Bitmap =
        ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(bytes))) { decoder, info, _ ->
            ThemeBackgroundLayout.checkSize(info.size.width, info.size.height)
            val scale = minOf(1.0, maxOf(720.0 * zoom / info.size.width, 1280.0 * zoom / info.size.height))
            decoder.setTargetSize(maxOf(1, (info.size.width * scale).toInt()), maxOf(1, (info.size.height * scale).toInt()))
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            decoder.setTargetColorSpace(ColorSpace.get(ColorSpace.Named.SRGB))
            decoder.setOnPartialImageListener { false }
        }

    private fun decodeLegacy(bytes: ByteArray, bounds: BitmapFactory.Options, zoom: Double): Bitmap? {
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply {
            inPreferredConfig = Bitmap.Config.ARGB_8888
            inPreferredColorSpace = ColorSpace.get(ColorSpace.Named.SRGB)
            inScaled = false
            var sample = 1
            while (bounds.outWidth / (sample * 2) >= 720 * zoom && bounds.outHeight / (sample * 2) >= 1280 * zoom) sample *= 2
            inSampleSize = sample
        }) ?: return null
        try {
            val orientation = try {
                ByteArrayInputStream(bytes).use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, 1) }
            } catch (_: IOException) { 1 }
            val matrix = Matrix()
            when (orientation) {
                2 -> matrix.setScale(-1f, 1f)
                3 -> matrix.setRotate(180f)
                4 -> matrix.setScale(1f, -1f)
                5 -> { matrix.setRotate(90f); matrix.postScale(-1f, 1f) }
                6 -> matrix.setRotate(90f)
                7 -> { matrix.setRotate(-90f); matrix.postScale(-1f, 1f) }
                8 -> matrix.setRotate(-90f)
                else -> return bitmap
            }
            val oriented = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
            if (oriented !== bitmap) bitmap.recycle()
            return oriented
        } catch (error: Throwable) {
            bitmap.recycle()
            throw error
        }
    }
}
