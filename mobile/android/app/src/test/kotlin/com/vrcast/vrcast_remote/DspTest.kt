package com.vrcast.vrcast_remote

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.sin
import org.junit.Test

class DspTest {
    private fun sine(freq: Double, seconds: Double, rate: Int = OUT_RATE, channels: Int = 2, amplitude: Double = 10000.0): ShortArray {
        val n = (seconds * rate).toInt()
        return ShortArray(n * channels) { i -> (amplitude * sin(2 * PI * freq * (i / channels) / rate)).toInt().toShort() }
    }

    /** Основная частота по числу переходов через ноль на левом канале. */
    private fun frequency(samples: ShortArray, rate: Int = OUT_RATE, channels: Int = 2): Double {
        var crossings = 0
        var previous = samples[0].toInt()
        for (i in 1 until samples.size / channels) {
            val v = samples[i * channels].toInt()
            if ((previous < 0 && v >= 0) || (previous > 0 && v <= 0)) crossings++
            previous = v
        }
        return crossings / 2.0 / (samples.size / channels / rate.toDouble())
    }

    @Test fun monoBecomesStereoWithSameSamples() {
        val out = AudioConverter(OUT_RATE, 1).convert(shortArrayOf(100, 200, 300, 400))
        assertEquals(8, out.size) // 4 отсчёта × 2 канала
        assertEquals(100, out[0].toInt()); assertEquals(100, out[1].toInt())
        assertEquals(200, out[2].toInt()); assertEquals(200, out[3].toInt())
    }

    @Test fun resamplingKeepsDurationAndPitchAcrossChunks() {
        val converter = AudioConverter(44100, 2)
        val source = sine(440.0, 1.0, 44100)
        val all = ArrayList<Short>()
        // Порциями по 1000 отсчётов: состояние между порциями не должно ломать звук.
        var i = 0
        while (i < source.size) {
            val end = minOf(source.size, i + 2000)
            all.addAll(converter.convert(source.copyOfRange(i, end)).toList())
            i = end
        }
        val out = all.toShortArray()
        val seconds = out.size / 2 / OUT_RATE.toDouble()
        assertEquals(1.0, seconds, 0.01)
        assertEquals(440.0, frequency(out), 5.0)
    }

    @Test fun gainScalesAndClips() {
        val out = AudioConverter(OUT_RATE, 2, gain = 2f).convert(shortArrayOf(1000, -1000, 30000, -30000))
        assertEquals(2000, out[0].toInt()); assertEquals(-2000, out[1].toInt())
        assertEquals(32767, out[2].toInt()); assertEquals(-32768, out[3].toInt())
        val silent = AudioConverter(OUT_RATE, 2, gain = 0f).convert(shortArrayOf(1000, -1000))
        assertEquals(0, peak(silent))
    }

    @Test fun surroundIsMixedDownWithoutOverflow() {
        val frame = shortArrayOf(10000, 10000, 10000, 10000, 10000, 10000) // все каналы по максимуму
        val out = AudioConverter(OUT_RATE, 6).convert(frame)
        assertEquals(2, out.size)
        assertTrue(out[0] in 9000..11000)
    }

    private fun stretch(speed: Double, freq: Double = 440.0, seconds: Double = 2.0): ShortArray {
        val stretcher = TimeStretcher()
        stretcher.speed = speed
        val source = sine(freq, seconds)
        val out = ArrayList<Short>()
        var i = 0
        while (i < source.size) {
            val end = minOf(source.size, i + 4096)
            stretcher.push(source.copyOfRange(i, end))
            out.addAll(stretcher.pull().toList())
            i = end
        }
        return out.toShortArray()
    }

    @Test fun fasterIsShorterAndKeepsPitch() {
        val out = stretch(2.0)
        val seconds = out.size / 2 / OUT_RATE.toDouble()
        assertEquals(1.0, seconds, 0.1)
        assertEquals(440.0, frequency(out), 25.0)
        assertTrue("громкость должна сохраниться", peak(out) > 8000)
    }

    @Test fun slowerIsLongerAndKeepsPitch() {
        val out = stretch(0.5)
        val seconds = out.size / 2 / OUT_RATE.toDouble()
        assertEquals(4.0, seconds, 0.2)
        assertEquals(440.0, frequency(out), 25.0)
    }

    @Test fun normalSpeedPassesThroughUnchanged() {
        val source = sine(440.0, 0.5)
        val stretcher = TimeStretcher()
        stretcher.push(source)
        assertArrayEquals(source, stretcher.pull())
    }

    @Test fun stretchedSoundHasNoLongGapsOrClicks() {
        val out = stretch(1.5, 220.0, 3.0)
        // Склейка кадров не должна давать резких скачков: соседние отсчёты не отличаются сильнее, чем у самой синусоиды.
        val maxStep = 2 * PI * 220.0 / OUT_RATE * 10000 * 3
        var worst = 0
        for (i in 1 until out.size / 2) worst = maxOf(worst, abs(out[i * 2].toInt() - out[(i - 1) * 2].toInt()))
        assertTrue("скачок $worst больше допустимого $maxStep", worst < maxStep)
    }

    @Test fun annexBConvertsToLengthPrefixed() {
        val annexB = byteArrayOf(0, 0, 0, 1, 0x67, 1, 2, 3, 0, 0, 1, 0x68, 9, 8, 0, 0, 0, 1, 0x65, 5, 5, 5, 5)
        val out = annexBToLengthPrefixed(annexB)
        assertArrayEquals(byteArrayOf(0, 0, 0, 4, 0x67, 1, 2, 3, 0, 0, 0, 3, 0x68, 9, 8, 0, 0, 0, 5, 0x65, 5, 5, 5, 5), out)
        val parts = splitAnnexB(annexB)
        assertEquals(3, parts.size)
        assertEquals(0x67, parts[0][0].toInt())
        assertEquals(0x65, parts[2][0].toInt())
    }
}
