package com.geminiremote.gemini_remote_app

import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity() {
    private var eventSink: EventChannel.EventSink? = null
    private var pendingTarget: SessionNotificationTarget? = null

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        dispatchNotificationTarget(intent)
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            artifactDownloadMethodChannel,
        ).setMethodCallHandler { call, result ->
            when (call.method) {
                enqueueArtifactDownloadMethod -> {
                    val url = call.argument<String>("url")?.trim().orEmpty()
                    val token = call.argument<String>("token")?.trim().orEmpty()
                    val filename = call.argument<String>("filename")?.trim().orEmpty()
                    val mimeType = call.argument<String>("mimeType")?.trim()

                    if (url.isEmpty() || token.isEmpty() || filename.isEmpty()) {
                        result.error(
                            "invalid_args",
                            "url, token, and filename are required.",
                            null,
                        )
                        return@setMethodCallHandler
                    }

                    try {
                        val downloadId = ArtifactDownloadManager.enqueue(
                            context = this,
                            url = url,
                            token = token,
                            filename = filename,
                            mimeType = mimeType,
                        )
                        result.success(downloadId)
                    } catch (error: IllegalArgumentException) {
                        result.error("invalid_args", error.message, null)
                    } catch (error: IllegalStateException) {
                        result.error("unavailable", error.message, null)
                    } catch (error: SecurityException) {
                        result.error("permission_denied", error.message, null)
                    } catch (error: Exception) {
                        result.error("download_failed", error.message, null)
                    }
                }
                else -> result.notImplemented()
            }
        }

        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            sessionMonitorMethodChannel,
        ).setMethodCallHandler { call, result ->
            when (call.method) {
                "startSessionMonitor" -> {
                    val baseUrl = call.argument<String>(extraBaseUrl)?.trim().orEmpty()
                    val token = call.argument<String>(extraToken)?.trim().orEmpty()
                    val sessionIds = call.argument<List<String>>(extraSessionIds)
                        ?.map { it.trim() }
                        ?.filter { it.isNotEmpty() }
                        .orEmpty()

                    if (baseUrl.isEmpty() || token.isEmpty() || sessionIds.isEmpty()) {
                        result.success(null)
                        return@setMethodCallHandler
                    }

                    val started = SessionMonitorService.start(
                        context = this,
                        baseUrl = baseUrl,
                        token = token,
                        sessionIds = sessionIds,
                    )
                    result.success(started)
                }
                "stopSessionMonitor" -> {
                    result.success(SessionMonitorService.stop(this))
                }
                "consumeInitialNotificationTarget" -> {
                    val target = pendingTarget
                    pendingTarget = null
                    result.success(target?.toMap())
                }
                else -> result.notImplemented()
            }
        }

        EventChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            sessionMonitorEventChannel,
        ).setStreamHandler(
            object : EventChannel.StreamHandler {
                override fun onListen(
                    arguments: Any?,
                    events: EventChannel.EventSink,
                ) {
                    eventSink = events
                    val target = pendingTarget
                    if (target != null) {
                        pendingTarget = null
                        events.success(target.toMap())
                    }
                }

                override fun onCancel(arguments: Any?) {
                    eventSink = null
                }
            },
        )

        dispatchNotificationTarget(intent)
    }

    private fun dispatchNotificationTarget(intent: android.content.Intent?) {
        val target = SessionNotificationTarget.fromIntent(intent) ?: return
        val sink = eventSink
        if (sink == null) {
            pendingTarget = target
            return
        }

        pendingTarget = null
        sink.success(target.toMap())
    }
}
