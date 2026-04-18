package com.geminiremote.gemini_remote_app

import android.content.Intent

const val sessionMonitorMethodChannel = "gemini_remote/session_monitor"
const val sessionMonitorEventChannel = "gemini_remote/notification_opens"

const val actionStartSessionMonitor =
    "com.geminiremote.gemini_remote_app.action.START_SESSION_MONITOR"
const val actionStopSessionMonitor =
    "com.geminiremote.gemini_remote_app.action.STOP_SESSION_MONITOR"
const val actionOpenSession =
    "com.geminiremote.gemini_remote_app.action.OPEN_SESSION"

const val extraBaseUrl = "baseUrl"
const val extraToken = "token"
const val extraSessionIds = "sessionIds"
const val extraSessionId = "sessionId"
const val extraWorkspaceId = "workspaceId"

data class SessionNotificationTarget(
    val workspaceId: String,
    val sessionId: String,
) {
    fun toMap(): Map<String, String> =
        mapOf(
            extraWorkspaceId to workspaceId,
            extraSessionId to sessionId,
        )

    companion object {
        fun fromIntent(intent: Intent?): SessionNotificationTarget? {
            if (intent?.action != actionOpenSession) {
                return null
            }

            val workspaceId = intent.getStringExtra(extraWorkspaceId)?.trim().orEmpty()
            val sessionId = intent.getStringExtra(extraSessionId)?.trim().orEmpty()
            if (workspaceId.isEmpty() || sessionId.isEmpty()) {
                return null
            }

            return SessionNotificationTarget(
                workspaceId = workspaceId,
                sessionId = sessionId,
            )
        }
    }
}
