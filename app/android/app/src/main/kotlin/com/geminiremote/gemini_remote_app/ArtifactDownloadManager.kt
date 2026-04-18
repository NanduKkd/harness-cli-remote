package com.geminiremote.gemini_remote_app

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import java.io.File

const val artifactDownloadMethodChannel = "gemini_remote/artifact_downloads"
const val enqueueArtifactDownloadMethod = "enqueueArtifactDownload"

object ArtifactDownloadManager {
    fun enqueue(
        context: Context,
        url: String,
        token: String,
        filename: String,
        mimeType: String?,
    ): Long {
        val downloadManager =
            context.getSystemService(Context.DOWNLOAD_SERVICE) as? DownloadManager
                ?: throw IllegalStateException("Download manager is unavailable.")

        val normalizedUrl = url.trim()
        if (normalizedUrl.isEmpty()) {
            throw IllegalArgumentException("Download URL is required.")
        }

        val normalizedToken = token.trim()
        if (normalizedToken.isEmpty()) {
            throw IllegalArgumentException("Download token is required.")
        }

        val safeFilename = sanitizeFilename(filename)
        val destinationName = reserveDestinationName(context, safeFilename)

        val request =
            DownloadManager.Request(Uri.parse(normalizedUrl))
                .setTitle(destinationName)
                .setDescription("Gemini Remote artifact")
                .setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED,
                )
                .setAllowedOverMetered(true)
                .setAllowedOverRoaming(true)
                .addRequestHeader("Authorization", "Bearer $normalizedToken")
        applyDestination(context, request, destinationName)

        val normalizedMimeType = mimeType?.trim().orEmpty()
        if (normalizedMimeType.isNotEmpty()) {
            request.setMimeType(normalizedMimeType)
        }

        return downloadManager.enqueue(request)
    }

    private fun reserveDestinationName(context: Context, filename: String): String {
        val directory = resolveDestinationDirectory(context)
            ?: return filename

        val (stem, extension) = splitFilename(filename)
        var candidate = filename
        var index = 2
        while (File(directory, candidate).exists()) {
            candidate = "$stem ($index)$extension"
            index += 1
        }

        return candidate
    }

    @Suppress("DEPRECATION")
    private fun applyDestination(
        context: Context,
        request: DownloadManager.Request,
        filename: String,
    ) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            request.setDestinationInExternalPublicDir(
                Environment.DIRECTORY_DOWNLOADS,
                filename,
            )
            return
        }

        request.setDestinationInExternalFilesDir(
            context,
            Environment.DIRECTORY_DOWNLOADS,
            filename,
        )
    }

    @Suppress("DEPRECATION")
    private fun resolveDestinationDirectory(context: Context): File? {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return Environment.getExternalStoragePublicDirectory(
                Environment.DIRECTORY_DOWNLOADS,
            )
        }
        return context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
    }

    private fun splitFilename(filename: String): Pair<String, String> {
        val dotIndex = filename.lastIndexOf('.')
        if (dotIndex <= 0 || dotIndex == filename.length - 1) {
            return filename to ""
        }

        return filename.substring(0, dotIndex) to filename.substring(dotIndex)
    }

    private fun sanitizeFilename(raw: String): String {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) {
            return "artifact.bin"
        }

        val cleaned = trimmed.replace(Regex("[\\\\/:*?\"<>|]"), "_")
        return cleaned.ifBlank { "artifact.bin" }
    }
}
