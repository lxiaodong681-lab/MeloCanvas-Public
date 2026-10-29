package expo.modules.orpheus.bilibili

import java.io.IOException

/** Audio-only experiment policy: never silently fetch a muxed video fallback. */
internal fun selectAudioStream(
    data: BilibiliAudioStreamResponse,
    audioQuality: Int,
    enableDolby: Boolean,
    enableHiRes: Boolean
): DashAudioItem {
    val dash = data.dash ?: throw IOException(
        "AudioOnlyUnavailable: 当前视频没有独立音轨，已停止自动下载视频流"
    )
    if (enableDolby) dash.dolby?.audio?.firstOrNull()?.let { return it }
    if (enableHiRes) dash.flac?.audio?.let { return it }
    val audio = dash.audio.orEmpty()
    return audio.firstOrNull { it.id == audioQuality }
        ?: audio.filter { it.id <= audioQuality }.maxByOrNull { it.id }
        ?: audio.minByOrNull { it.id }
        ?: throw IOException("AudioStreamError: 未找到有效的音频流数据")
}
