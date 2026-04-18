package com.geminiremote.gemini_remote_app

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.math.min

class SessionMonitorService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private val activeSessionIds = linkedSetOf<String>()
    private val workspaceIdBySessionId = mutableMapOf<String, String>()
    private val completedMessageByRunKey = mutableMapOf<String, String>()
    private val notificationKeys = linkedSetOf<String>()
    private val okHttpClient by lazy {
        OkHttpClient.Builder()
            .pingInterval(20, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build()
    }

    private var baseUrl: String? = null
    private var token: String? = null
    private var webSocket: WebSocket? = null
    private var reconnectAttempt = 0
    private var reconnectRunnable: Runnable? = null
    private var shuttingDown = false
    private var connectionStatusText = "Connecting to host"

    override fun onCreate() {
        super.onCreate()
        createNotificationChannels()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            actionStopSessionMonitor -> {
                shuttingDown = true
                stopSelf()
                return START_NOT_STICKY
            }
            actionStartSessionMonitor, null -> {
                val nextBaseUrl = intent?.getStringExtra(extraBaseUrl)?.trim().orEmpty()
                val nextToken = intent?.getStringExtra(extraToken)?.trim().orEmpty()
                if (nextBaseUrl.isEmpty() || nextToken.isEmpty()) {
                    stopSelf()
                    return START_NOT_STICKY
                }

                val nextSessionIds = intent
                    ?.getStringArrayListExtra(extraSessionIds)
                    ?.map { it.trim() }
                    ?.filter { it.isNotEmpty() }
                    .orEmpty()

                activeSessionIds.addAll(nextSessionIds)
                val authChanged = nextBaseUrl != baseUrl || nextToken != token
                baseUrl = nextBaseUrl
                token = nextToken
                shuttingDown = false
                connectionStatusText = if (webSocket == null || authChanged) {
                    "Connecting to host"
                } else {
                    connectionStatusText
                }

                val startedForeground = runCatching {
                    startForeground(foregroundNotificationId, buildForegroundNotification())
                }.isSuccess
                if (!startedForeground) {
                    stopSelf()
                    return START_NOT_STICKY
                }
                if (authChanged || webSocket == null) {
                    connect(resetBackoff = true)
                } else {
                    updateForegroundNotification()
                }
                return START_STICKY
            }
            else -> return START_NOT_STICKY
        }
    }

    override fun onDestroy() {
        shuttingDown = true
        reconnectRunnable?.let(handler::removeCallbacks)
        reconnectRunnable = null
        webSocket?.cancel()
        webSocket = null
        okHttpClient.dispatcher.executorService.shutdown()
        okHttpClient.connectionPool.evictAll()
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    private fun connect(resetBackoff: Boolean) {
        val nextBaseUrl = baseUrl ?: return
        val nextToken = token ?: return
        val websocketUrl = runCatching {
            buildWebSocketUrl(nextBaseUrl, nextToken)
        }.getOrNull() ?: run {
            stopSelf()
            return
        }

        if (resetBackoff) {
            reconnectAttempt = 0
        }
        reconnectRunnable?.let(handler::removeCallbacks)
        reconnectRunnable = null
        webSocket?.cancel()
        webSocket = null
        connectionStatusText = "Connecting to host"
        updateForegroundNotification()

        val request = Request.Builder()
            .url(websocketUrl)
            .build()

        webSocket = okHttpClient.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    reconnectAttempt = 0
                    connectionStatusText = "Watching active sessions"
                    updateForegroundNotification()
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    handleMessage(text)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    handleDisconnect()
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, reason)
                }

                override fun onFailure(
                    webSocket: WebSocket,
                    t: Throwable,
                    response: Response?,
                ) {
                    handleDisconnect()
                }
            },
        )
    }

    private fun handleDisconnect() {
        webSocket = null
        if (shuttingDown || activeSessionIds.isEmpty()) {
            stopSelf()
            return
        }

        val delayMillis = min(
            30_000L,
            (1 shl reconnectAttempt.coerceAtMost(5)).toLong() * 1_000L,
        )
        reconnectAttempt += 1
        connectionStatusText = "Reconnecting in ${delayMillis / 1000}s"
        updateForegroundNotification()

        reconnectRunnable?.let(handler::removeCallbacks)
        reconnectRunnable = Runnable {
            reconnectRunnable = null
            connect(resetBackoff = false)
        }
        handler.postDelayed(reconnectRunnable!!, delayMillis)
    }

    private fun handleMessage(text: String) {
        val root = runCatching { JSONObject(text) }.getOrNull() ?: return
        if (root.optString("type") != "session.event") {
            return
        }

        val sessionId = root.optString("sessionId").trim()
        val workspaceId = root.optString("workspaceId").trim()
        if (sessionId.isEmpty() || workspaceId.isEmpty()) {
            return
        }

        workspaceIdBySessionId[sessionId] = workspaceId
        val event = root.optJSONObject("event") ?: return
        when (event.optString("type")) {
            "run.started" -> {
                activeSessionIds.add(sessionId)
                connectionStatusText = "Watching active sessions"
                updateForegroundNotification()
            }
            "message.completed" -> cacheCompletedMessage(sessionId, event)
            "run.completed" -> {
                showCompletionNotification(
                    sessionId = sessionId,
                    workspaceId = workspaceId,
                    event = event,
                    messageText = popCompletedMessage(sessionId, event),
                )
                activeSessionIds.remove(sessionId)
                if (activeSessionIds.isEmpty()) {
                    stopSelf()
                } else {
                    updateForegroundNotification()
                }
            }
            "run.failed", "run.cancelled" -> {
                clearCompletedMessage(sessionId, event)
                activeSessionIds.remove(sessionId)
                if (activeSessionIds.isEmpty()) {
                    stopSelf()
                } else {
                    updateForegroundNotification()
                }
            }
        }
    }

    private fun showCompletionNotification(
        sessionId: String,
        workspaceId: String,
        event: JSONObject,
        messageText: String?,
    ) {
        if (!canPostNotifications()) {
            return
        }

        val seq = event.optInt("seq", 0)
        val runId = event.optString("runId").trim()
        val key = "$workspaceId:$sessionId:$runId:$seq:run.completed"
        if (!notificationKeys.add(key)) {
            return
        }
        trimNotificationCache()

        val body = summarizeBody(messageText)
        val title = "Response completed"
        val notification = NotificationCompat.Builder(this, completionChannelId)
            .setSmallIcon(R.drawable.ic_stat_remote)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(buildSessionPendingIntent(workspaceId, sessionId))
            .build()

        notifySafely(key.hashCode() and Int.MAX_VALUE, notification)
    }

    private fun cacheCompletedMessage(sessionId: String, event: JSONObject) {
        val text = event.optJSONObject("payload")?.optString("text")?.trim().orEmpty()
        if (text.isEmpty()) {
            return
        }

        completedMessageByRunKey[runKey(sessionId, event)] = text
    }

    private fun popCompletedMessage(sessionId: String, event: JSONObject): String? {
        return completedMessageByRunKey.remove(runKey(sessionId, event))
    }

    private fun clearCompletedMessage(sessionId: String, event: JSONObject) {
        completedMessageByRunKey.remove(runKey(sessionId, event))
    }

    private fun runKey(sessionId: String, event: JSONObject): String {
        val runId = event.optString("runId").trim()
        return if (runId.isEmpty()) {
            sessionId
        } else {
            "$sessionId:$runId"
        }
    }

    private fun trimNotificationCache() {
        while (notificationKeys.size > 256) {
            val oldest = notificationKeys.firstOrNull() ?: return
            notificationKeys.remove(oldest)
        }
    }

    private fun updateForegroundNotification() {
        if (!canPostNotifications()) {
            return
        }

        notifySafely(foregroundNotificationId, buildForegroundNotification())
    }

    private fun buildForegroundNotification(): Notification {
        val activeCount = activeSessionIds.size
        val title = when (activeCount) {
            0 -> "Watching session updates"
            1 -> "1 session running"
            else -> "$activeCount sessions running"
        }
        val body = if (activeCount == 0) {
            connectionStatusText
        } else {
            "Gemini Remote is keeping the host connection alive. $connectionStatusText."
        }

        return NotificationCompat.Builder(this, foregroundChannelId)
            .setSmallIcon(R.drawable.ic_stat_remote)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(buildForegroundPendingIntent())
            .build()
    }

    private fun buildForegroundPendingIntent(): PendingIntent {
        val singleSessionId = activeSessionIds.singleOrNull()
        val workspaceId = if (singleSessionId == null) {
            null
        } else {
            workspaceIdBySessionId[singleSessionId]
        }

        val intent = if (singleSessionId != null && workspaceId != null) {
            buildSessionIntent(workspaceId, singleSessionId)
        } else {
            packageManager.getLaunchIntentForPackage(packageName)
                ?: Intent(this, MainActivity::class.java)
        }.apply {
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }

        return PendingIntent.getActivity(
            this,
            foregroundNotificationId,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun buildSessionPendingIntent(
        workspaceId: String,
        sessionId: String,
    ): PendingIntent {
        val intent = buildSessionIntent(workspaceId, sessionId)
            .apply {
                addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            }

        return PendingIntent.getActivity(
            this,
            "$workspaceId:$sessionId".hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun buildSessionIntent(workspaceId: String, sessionId: String): Intent =
        Intent(this, MainActivity::class.java).apply {
            action = actionOpenSession
            putExtra(extraWorkspaceId, workspaceId)
            putExtra(extraSessionId, sessionId)
        }

    private fun summarizeBody(raw: String?): String {
        val trimmed = raw?.trim().orEmpty()
        if (trimmed.isEmpty()) {
            return "The latest prompt response is ready."
        }

        val firstLine = trimmed
            .lineSequence()
            .map { it.trim() }
            .firstOrNull { it.isNotEmpty() }
            ?: return "The latest prompt response is ready."

        return if (firstLine.length > 160) {
            "${firstLine.take(157)}..."
        } else {
            firstLine
        }
    }

    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }

        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(
                foregroundChannelId,
                "Session monitor",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Foreground service for active remote sessions."
                setShowBadge(false)
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(
                completionChannelId,
                "Prompt completions",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "Notifications when a prompt response is ready."
            },
        )
    }

    private fun buildWebSocketUrl(baseUrl: String, token: String): String? {
        val httpUri = Uri.parse(baseUrl)
        val inputScheme = httpUri.scheme?.lowercase() ?: return null
        val websocketScheme = when (inputScheme) {
            "https" -> "wss"
            "http" -> "ws"
            else -> return null
        }
        val authority = httpUri.encodedAuthority ?: return null
        val encodedBasePath = httpUri.encodedPath?.let(::normalizeBasePath).orEmpty()
        val websocketPath = if (encodedBasePath.isEmpty()) {
            "/ws"
        } else {
            "$encodedBasePath/ws"
        }

        return httpUri.buildUpon()
            .scheme(websocketScheme)
            .encodedAuthority(authority)
            .encodedPath(websocketPath)
            .query(null)
            .fragment(null)
            .appendQueryParameter("token", token)
            .build()
            .toString()
    }

    private fun normalizeBasePath(path: String): String {
        if (path.isEmpty() || path == "/") {
            return ""
        }
        return path.trimEnd('/')
    }

    private fun canPostNotifications(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return true
        }

        return ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
    }

    private fun notifySafely(id: Int, notification: Notification) {
        runCatching {
            NotificationManagerCompat.from(this).notify(id, notification)
        }
    }

    companion object {
        private const val foregroundChannelId = "session_monitor_status"
        private const val completionChannelId = "session_prompt_completion"
        private const val foregroundNotificationId = 4010

        fun start(
            context: Context,
            baseUrl: String,
            token: String,
            sessionIds: List<String>,
        ): Boolean {
            val intent = Intent(context, SessionMonitorService::class.java).apply {
                action = actionStartSessionMonitor
                putExtra(extraBaseUrl, baseUrl)
                putExtra(extraToken, token)
                putStringArrayListExtra(extraSessionIds, ArrayList(sessionIds))
            }
            return runCatching {
                ContextCompat.startForegroundService(context, intent)
            }.isSuccess
        }

        fun stop(context: Context): Boolean {
            val intent = Intent(context, SessionMonitorService::class.java).apply {
                action = actionStopSessionMonitor
            }
            return runCatching {
                context.startService(intent)
            }.isSuccess
        }
    }
}
