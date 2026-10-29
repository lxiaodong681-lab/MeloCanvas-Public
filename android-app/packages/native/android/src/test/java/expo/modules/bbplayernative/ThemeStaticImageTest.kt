package expo.modules.bbplayernative

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ThemeStaticImageTest {
    @Test fun boundsKeepAspectAndNeverEnlarge() {
        assertEquals(128 to 64, ThemeStaticImage.dimensions(2048, 1024, 128))
        assertEquals(64 to 128, ThemeStaticImage.dimensions(1024, 2048, 128))
        assertEquals(32 to 16, ThemeStaticImage.dimensions(32, 16, 128))
    }
    @Test fun rejectsUnsafeDimensionsBeforeDecode() {
        assertThrows(IllegalArgumentException::class.java) { ThemeStaticImage.dimensions(9000, 100, 128) }
        assertThrows(IllegalArgumentException::class.java) { ThemeStaticImage.dimensions(5000, 5000, 128) }
        assertThrows(IllegalArgumentException::class.java) { ThemeStaticImage.dimensions(0, 100, 128) }
        assertThrows(IllegalArgumentException::class.java) { ThemeStaticImage.dimensions(100, 100, 9000) }
    }
}
