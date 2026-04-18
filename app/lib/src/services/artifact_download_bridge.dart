import 'dart:io';

import 'package:flutter/services.dart';

class ArtifactDownloadBridge {
  const ArtifactDownloadBridge();

  static const MethodChannel _methodChannel = MethodChannel(
    'gemini_remote/artifact_downloads',
  );

  Future<void> enqueueArtifactDownload({
    required Uri url,
    required String token,
    required String filename,
    String? mimeType,
  }) async {
    if (!_isAndroid) {
      throw const ArtifactDownloadException(
        'Artifact downloads are currently supported on Android only.',
      );
    }

    final normalizedToken = token.trim();
    if (normalizedToken.isEmpty) {
      throw const ArtifactDownloadException('Missing host auth token.');
    }

    final normalizedFilename = filename.trim().isEmpty
        ? 'artifact.bin'
        : filename.trim();

    try {
      await _methodChannel.invokeMethod<int>('enqueueArtifactDownload', {
        'url': url.toString(),
        'token': normalizedToken,
        'filename': normalizedFilename,
        if (mimeType != null && mimeType.trim().isNotEmpty)
          'mimeType': mimeType.trim(),
      });
    } on MissingPluginException {
      throw const ArtifactDownloadException(
        'Download support is unavailable in this build.',
      );
    } on PlatformException catch (error) {
      throw ArtifactDownloadException(
        error.message ?? 'Could not start artifact download.',
      );
    }
  }

  bool get _isAndroid => Platform.isAndroid;
}

class ArtifactDownloadException implements Exception {
  const ArtifactDownloadException(this.message);

  final String message;

  @override
  String toString() => message;
}
