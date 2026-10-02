package com.vrcast.vrcast_remote

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/** Службе переднего плана положено держать запись экрана: Android 10+ иначе её обрывает. */
class ScreenShareService : Service() {
    companion object {
        /** true, когда служба уже вызвала startForeground: только после этого можно брать запись экрана. */
        @Volatile var foreground = false
    }

    override fun onDestroy() {
        foreground = false
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val channel = "screen_share"
        getSystemService(NotificationManager::class.java)
            .createNotificationChannel(NotificationChannel(channel, "Трансляция экрана", NotificationManager.IMPORTANCE_LOW))
        val notification = Notification.Builder(this, channel)
            .setContentTitle("VRCast Bridge")
            .setContentText("Экран телефона транслируется на ПК")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 29) startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        else startForeground(1, notification)
        foreground = true
        return START_NOT_STICKY
    }
}
