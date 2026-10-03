package com.vrcast.vrcast_remote

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.view.Surface
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Перекодирование на телефоне в реальном времени: любой источник (файл, адрес в сети, раздельные картинка и звук YouTube)
 * превращается в поток одного и того же формата — H.264 заданного размера и частоты кадров и AAC 48 кГц стерео, —
 * как это делает ffmpeg на ПК. Скорость, громкость и качество задаются здесь, а не у зрителя.
 *
 * Готовые кадры уходят в [emit] словарями: `vcfg`/`acfg` (параметры кодеков), `v` (кадр), `a` (звук), `end`, `error`.
 * Движок сам держит темп реального времени: кадры выходят не быстрее, чем идёт время.
 */
class TranscodeEngine(private val emit: (Map<String, Any?>) -> Unit) {
    class Params(
        val videoSource: String?,
        val audioSource: String?,
        val startUs: Long,
        val width: Int,
        val height: Int,
        val fps: Int,
        val videoBitrate: Int,
        val audioBitrate: Int,
        val volume: Float,
        val speed: Float,
        val headers: Map<String, String>?,
    )

    @Volatile private var stopped = false
    @Volatile private var paused = false
    @Volatile private var videoDone = false
    @Volatile private var audioDone = false
    @Volatile private var failure: String? = null
    @Volatile private var converter: AudioConverter? = null
    @Volatile private var volume = 1f
    private val lock = Object()
    private var pausedAt = 0L
    private var pausedTotal = 0L
    private var startWall = 0L
    private val threads = ArrayList<Thread>()

    fun start(params: Params) {
        volume = params.volume
        thread(name = "vrcast-engine") { runSafely(params) }.also { threads.add(it) }
    }

    fun stop() {
        stopped = true
        synchronized(lock) { lock.notifyAll() }
    }

    fun pause() = synchronized(lock) {
        if (!paused) { paused = true; pausedAt = System.nanoTime() }
    }

    fun resume() = synchronized(lock) {
        if (paused) { pausedTotal += System.nanoTime() - pausedAt; paused = false; lock.notifyAll() }
    }

    /** Громкость меняется на лету: следующая порция звука уже с новым усилением. */
    fun setVolume(value: Float) {
        volume = value
        converter?.gain = value
    }

    // Время эфира с начала, без пауз.
    private fun nowUs(): Long = ((if (paused) pausedAt else System.nanoTime()) - startWall - pausedTotal) / 1000

    // Ждём момента [targetUs]; false — эфир остановили.
    private fun waitUntil(targetUs: Long): Boolean {
        while (true) {
            if (stopped) return false
            if (paused) {
                synchronized(lock) { if (paused && !stopped) lock.wait(50) }
                continue
            }
            val remaining = targetUs - nowUs()
            if (remaining <= 0) return true
            Thread.sleep(minOf(remaining / 1000, 20L).coerceAtLeast(1L))
        }
    }

    private fun runSafely(p: Params) {
        val releasers = ArrayList<() -> Unit>()
        try {
            run(p, releasers)
        } catch (e: Throwable) {
            failure = e.message ?: e.javaClass.simpleName
            stopped = true
        } finally {
            stopped = true
            synchronized(lock) { lock.notifyAll() }
            for (thread in threads.toList()) if (thread !== Thread.currentThread()) try { thread.join(3000) } catch (_: Throwable) {}
            for (release in releasers.reversed()) try { release() } catch (_: Throwable) {}
            val reason = failure
            if (reason != null) emit(mapOf("type" to "error", "message" to reason)) else emit(mapOf("type" to "end"))
        }
    }

    private fun open(source: String, headers: Map<String, String>?): MediaExtractor {
        val extractor = MediaExtractor()
        if (source.startsWith("http://") || source.startsWith("https://")) extractor.setDataSource(source, headers ?: emptyMap()) else extractor.setDataSource(source)
        return extractor
    }

    private fun trackOf(extractor: MediaExtractor, prefix: String): Int {
        for (i in 0 until extractor.trackCount) if (extractor.getTrackFormat(i).getString(MediaFormat.KEY_MIME)?.startsWith(prefix) == true) return i
        return -1
    }

    private fun run(p: Params, releasers: ArrayList<() -> Unit>) {
        // ── Кодировщик картинки ──
        val encoder = createVideoEncoder(p)
        releasers.add { encoder.first.stop(); encoder.first.release() }
        val inputSurface = encoder.second
        releasers.add { inputSurface.release() }

        // ── Источники ──
        var videoExtractor: MediaExtractor? = null
        var videoTrack = -1
        if (p.videoSource != null) {
            videoExtractor = open(p.videoSource, p.headers)
            releasers.add { videoExtractor.release() }
            videoTrack = trackOf(videoExtractor, "video/")
        }
        val hasVideo = videoExtractor != null && videoTrack >= 0
        var videoFormat: MediaFormat? = null
        if (hasVideo) {
            videoExtractor!!.selectTrack(videoTrack)
            videoFormat = videoExtractor.getTrackFormat(videoTrack)
            if (videoFormat.containsKey(MediaFormat.KEY_DURATION)) emit(mapOf("type" to "dur", "seconds" to videoFormat.getLong(MediaFormat.KEY_DURATION) / 1e6))
            videoExtractor.seekTo(p.startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
        }

        // ── Рисование: поток с контекстом OpenGL ──
        val ready = CountDownLatch(1)
        var renderer: GlRenderer? = null
        var renderError: Throwable? = null
        var srcW = videoFormat?.let { size(it, MediaFormat.KEY_WIDTH) } ?: 0
        var srcH = videoFormat?.let { size(it, MediaFormat.KEY_HEIGHT) } ?: 0
        val rotation = if (videoFormat != null && videoFormat.containsKey(MediaFormat.KEY_ROTATION)) videoFormat.getInteger(MediaFormat.KEY_ROTATION) else 0
        val renderThread = thread(name = "vrcast-render") {
            try {
                renderer = GlRenderer(inputSurface, p.width, p.height)
            } catch (e: Throwable) {
                renderError = e
            }
            ready.countDown()
            val r = renderer ?: return@thread
            try {
                startWall = System.nanoTime()
                var tick = 0L
                while (!stopped) {
                    val pts = tick * 1_000_000L / p.fps
                    if (!waitUntil(pts)) break
                    r.draw(pts, hasVideo, srcW, srcH, rotation)
                    tick++
                    if (videoDone && audioDone) break
                }
                encoder.first.signalEndOfInputStream()
            } catch (e: Throwable) {
                if (failure == null && !stopped) failure = "Рисование кадра: ${e.message}"
                stopped = true
            } finally {
                r.release()
            }
        }
        threads.add(renderThread)
        ready.await()
        renderError?.let { throw it }
        startWall = System.nanoTime()

        // ── Декодер картинки ──
        var videoDecoder: MediaCodec? = null
        if (hasVideo) {
            val mime = videoFormat!!.getString(MediaFormat.KEY_MIME)!!
            videoDecoder = MediaCodec.createDecoderByType(mime)
            videoDecoder.configure(videoFormat, renderer!!.decoderSurface, null, 0)
            videoDecoder.start()
            releasers.add { videoDecoder.stop(); videoDecoder.release() }
        } else {
            videoDone = true
        }

        // ── Вывод кодировщика картинки ──
        threads.add(thread(name = "vrcast-venc") { drainVideoEncoder(encoder.first, p) })

        // ── Звук ──
        threads.add(thread(name = "vrcast-audio") {
            try {
                runAudio(p, hasVideo)
            } catch (e: Throwable) {
                if (failure == null && !stopped) failure = "Звук: ${e.message}"
                stopped = true
            } finally {
                audioDone = true
            }
        })

        // ── Подача картинки в декодер (в этом потоке) ──
        if (hasVideo) {
            val decoder = videoDecoder!!
            val extractor = videoExtractor!!
            val info = MediaCodec.BufferInfo()
            var inputEnded = false
            while (!stopped) {
                if (!inputEnded) {
                    val index = decoder.dequeueInputBuffer(2000)
                    if (index >= 0) {
                        val buffer = decoder.getInputBuffer(index)!!
                        val size = extractor.readSampleData(buffer, 0)
                        if (size < 0) {
                            decoder.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            inputEnded = true
                        } else {
                            decoder.queueInputBuffer(index, 0, size, extractor.sampleTime, 0)
                            extractor.advance()
                        }
                    }
                }
                val out = decoder.dequeueOutputBuffer(info, 2000)
                when {
                    out == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                        val format = decoder.outputFormat
                        val width = if (format.containsKey("crop-right") && format.containsKey("crop-left")) format.getInteger("crop-right") - format.getInteger("crop-left") + 1 else size(format, MediaFormat.KEY_WIDTH)
                        val height = if (format.containsKey("crop-bottom") && format.containsKey("crop-top")) format.getInteger("crop-bottom") - format.getInteger("crop-top") + 1 else size(format, MediaFormat.KEY_HEIGHT)
                        if (width > 0 && height > 0) { srcW = width; srcH = height }
                    }
                    out >= 0 -> {
                        val sourcePts = info.presentationTimeUs
                        val eos = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
                        if (sourcePts < p.startUs && !eos) {
                            decoder.releaseOutputBuffer(out, false) // разгон до нужного места: кадры до старта не показываем
                        } else if (eos) {
                            decoder.releaseOutputBuffer(out, false)
                            videoDone = true
                            break
                        } else {
                            val outPts = ((sourcePts - p.startUs) / p.speed).toLong()
                            if (!waitUntil(outPts)) { decoder.releaseOutputBuffer(out, false); break }
                            decoder.releaseOutputBuffer(out, true)
                        }
                    }
                }
            }
            if (!stopped) videoDone = true
        }
        // Ждём, пока дорисуется и закроется всё остальное.
        for (t in threads.toList()) if (t !== Thread.currentThread()) t.join()
    }

    private fun size(format: MediaFormat, key: String) = if (format.containsKey(key)) format.getInteger(key) else 0

    private fun createVideoEncoder(p: Params): Pair<MediaCodec, Surface> {
        // Сначала пробуем высокий профиль и постоянный битрейт, как на ПК; если кодировщик не умеет — его настройки по умолчанию.
        for (strict in listOf(true, false)) {
            val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, p.width, p.height).apply {
                setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
                setInteger(MediaFormat.KEY_BIT_RATE, p.videoBitrate)
                setInteger(MediaFormat.KEY_FRAME_RATE, p.fps)
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
                if (strict) {
                    setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR)
                    setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileHigh)
                }
            }
            val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
            try {
                codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                val surface = codec.createInputSurface()
                codec.start()
                return codec to surface
            } catch (e: Throwable) {
                codec.release()
                if (!strict) throw e
            }
        }
        throw IllegalStateException("Кодировщик H.264 недоступен")
    }

    private fun drainVideoEncoder(encoder: MediaCodec, p: Params) {
        val info = MediaCodec.BufferInfo()
        var configSent = false
        fun sendConfig(config: ByteArray) {
            val parts = splitAnnexB(config)
            val sps = parts.firstOrNull { (it[0].toInt() and 31) == 7 }
            val pps = parts.firstOrNull { (it[0].toInt() and 31) == 8 }
            if (sps != null && pps != null && !configSent) {
                configSent = true
                emit(mapOf("type" to "vcfg", "sps" to sps, "pps" to pps, "width" to p.width, "height" to p.height, "fps" to p.fps))
            }
        }
        while (true) {
            val index = try { encoder.dequeueOutputBuffer(info, 10000) } catch (_: Throwable) { return }
            when {
                index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    val format = encoder.outputFormat
                    val csd = ArrayList<Byte>()
                    for (key in listOf("csd-0", "csd-1")) format.getByteBuffer(key)?.let { b -> val bytes = ByteArray(b.remaining()); b.duplicate().get(bytes); csd.addAll(bytes.toList()) }
                    if (csd.isNotEmpty()) sendConfig(csd.toByteArray())
                }
                index >= 0 -> {
                    val buffer = encoder.getOutputBuffer(index)
                    val data = ByteArray(info.size)
                    if (buffer != null && info.size > 0) { buffer.position(info.offset); buffer.limit(info.offset + info.size); buffer.get(data) }
                    val flags = info.flags
                    val pts = info.presentationTimeUs
                    encoder.releaseOutputBuffer(index, false)
                    if (flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) { sendConfig(data); continue }
                    if (data.isNotEmpty()) {
                        // Часть кодировщиков кладёт SPS и PPS перед ключевым кадром: берём оттуда, если отдельно не пришли.
                        if (!configSent && flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0) sendConfig(data)
                        emit(mapOf("type" to "v", "pts" to pts, "key" to (flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0), "data" to annexBToLengthPrefixed(data)))
                    }
                    if (flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return
                }
                stopped && index == MediaCodec.INFO_TRY_AGAIN_LATER -> return
            }
        }
    }

    private fun runAudio(p: Params, hasVideo: Boolean) {
        val source = p.audioSource ?: p.videoSource
        var extractor: MediaExtractor? = null
        var track = -1
        if (source != null) {
            extractor = open(source, p.headers)
            track = trackOf(extractor, "audio/")
        }
        val encoderFormat = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, OUT_RATE, OUT_CHANNELS).apply {
            setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
            setInteger(MediaFormat.KEY_BIT_RATE, p.audioBitrate)
            setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384)
        }
        val encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
        encoder.configure(encoderFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        encoder.start()
        var decoder: MediaCodec? = null
        try {
            if (extractor != null && track >= 0) {
                extractor.selectTrack(track)
                val format = extractor.getTrackFormat(track)
            if (format.containsKey(MediaFormat.KEY_DURATION)) emit(mapOf("type" to "dur", "seconds" to format.getLong(MediaFormat.KEY_DURATION) / 1e6))
                extractor.seekTo(p.startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
                decoder = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)!!)
                decoder.configure(format, null, null, 0)
                decoder.start()
            }
            val stretcher = TimeStretcher().apply { speed = p.speed.toDouble() }
            val pending = ArrayDeque<Short>()
            val encoderInfo = MediaCodec.BufferInfo()
            var encodedSamples = 0L
            var acfgSent = false
            var decoderEnded = decoder == null
            var inputEnded = false
            var encoderEos = false
            var sourceRate = OUT_RATE
            var sourceChannels = OUT_CHANNELS
            val decoderInfo = MediaCodec.BufferInfo()
            var skipFrames = -1L // сколько отсчётов источника выбросить в начале (разгон до нужного места)

            fun drainEncoder(): Boolean {
                var progressed = false
                while (true) {
                    val out = encoder.dequeueOutputBuffer(encoderInfo, 0)
                    if (out == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                        if (!acfgSent) {
                            val csd = encoder.outputFormat.getByteBuffer("csd-0")
                            if (csd != null) {
                                val bytes = ByteArray(csd.remaining()); csd.duplicate().get(bytes)
                                acfgSent = true
                                emit(mapOf("type" to "acfg", "asc" to bytes, "sampleRate" to OUT_RATE, "channels" to OUT_CHANNELS))
                            }
                        }
                        progressed = true
                    } else if (out >= 0) {
                        val buffer = encoder.getOutputBuffer(out)
                        val data = ByteArray(encoderInfo.size)
                        if (buffer != null && encoderInfo.size > 0) { buffer.position(encoderInfo.offset); buffer.limit(encoderInfo.offset + encoderInfo.size); buffer.get(data) }
                        val flags = encoderInfo.flags
                        val pts = encoderInfo.presentationTimeUs
                        encoder.releaseOutputBuffer(out, false)
                        if (flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
                            if (!acfgSent) { acfgSent = true; emit(mapOf("type" to "acfg", "asc" to data, "sampleRate" to OUT_RATE, "channels" to OUT_CHANNELS)) }
                        } else if (data.isNotEmpty()) {
                            emit(mapOf("type" to "a", "pts" to pts, "data" to data))
                        }
                        if (flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) { encoderEos = true; return true }
                        progressed = true
                    } else {
                        return progressed
                    }
                }
            }

            fun feedEncoder(): Boolean {
                if (inputEnded) return false
                // Целая порция AAC — 1024 отсчёта на канал.
                val chunk = 1024 * OUT_CHANNELS
                val finishing = decoderEnded && (decoder != null || videoDone)
                if (pending.size < chunk && !finishing) return false
                if (pending.isEmpty() && finishing) {
                    val index = encoder.dequeueInputBuffer(0)
                    if (index < 0) return false
                    encoder.queueInputBuffer(index, 0, 0, encodedSamples * 1_000_000L / OUT_RATE, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                    inputEnded = true
                    return true
                }
                val index = encoder.dequeueInputBuffer(0)
                if (index < 0) return false
                val pts = encodedSamples * 1_000_000L / OUT_RATE
                // Звук идёт чуть впереди картинки, но не убегает: держим темп реального времени.
                if (!waitUntil(pts - 150_000)) return false
                val take = minOf(chunk, pending.size)
                val bytes = ByteBuffer.allocate(chunk * 2).order(ByteOrder.LITTLE_ENDIAN)
                for (i in 0 until chunk) bytes.putShort(if (i < take) pending[i] else 0)
                bytes.flip()
                val input = encoder.getInputBuffer(index)!!
                input.clear(); input.put(bytes)
                encoder.queueInputBuffer(index, 0, chunk * 2, pts, 0)
                repeat(take) { pending.removeFirst() }
                encodedSamples += chunk / OUT_CHANNELS
                return true
            }

            while (!stopped && !encoderEos) {
                var worked = false
                if (decoder != null && !decoderEnded) {
                    run {
                        val index = decoder.dequeueInputBuffer(0)
                        if (index >= 0) {
                            val buffer = decoder.getInputBuffer(index)!!
                            val size = extractor!!.readSampleData(buffer, 0)
                            if (size < 0) decoder.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            else { decoder.queueInputBuffer(index, 0, size, extractor.sampleTime, 0); extractor.advance() }
                            worked = true
                        }
                    }
                    val out = decoder.dequeueOutputBuffer(decoderInfo, 0)
                    if (out == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                        val format = decoder.outputFormat
                        sourceRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                        sourceChannels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                        converter = AudioConverter(sourceRate, sourceChannels, volume)
                        worked = true
                    } else if (out >= 0) {
                        val eos = decoderInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
                        val buffer = decoder.getOutputBuffer(out)
                        if (buffer != null && decoderInfo.size > 0) {
                            buffer.position(decoderInfo.offset); buffer.limit(decoderInfo.offset + decoderInfo.size)
                            var pcm = ShortArray(decoderInfo.size / 2)
                            buffer.order(ByteOrder.nativeOrder()).asShortBuffer().get(pcm)
                            // До нужного места выбрасываем начало: источник начинается раньше (ближайшая точка перемотки).
                            val framesHere = pcm.size / sourceChannels
                            if (skipFrames < 0) skipFrames = maxOf(0L, (p.startUs - decoderInfo.presentationTimeUs) * sourceRate / 1_000_000L)
                            if (skipFrames > 0) {
                                val drop = minOf(skipFrames, framesHere.toLong()).toInt()
                                pcm = pcm.copyOfRange(drop * sourceChannels, pcm.size)
                                skipFrames -= drop
                            }
                            val active = converter ?: AudioConverter(sourceRate, sourceChannels, volume).also { converter = it }
                            stretcher.push(active.convert(pcm))
                            for (s in stretcher.pull()) pending.add(s)
                        }
                        decoder.releaseOutputBuffer(out, false)
                        if (eos) decoderEnded = true
                        worked = true
                    }
                } else if (decoder == null && !decoderEnded) {
                    decoderEnded = true
                }
                // Источника звука нет — шлём тишину, пока идёт картинка (формат эфира не должен меняться).
                if (decoder == null && !videoDone && pending.size < 4096) {
                    for (i in 0 until 1024 * OUT_CHANNELS) pending.add(0)
                    worked = true
                }
                if (decoder != null && !decoderEnded && pending.size > 48000 * 2) {
                    // Звука накоплено с запасом (секунда): декодер подождёт.
                    worked = feedEncoder() or worked
                } else {
                    worked = feedEncoder() or worked
                }
                worked = drainEncoder() or worked
                if (!worked) Thread.sleep(3)
                if (decoder == null && videoDone && pending.isEmpty() && !inputEnded) decoderEnded = true
            }
            if (!stopped) while (!encoderEos && !stopped) { drainEncoder(); Thread.sleep(3) }
        } finally {
            try { decoder?.stop(); decoder?.release() } catch (_: Throwable) {}
            try { encoder.stop(); encoder.release() } catch (_: Throwable) {}
            try { extractor?.release() } catch (_: Throwable) {}
        }
    }
}
