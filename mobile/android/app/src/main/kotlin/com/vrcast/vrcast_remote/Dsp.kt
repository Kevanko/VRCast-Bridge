package com.vrcast.vrcast_remote

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * Звук для эфира: любой вход приводится к одному формату (48 кГц, стерео), как на ПК, чтобы плеер VRChat не
 * переинициализировался при смене ролика. Здесь же громкость и смена скорости без смены тона.
 * Классы без зависимостей от Android: проверяются обычными тестами на компьютере.
 */
const val OUT_RATE = 48000
const val OUT_CHANNELS = 2

/** Приводит поток PCM (16 бит, чередование каналов) к 48 кГц стерео с громкостью. Состояние хранится между порциями. */
class AudioConverter(private val srcRate: Int, private val srcChannels: Int, var gain: Float = 1f) {
    private val step = srcRate.toDouble() / OUT_RATE
    private var position = 0.0 // дробная позиция следующего выходного отсчёта относительно начала текущей порции
    private var lastL = 0f
    private var lastR = 0f

    /** Каналы источника → левый и правый. Для 5.1 берётся обычное сведение, для остальных первые два канала. */
    private fun stereoOf(frame: ShortArray, index: Int): Pair<Float, Float> {
        val base = index * srcChannels
        return when (srcChannels) {
            1 -> frame[base].toFloat().let { it to it }
            2 -> frame[base].toFloat() to frame[base + 1].toFloat()
            6 -> {
                val fl = frame[base].toFloat(); val fr = frame[base + 1].toFloat(); val c = frame[base + 2].toFloat()
                val sl = frame[base + 4].toFloat(); val sr = frame[base + 5].toFloat()
                (fl + 0.707f * c + 0.707f * sl) / 2.414f to (fr + 0.707f * c + 0.707f * sr) / 2.414f
            }
            else -> frame[base].toFloat() to frame[base + 1].toFloat()
        }
    }

    /** [pcm] — отсчёты источника (все каналы подряд). Возвращает стерео 48 кГц. */
    fun convert(pcm: ShortArray): ShortArray {
        val frames = pcm.size / srcChannels
        if (frames == 0) return ShortArray(0)
        if (srcRate == OUT_RATE) { // частота та же: только каналы и громкость, без интерполяции и потери отсчётов
            val direct = ShortArray(frames * 2)
            for (i in 0 until frames) {
                val (l, r) = stereoOf(pcm, i)
                direct[i * 2] = (l * gain).coerceIn(-32768f, 32767f).roundToInt().toShort()
                direct[i * 2 + 1] = (r * gain).coerceIn(-32768f, 32767f).roundToInt().toShort()
            }
            return direct
        }
        val out = ArrayList<Short>((frames / step).toInt() * 2 + 4)
        // position от -1 (между последним отсчётом прошлой порции и первым этой) до frames - 1: нужны два соседних отсчёта
        while (position < frames - 1) {
            val i = Math.floor(position).toInt()
            val frac = (position - i).toFloat()
            val (l0, r0) = if (i < 0) lastL to lastR else stereoOf(pcm, i)
            val (l1, r1) = stereoOf(pcm, minOf(i + 1, frames - 1))
            val l = (l0 + (l1 - l0) * frac) * gain
            val r = (r0 + (r1 - r0) * frac) * gain
            out.add(l.coerceIn(-32768f, 32767f).roundToInt().toShort())
            out.add(r.coerceIn(-32768f, 32767f).roundToInt().toShort())
            position += step
        }
        val (ll, lr) = stereoOf(pcm, frames - 1)
        lastL = ll; lastR = lr
        position -= frames
        return out.toShortArray()
    }
}

/**
 * Смена скорости без смены тона (WSOLA): кадры берутся из входа с шагом speed и склеиваются внахлёст в самых похожих местах.
 * Работает потоком на стерео 48 кГц: [push] кладёт вход, [pull] отдаёт всё, что уже готово.
 */
class TimeStretcher(private val channels: Int = OUT_CHANNELS, rate: Int = OUT_RATE) {
    var speed = 1.0
        set(value) { field = value.coerceIn(0.5, 2.0) }

    private val frame = rate * 40 / 1000       // длина окна, отсчётов на канал
    private val hopOut = frame / 2            // шаг на выходе
    private val tolerance = rate * 10 / 1000  // насколько можно сдвинуть кадр в поисках лучшего совпадения
    private val window = FloatArray(frame) { (0.5 - 0.5 * cos(2 * PI * it / (frame - 1))).toFloat() }

    // Вход храним по каналам; inBase — номер первого сохранённого отсчёта во всём потоке.
    private var input = Array(channels) { FloatArray(0) }
    private var inBase = 0L
    private var inLen = 0
    private val tail = Array(channels) { FloatArray(frame) } // накопитель наложения
    private var prevPos = -1L        // где в потоке начинался прошлый кадр
    private var frameIndex = 0L
    private val ready = ArrayList<Short>()
    private var passthrough = true

    fun push(pcm: ShortArray) {
        val n = pcm.size / channels
        if (n == 0) return
        if (speed == 1.0 && prevPos < 0) { // быстрый путь: без изменения скорости вход уходит как есть
            for (s in pcm) ready.add(s)
            return
        }
        passthrough = false
        ensure(inLen + n)
        for (i in 0 until n) for (c in 0 until channels) input[c][inLen + i] = pcm[i * channels + c].toFloat()
        inLen += n
        process()
    }

    private fun ensure(size: Int) {
        if (size <= input[0].size) return
        val bigger = maxOf(size, input[0].size * 2, frame * 8)
        input = Array(channels) { c -> input[c].copyOf(bigger) }
    }

    private fun process() {
        while (true) {
            val ideal = (frameIndex * hopOut * speed).toLong()
            val lo = if (prevPos < 0) ideal else ideal - tolerance
            val needEnd = ideal + tolerance + frame + 1
            if (needEnd - inBase > inLen) return // входа не хватает: ждём
            var pos = ideal
            if (prevPos >= 0) {
                // Естественное продолжение прошлого кадра: ищем похожее место рядом с идеальным.
                val refStart = prevPos + hopOut
                var best = -2.0
                var bestPos = ideal
                var candidate = lo
                while (candidate <= ideal + tolerance) {
                    if (candidate - inBase >= 0 && refStart - inBase >= 0 && refStart + hopOut - inBase <= inLen) {
                        val score = similarity((refStart - inBase).toInt(), (candidate - inBase).toInt(), hopOut)
                        if (score > best) { best = score; bestPos = candidate }
                    }
                    candidate += 4 // с шагом 4 отсчёта: хватает для точности и быстрее
                }
                pos = bestPos
            }
            val at = (pos - inBase).toInt()
            if (at < 0 || at + frame > inLen) return
            for (c in 0 until channels) {
                val x = input[c]; val t = tail[c]
                for (k in 0 until frame) t[k] += x[at + k] * window[k]
            }
            // Первая половина накопителя готова: отдаём, остальное сдвигаем.
            for (k in 0 until hopOut) for (c in 0 until channels) ready.add(tail[c][k].coerceIn(-32768f, 32767f).roundToInt().toShort())
            for (c in 0 until channels) {
                val t = tail[c]
                System.arraycopy(t, hopOut, t, 0, frame - hopOut)
                java.util.Arrays.fill(t, frame - hopOut, frame, 0f)
            }
            prevPos = pos
            frameIndex++
            // Забываем вход, который уже не понадобится.
            val keepFrom = pos - tolerance - frame
            val drop = (keepFrom - inBase).toInt()
            if (drop > frame * 4) {
                for (c in 0 until channels) System.arraycopy(input[c], drop, input[c], 0, inLen - drop)
                inLen -= drop
                inBase += drop
            }
        }
    }

    // Нормированная корреляция по сумме каналов.
    private fun similarity(a: Int, b: Int, len: Int): Double {
        var dot = 0.0; var ea = 0.0; var eb = 0.0
        for (i in 0 until len) {
            var x = 0f; var y = 0f
            for (c in 0 until channels) { x += input[c][a + i]; y += input[c][b + i] }
            dot += x * y; ea += x * x; eb += y * y
        }
        return dot / (sqrt(ea * eb) + 1e-9)
    }

    /** Всё, что уже готово (стерео, чередование). */
    fun pull(): ShortArray {
        val out = ready.toShortArray()
        ready.clear()
        return out
    }
}

/** Кадр H.264 из кодировщика (стартовые коды 00 00 01 / 00 00 00 01) → NAL с четырёхбайтовыми длинами, как в mp4. */
fun annexBToLengthPrefixed(data: ByteArray): ByteArray {
    val starts = ArrayList<Int>()
    var i = 0
    while (i + 2 < data.size) {
        if (data[i].toInt() == 0 && data[i + 1].toInt() == 0 && data[i + 2].toInt() == 1) { starts.add(i + 3); i += 3 } else i++
    }
    val out = java.io.ByteArrayOutputStream(data.size + starts.size)
    for ((n, start) in starts.withIndex()) {
        var end = if (n + 1 < starts.size) starts[n + 1] - 3 else data.size
        // Нулевые байты перед следующим стартовым кодом принадлежат ему.
        while (end > start && data[end - 1].toInt() == 0 && n + 1 < starts.size) end--
        while (n + 1 == starts.size && end > start && data[end - 1].toInt() == 0) end--
        val length = end - start
        if (length <= 0) continue
        out.write(length ushr 24); out.write(length ushr 16); out.write(length ushr 8); out.write(length)
        out.write(data, start, length)
    }
    return out.toByteArray()
}

/** NAL-единицы из блока параметров кодировщика (SPS и PPS подряд со стартовыми кодами) без самих кодов. */
fun splitAnnexB(data: ByteArray): List<ByteArray> {
    val result = ArrayList<ByteArray>()
    val pref = annexBToLengthPrefixed(data)
    var p = 0
    while (p + 4 <= pref.size) {
        val n = ((pref[p].toInt() and 255) shl 24) or ((pref[p + 1].toInt() and 255) shl 16) or ((pref[p + 2].toInt() and 255) shl 8) or (pref[p + 3].toInt() and 255)
        p += 4
        if (n <= 0 || p + n > pref.size) break
        result.add(pref.copyOfRange(p, p + n))
        p += n
    }
    return result
}

fun peak(samples: ShortArray): Int = samples.maxOfOrNull { abs(it.toInt()) } ?: 0
