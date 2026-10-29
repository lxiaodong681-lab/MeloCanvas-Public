package expo.modules.bbplayernative

import org.junit.Assert.*
import org.junit.Test

class ThemeBackgroundLayoutTest {
    @Test fun cropsLandscapeAndPortraitAroundCenterWithoutStretching() {
        for ((width, height) in listOf(4000 to 3000, 3000 to 4000, 720 to 1280, 100 to 100)) {
            val r = ThemeBackgroundLayout.cover(width, height)
            assertTrue(r[0] <= 0f && r[1] <= 0f && r[2] >= 720f && r[3] >= 1280f)
            assertEquals(720f, r[0] + r[2], 0.01f)
            assertEquals(1280f, r[1] + r[3], 0.01f)
            assertEquals(width.toFloat() / height, (r[2] - r[0]) / (r[3] - r[1]), 0.001f)
        }
    }

    @Test fun rejectsInvalidOrExcessiveDimensionsBeforeDecode() {
        for ((width, height) in listOf(0 to 10, -1 to 20, 8193 to 1, 5000 to 5000, Int.MAX_VALUE to Int.MAX_VALUE)) {
            try { ThemeBackgroundLayout.checkSize(width, height); fail("Accepted $width x $height") }
            catch (_: IllegalArgumentException) { }
        }
        ThemeBackgroundLayout.checkSize(4000, 4000)
    }

    @Test fun opacityEndpointsAndCropEdgesMatchUserControls() {
        assertEquals(0, ThemeBackgroundLayout.overlayAlpha(0.0))
        assertEquals(255, ThemeBackgroundLayout.overlayAlpha(100.0))
        assertEquals(204, ThemeBackgroundLayout.overlayAlpha(80.0))
        val left = ThemeBackgroundLayout.cover(1440, 1280, 1.0, 0.0, 50.0)
        val right = ThemeBackgroundLayout.cover(1440, 1280, 1.0, 100.0, 50.0)
        assertEquals(0f, left[0], 0.01f)
        assertEquals(720f, right[2], 0.01f)
        val top = ThemeBackgroundLayout.cover(720, 1280, 2.0, 50.0, 0.0)
        val bottom = ThemeBackgroundLayout.cover(720, 1280, 2.0, 50.0, 100.0)
        assertEquals(0f, top[1], 0.01f)
        assertEquals(1280f, bottom[3], 0.01f)
        assertEquals(1440f, top[2] - top[0], 0.01f)
        assertEquals(2560f, top[3] - top[1], 0.01f)
    }

    @Test fun invalidAdjustmentsCannotReachBitmapAllocation() {
        for (value in listOf(-1.0, 101.0, Double.NaN, Double.POSITIVE_INFINITY)) {
            try { ThemeBackgroundLayout.overlayAlpha(value); fail("Accepted opacity $value") }
            catch (_: IllegalArgumentException) { }
            try { ThemeBackgroundLayout.cover(720, 1280, 1.0, value, 50.0); fail("Accepted position $value") }
            catch (_: IllegalArgumentException) { }
        }
        for (zoom in listOf(0.0, 4.1, Double.NaN)) {
            try { ThemeBackgroundLayout.cover(720, 1280, zoom); fail("Accepted zoom $zoom") }
            catch (_: IllegalArgumentException) { }
        }
    }
}
