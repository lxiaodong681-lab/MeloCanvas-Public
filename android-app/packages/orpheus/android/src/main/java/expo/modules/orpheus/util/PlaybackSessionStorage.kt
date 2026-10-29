package expo.modules.orpheus.util

import android.content.Context
import com.tencent.mmkv.MMKV
import expo.modules.orpheus.model.TrackRecord
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import expo.modules.orpheus.widget.WidgetStamp

@Serializable
data class PlaybackSessionSnapshot(
    val mode: String = "music",
    val tracks: List<TrackRecord> = emptyList(),
    val currentSourceId: String? = null,
    val positionSeconds: Double = 0.0,
    val durationSeconds: Double = 0.0,
    val speed: Float = 1f,
    val playing: Boolean = false,
    val updatedAt: Long = 0L,
    val currentEntryId: String? = null,
    val playWhenReady: Boolean = playing,
    val repeatMode: Int = 0,
    val shuffleEntryIds: List<String>? = null,
    val listeningResumeOverrides: Map<String, Double> = emptyMap(),
    val listeningResumeBlocked: Set<String> = emptySet(),
)

@Serializable
data class FmPlaybackContext(
    val id: String,
    val returnMode: String,
    val manualMusic: PlaybackSessionSnapshot? = null,
    val returnListening: PlaybackSessionSnapshot? = null,
)

@Serializable
data class StoredPlaybackSessions(
    val active: PlaybackSessionSnapshot,
    val inactive: PlaybackSessionSnapshot? = null,
    val version: Int = 3,
    val widgetStamp: String? = null,
    val fm: FmPlaybackContext? = null,
)

sealed interface PlaybackSessionRead {
    data object Missing : PlaybackSessionRead
    data object Unreadable : PlaybackSessionRead
    data class Available(val sessions: StoredPlaybackSessions) : PlaybackSessionRead
}

/** Version is explicit on write; absent versions are the original v1 format. */
object PlaybackSessionCodec {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    fun read(raw: String?): PlaybackSessionRead = if (raw == null) PlaybackSessionRead.Missing
        else decode(raw)?.let { PlaybackSessionRead.Available(it) } ?: PlaybackSessionRead.Unreadable

    fun validSession(session: PlaybackSessionSnapshot): Boolean =
        session.mode in listOf("music", "listening") &&
            session.positionSeconds.isFinite() && session.positionSeconds >= 0 && session.positionSeconds <= Long.MAX_VALUE / 1000.0 &&
            session.durationSeconds.isFinite() && session.durationSeconds >= 0 &&
            session.updatedAt in 0..9007199254740991L &&
            session.speed.isFinite() && session.speed in 0.1f..3f &&
            session.repeatMode in 0..2 &&
            (session.shuffleEntryIds == null ||
                (session.shuffleEntryIds.size == session.tracks.size &&
                    session.shuffleEntryIds.distinct().size == session.tracks.size &&
                    session.shuffleEntryIds.toSet() == session.tracks.map { it.id }.toSet())) &&
            ListeningResumeOverrides.valid(session.mode, session.tracks, session.listeningResumeOverrides) &&
            ListeningResumeOverrides.validBlocked(session.mode, session.tracks, session.listeningResumeBlocked) &&
            session.tracks.all { PlaybackSourceIdentity.isValidEntry(it.id, it.sourceId, it.url, session.mode) } &&
            session.tracks.map { it.id }.distinct().size == session.tracks.size &&
            (if (session.tracks.isEmpty()) session.currentEntryId == null && session.currentSourceId == null && session.positionSeconds == 0.0
                else session.currentEntryId != null && session.tracks.any {
                    it.id == session.currentEntryId && (it.sourceId ?: it.id) == session.currentSourceId
                })

    fun decode(raw: String): StoredPlaybackSessions? = runCatching {
        val objectValue = json.parseToJsonElement(raw) as? JsonObject ?: error("Invalid playback snapshot")
        val version = objectValue["version"]?.jsonPrimitive?.int ?: 1
        // A malformed widget-only field must not discard a valid playback queue.
        val stamp = (objectValue["widgetStamp"] as? kotlinx.serialization.json.JsonPrimitive)
            ?.takeIf { it.isString }?.content?.takeIf { WidgetStamp.valid(it) }
        val stored = json.decodeFromJsonElement<StoredPlaybackSessions>(JsonObject(objectValue - "widgetStamp"))
            .copy(widgetStamp = stamp)
        val normalized = when (version) {
            1 -> StoredPlaybackSessions(legacySession(stored.active), stored.inactive?.let { runCatching { legacySession(it) }.getOrNull() })
            2 -> stored.copy(version = 3, fm = null)
            3 -> stored
            else -> error("Unsupported playback snapshot version")
        }
        require(validSession(normalized.active))
        normalized.copy(
            inactive = if (version < 3) normalized.inactive?.takeIf { validSession(it) } else normalized.inactive,
            widgetStamp = normalized.widgetStamp?.takeIf { WidgetStamp.valid(it) },
        ).also { require(validStored(it)) }
    }.getOrNull()

    private fun legacySession(session: PlaybackSessionSnapshot): PlaybackSessionSnapshot {
        require(session.tracks.all { PlaybackSourceIdentity.isValid(it.id, it.url) })
        return session.copy(
            tracks = session.tracks.map { old -> TrackRecord().apply {
                id = old.id; sourceId = old.id; url = old.url; title = old.title
                artist = old.artist; artwork = old.artwork; duration = old.duration
            } },
            currentEntryId = session.currentSourceId,
        )
    }

    fun encode(sessions: StoredPlaybackSessions): String {
        require(validStored(sessions)) { "Invalid playback snapshot" }
        return json.encodeToString(sessions)
    }

    fun validStored(sessions: StoredPlaybackSessions): Boolean =
        sessions.version == 3 && validSession(sessions.active) &&
            (sessions.inactive?.let { validSession(it) && it.mode != sessions.active.mode } ?: true) &&
            (sessions.widgetStamp == null || WidgetStamp.valid(sessions.widgetStamp)) &&
            (sessions.fm?.let { fm ->
                val music = listOfNotNull(sessions.active, sessions.inactive).filter { it.mode == "music" }
                WidgetStamp.valid(fm.id) && fm.returnMode in listOf("music", "listening") &&
                    music.size == 1 && music[0].tracks.size in 1..5000 && music[0].repeatMode == 0 &&
                    music[0].tracks.all { PlaybackSourceIdentity.isValid(it.sourceId ?: it.id, it.url) } &&
                    music[0].shuffleEntryIds == null &&
                    music[0].tracks.map { it.sourceId ?: it.id }.distinct().size == music[0].tracks.size &&
                    (fm.manualMusic?.let { it.mode == "music" && validSession(it) } ?: true) &&
                    (if (fm.returnMode == "listening") fm.returnListening?.let { it.mode == "listening" && validSession(it) } == true
                        else fm.returnListening == null)
            } ?: true)
}

/** Missing and unreadable are distinct: an automatic write cannot replace unknown original bytes. */
class PlaybackSessionPersistence(private val readRaw: () -> String?, private val writeRaw: (String) -> Boolean) {
    fun read(): PlaybackSessionRead = PlaybackSessionCodec.read(readRaw())
    fun get(): StoredPlaybackSessions? = (read() as? PlaybackSessionRead.Available)?.sessions

    fun save(sessions: StoredPlaybackSessions) {
        val raw = readRaw()
        check(raw == null || PlaybackSessionCodec.decode(raw) != null) {
            "原生播放记录损坏或版本不受支持；原记录已保留，暂不能保存播放状态。"
        }
        check(writeRaw(PlaybackSessionCodec.encode(sessions))) { "Failed to persist native playback sessions" }
    }
}

/** One JSON value commits both sides of a mode switch, including the crash window before JS. */
object PlaybackSessionStorage {
    private var kv: MMKV? = null
    private const val KEY = "playback_sessions"
    private const val REJECTED_KEY = "unreadable_playback_sessions"

    fun initialize(context: Context) {
        if (kv == null) {
            MMKV.initialize(context)
            kv = MMKV.mmkvWithID("melocanvas_sessions_v1")
        }
    }

    fun read(): PlaybackSessionRead {
        val storage = kv ?: return PlaybackSessionRead.Unreadable
        val raw = runCatching { storage.decodeString(KEY) }.getOrElse { return PlaybackSessionRead.Unreadable }
        val result = PlaybackSessionCodec.read(raw)
        if (result == PlaybackSessionRead.Unreadable) runCatching {
            if (storage.decodeString(REJECTED_KEY) == null) storage.encode(REJECTED_KEY, raw)
        }
        return result
    }

    fun get(): StoredPlaybackSessions? = (read() as? PlaybackSessionRead.Available)?.sessions

    fun save(sessions: StoredPlaybackSessions) {
        PlaybackSessionPersistence({ kv?.decodeString(KEY) }, { kv?.encode(KEY, it) == true }).save(sessions)
    }
}
