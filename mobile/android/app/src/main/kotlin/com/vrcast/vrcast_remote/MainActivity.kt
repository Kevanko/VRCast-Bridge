package com.vrcast.vrcast_remote

import android.content.Intent
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

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
                else -> result.notImplemented()
            }
        }
    }
}
