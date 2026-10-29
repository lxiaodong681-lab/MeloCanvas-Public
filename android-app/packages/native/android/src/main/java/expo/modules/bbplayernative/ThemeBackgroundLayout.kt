package expo.modules.bbplayernative

import kotlin.math.roundToInt

internal object ThemeBackgroundLayout {
    fun checkSize(width: Int, height: Int) {
        require(width > 0 && height > 0 && width <= 8192 && height <= 8192 && width.toLong() * height <= 16_000_000L) {
            "图片分辨率过大或无效，请先缩小至 1600 万像素以内"
        }
    }

    fun overlayAlpha(transparency: Double): Int {
        require(transparency.isFinite() && transparency in 0.0..100.0) { "背景透明度须为 0–100%" }
        return (255 * transparency / 100).roundToInt()
    }

    fun checkCrop(zoom: Double, horizontal: Double, vertical: Double) {
        require(zoom.isFinite() && zoom in 1.0..4.0 &&
            horizontal.isFinite() && horizontal in 0.0..100.0 &&
            vertical.isFinite() && vertical in 0.0..100.0) { "背景缩放或裁切位置无效" }
    }

    fun cover(width: Int, height: Int, zoom: Double = 1.0, horizontal: Double = 50.0, vertical: Double = 50.0): FloatArray {
        checkSize(width, height)
        checkCrop(zoom, horizontal, vertical)
        val scale = maxOf(720f / width, 1280f / height) * zoom.toFloat()
        val w = width * scale
        val h = height * scale
        val left = (720 - w) * (horizontal / 100).toFloat()
        val top = (1280 - h) * (vertical / 100).toFloat()
        return floatArrayOf(left, top, left + w, top + h)
    }
}
