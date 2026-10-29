package expo.modules.bbplayernative

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ColorSpace
import android.graphics.ImageDecoder
import android.os.Build
import androidx.annotation.RequiresApi
import java.nio.ByteBuffer

internal object ThemePngDecoder {
    fun decode(bytes: ByteArray, limits: ThemeImageLimits): Map<String, Any> {
        val verified = ThemePngVerifier().verify(bytes, limits)
        var bitmap: Bitmap? = null
        try {
            bitmap = if (Build.VERSION.SDK_INT >= 28) decodeModern(bytes, verified) else decodeLegacy(bytes)
            if (bitmap == null || bitmap.width != verified.width || bitmap.height != verified.height ||
                bitmap.config != Bitmap.Config.ARGB_8888 || bitmap.allocationByteCount > limits.decodedImageBytes
            ) throw ThemeImageFailure(false, "Android did not produce a complete bounded RGBA bitmap")
            return mapOf("mime" to "image/png", "width" to verified.width, "height" to verified.height,
                "frames" to 1, "decodedBytes" to verified.decodedBytes)
        } finally { bitmap?.recycle() }
    }

    @RequiresApi(28)
    private fun decodeModern(bytes: ByteArray, verified: VerifiedPng): Bitmap =
        ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(bytes))) { decoder, info, _ ->
            if (info.mimeType != "image/png" || info.size.width != verified.width || info.size.height != verified.height)
                throw ThemeImageFailure(false, "Android PNG dimensions or MIME disagree")
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            decoder.setTargetColorSpace(ColorSpace.get(ColorSpace.Named.SRGB))
            decoder.setOnPartialImageListener { false }
        }

    private fun decodeLegacy(bytes: ByteArray): Bitmap? = BitmapFactory.decodeByteArray(bytes, 0, bytes.size,
        BitmapFactory.Options().apply {
            inPreferredConfig = Bitmap.Config.ARGB_8888
            inPreferredColorSpace = ColorSpace.get(ColorSpace.Named.SRGB)
            inScaled = false
            inDensity = 0
            inTargetDensity = 0
        })
}
