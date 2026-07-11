package app.novaclaw

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log

/**
 * Servicio en primer plano que mantiene VIVO el agente de NovaClaw cuando la app
 * pasa a segundo plano o se apaga la pantalla.
 *
 * Por qué hace falta: el agente (node) es un proceso hijo del grupo de la app.
 * Android puede matar ese grupo cuando la Activity queda en background. Un
 * foreground service sube la prioridad del proceso (oom_adj) y un PARTIAL_WAKE_LOCK
 * evita que la CPU se duerma, así el agente sigue respondiendo en 127.0.0.1:8088.
 *
 * El servicio es DUEÑO del proceso del agente (tiene su propio RuntimeManager), de
 * modo que sobrevive aunque se destruya MainActivity. Se corta solo desde la acción
 * "Detener" de la notificación.
 */
class NovaClawService : Service() {

    companion object {
        private const val TAG = "NovaClaw/Service"
        private const val CHANNEL_ID = "novaclaw_agent"
        private const val NOTIF_ID = 1001
        const val ACTION_START = "app.novaclaw.action.START_AGENT"
        const val ACTION_STOP = "app.novaclaw.action.STOP_AGENT"
        const val EXTRA_PORT = "port"

        /** true mientras el agente corre bajo el servicio. */
        @Volatile
        var isRunning = false
            private set

        fun start(context: Context, port: Int) {
            val intent = Intent(context, NovaClawService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_PORT, port)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.startService(
                Intent(context, NovaClawService::class.java).apply { action = ACTION_STOP },
            )
        }
    }

    private lateinit var runtime: RuntimeManager
    private var wakeLock: PowerManager.WakeLock? = null
    private var port = 8088

    override fun onCreate() {
        super.onCreate()
        runtime = RuntimeManager(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopEverything()
            return START_NOT_STICKY
        }

        port = intent?.getIntExtra(EXTRA_PORT, 8088) ?: 8088
        // Debe llamarse dentro de los ~5s de startForegroundService o el SO mata el servicio.
        // Con targetSdk 34 (Android 14+) el tipo del servicio es OBLIGATORIO acá,
        // además de declararlo en el manifest — si falta, crashea con
        // MissingForegroundServiceTypeException.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIF_ID, buildNotification())
        }
        acquireWakeLock()
        startAgentIfNeeded()
        // START_STICKY: si el SO lo mata por memoria, lo reintenta cuando puede.
        return START_STICKY
    }

    private fun startAgentIfNeeded() {
        if (isRunning) return
        val ok = runtime.startAgent(port) { line -> Log.d(TAG, "[agent] $line") }
        isRunning = ok
        if (!ok) Log.w(TAG, "El agente no arrancó desde el servicio.")
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "NovaClaw::AgentWakeLock").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun releaseWakeLock() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
    }

    private fun stopEverything() {
        runtime.stopAgent()
        isRunning = false
        releaseWakeLock()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        super.onDestroy()
        runtime.stopAgent()
        isRunning = false
        releaseWakeLock()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun buildNotification(): Notification {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "NovaClaw Agent",
                NotificationManager.IMPORTANCE_LOW,
            ).apply { description = "Mantiene el agente de NovaClaw corriendo en segundo plano." }
            nm.createNotificationChannel(channel)
        }

        val openIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply { flags = Intent.FLAG_ACTIVITY_SINGLE_TOP },
            PendingIntent.FLAG_IMMUTABLE,
        )
        val stopIntent = PendingIntent.getService(
            this,
            1,
            Intent(this, NovaClawService::class.java).apply { action = ACTION_STOP },
            PendingIntent.FLAG_IMMUTABLE,
        )

        @Suppress("DEPRECATION")
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            Notification.Builder(this)
        }

        @Suppress("DEPRECATION")
        return builder
            .setContentTitle("NovaClaw activo")
            .setContentText("El agente está corriendo en segundo plano.")
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(openIntent)
            .setOngoing(true)
            .addAction(R.drawable.ic_notification, "Detener", stopIntent)
            .build()
    }
}
