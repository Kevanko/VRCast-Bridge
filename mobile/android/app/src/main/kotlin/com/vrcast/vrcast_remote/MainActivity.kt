package com.vrcast.vrcast_remote

import android.content.Intent
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.BasicMessageChannel
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.StandardMessageCodec
import java.io.File
import java.io.FileOutputStream
import kotlin.concurrent.thread

class MainActivity : FlutterActivity() {
    private var engine: TranscodeEngine? = null
    private var engineSession = 0

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        // Движок перекодирования: команды по одному каналу, готовые кадры (H.264 и AAC) по другому.
        val frames = BasicMessageChannel(flutterEngine.dartExecutor.binaryMessenger, "vrcast/engine/frames", StandardMessageCodec.INSTANCE)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "vrcast/engine").setMethodCallHandler { call, result ->
            when (call.method) {
                "start" -> {
                    engine?.stop()
                    val a = call.arguments as Map<*, *>
                    @Suppress("UNCHECKED_CAST")
                    val params = TranscodeEngine.Params(
                        videoSource = a["videoSource"] as String?,
                        audioSource = a["audioSource"] as String?,
                        startUs = (a["startUs"] as Number).toLong(),
                        width = (a["width"] as Number).toInt(),
                        height = (a["height"] as Number).toInt(),
                        fps = (a["fps"] as Number).toInt(),
                        videoBitrate = (a["videoBitrate"] as Number).toInt(),
                        audioBitrate = (a["audioBitrate"] as Number).toInt(),
                        volume = (a["volume"] as Number).toFloat(),
                        speed = (a["speed"] as Number).toFloat(),
                        headers = a["headers"] as Map<String, String>?,
                    )
                    val session = ++engineSession
                    val created = TranscodeEngine { message -> runOnUiThread { frames.send(message + ("session" to session)) } }
                    engine = created
                    created.start(params)
                    result.success(session)
                }
                "pause" -> { engine?.pause(); result.success(null) }
                "resume" -> { engine?.resume(); result.success(null) }
                "stop" -> { engine?.stop(); engine = null; result.success(null) }
                "volume" -> { engine?.setVolume((call.argument<Number>("value") ?: 1).toFloat()); result.success(null) }
                else -> result.notImplemented()
            }
        }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "vrcast/screen").setMethodCallHandler { call, result ->
            when (call.method) {
                "start" -> {
                    ContextCompat.startForegroundService(this, Intent(this, ScreenShareService::class.java))
                    // Ждём, пока служба станет foreground (до 3 с): запись экрана без неё Android отклоняет.
                    val handler = Handler(Looper.getMainLooper())
                    var waited = 0
                    handler.post(object : Runnable {
                        override fun run() {
                            if (ScreenShareService.foreground || waited >= 3000) result.success(null)
                            else { waited += 50; handler.postDelayed(this, 50) }
                        }
                    })
                }
                "stop" -> { stopService(Intent(this, ScreenShareService::class.java)); result.success(null) }
                // Эфир файлов: служба держит приложение живым при погашенном экране.
                "broadcastStart" -> { ContextCompat.startForegroundService(this, Intent(this, BroadcastService::class.java)); result.success(null) }
                "broadcastStop" -> { stopService(Intent(this, BroadcastService::class.java)); result.success(null) }
                "nativeLibraryDir" -> result.success(applicationInfo.nativeLibraryDir)
                // Обложка и длительность файла на телефоне: как превью и время у роликов на ПК.
                "probeFile" -> {
                    val path = call.argument<String>("path") ?: ""
                    val id = call.argument<String>("id") ?: "x"
                    thread {
                        var answer: Map<String, Any?>? = null
                        try {
                            val retriever = MediaMetadataRetriever()
                            try {
                                retriever.setDataSource(path)
                                val duration = (retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toDoubleOrNull() ?: 0.0) / 1000.0
                                var thumb: String? = null
                                val frame = retriever.getFrameAtTime(1_000_000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC) ?: retriever.getFrameAtTime(0)
                                if (frame != null) {
                                    val width = 320
                                    val scaled = Bitmap.createScaledBitmap(frame, width, (frame.height * width / frame.width.coerceAtLeast(1)).coerceAtLeast(1), true)
                                    val dir = File(cacheDir, "thumbs").apply { mkdirs() }
                                    val out = File(dir, "$id.jpg")
                                    FileOutputStream(out).use { scaled.compress(Bitmap.CompressFormat.JPEG, 80, it) }
                                    thumb = out.absolutePath
                                }
                                answer = mapOf("duration" to duration, "thumbnail" to thumb)
                            } finally {
                                retriever.release()
                            }
                        } catch (_: Throwable) {
                        }
                        runOnUiThread { result.success(answer) }
                    }
                }
                else -> result.notImplemented()
            }
        }
    }
}
