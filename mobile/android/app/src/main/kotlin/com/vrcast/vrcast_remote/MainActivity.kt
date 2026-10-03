package com.vrcast.vrcast_remote

import android.content.Intent
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.io.FileOutputStream
import kotlin.concurrent.thread

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
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
