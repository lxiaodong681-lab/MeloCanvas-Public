package expo.modules.orpheus.bilibili

import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class AudioStreamSelectorTest {
    private fun audio(id: Int) = DashAudioItem(id, "https://test.invalid/$id.m4s", null)
    private fun data(ids: List<Int>, dolby: DolbyData? = null, flac: FlacData? = null) =
        BilibiliAudioStreamResponse(dash = DashData(ids.map(::audio), dolby, flac))

    @Test fun rejectsMuxedDurlInsteadOfDownloadingVideo() {
        val response = BilibiliAudioStreamResponse(durl = listOf(DurlItem(1, "https://test.invalid/video.mp4", null)))
        val error = assertThrows(IOException::class.java) { selectAudioStream(response, 30216, false, false) }
        assertTrue(error.message!!.startsWith("AudioOnlyUnavailable:"))
    }
    @Test fun rejectsMissingStreams() {
        assertThrows(IOException::class.java) { selectAudioStream(data(emptyList()), 30216, false, false) }
    }
    @Test fun exactQualityDoesNotDependOnServerOrdering() {
        assertEquals(30216, selectAudioStream(data(listOf(30280, 30216, 30232)), 30216, false, false).id)
    }
    @Test fun unavailableQualityPrefersLowerBandwidthTier() {
        assertEquals(30216, selectAudioStream(data(listOf(30280, 30216)), 30232, false, false).id)
    }
    @Test fun choosesLowestAvailableWhenNoLowerTierExists() {
        assertEquals(30232, selectAudioStream(data(listOf(30280, 30232)), 30216, false, false).id)
    }
    @Test fun disabledPremiumStreamsAreNotChosen() {
        val response = data(listOf(30216), DolbyData(1, listOf(audio(30250))), FlacData(true, audio(30251)))
        assertEquals(30216, selectAudioStream(response, 30216, false, false).id)
    }
    @Test fun explicitlyEnabledDolbyRetainsPriority() {
        val response = data(listOf(30216), DolbyData(1, listOf(audio(30250))), FlacData(true, audio(30251)))
        assertEquals(30250, selectAudioStream(response, 30216, true, true).id)
    }
    @Test fun explicitlyEnabledFlacIsChosenWhenDolbyAbsent() {
        assertEquals(30251, selectAudioStream(data(emptyList(), flac = FlacData(true, audio(30251))), 30216, true, true).id)
    }
}
