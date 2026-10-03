package com.vrcast.vrcast_remote

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * Эфир файлов с телефона идёт из приложения, а не из системной записи экрана. Без службы переднего плана Android
 * замораживает приложение при погашенном экране, и эфир обрывается. Служба заодно держит процессор и Wi-Fi.
 */
class BroadcastService : Service() {
    private var wake: PowerManager.WakeLock? = null
    private var wifi: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val channel = "broadcast"
        getSystemService(NotificationManager::class.java)
            .createNotificationChannel(NotificationChannel(channel, "Эфир с телефона", NotificationManager.IMPORTANCE_LOW))
        val notification = Notification.Builder(this, channel)
            .setContentTitle("VRCast Bridge")
            .setContentText("Идёт эфир с телефона")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 29) startForeground(2, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        else startForeground(2, notification)
        if (wake == null) {
            wake = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "vrcast:broadcast").apply { acquire() }
            @Suppress("DEPRECATION")
            wifi = applicationContext.getSystemService(WifiManager::class.java)
                .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "vrcast:broadcast").apply { acquire() }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        wake?.takeIf { it.isHeld }?.release()
        wifi?.takeIf { it.isHeld }?.release()
        wake = null
        wifi = null
        super.onDestroy()
    }
}
