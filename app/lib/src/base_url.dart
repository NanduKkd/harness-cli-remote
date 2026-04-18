Uri resolveBaseUrlPath(
  String baseUrl,
  String path, {
  Map<String, String>? queryParameters,
}) {
  final base = Uri.parse(baseUrl);
  final resolvedPath = _joinPaths(base.path, path);
  return Uri(
    scheme: base.scheme,
    userInfo: base.userInfo,
    host: base.host,
    port: base.hasPort ? base.port : null,
    path: resolvedPath,
    queryParameters: queryParameters,
  );
}

String normalizeBaseUrl(String input) {
  final trimmed = input.trim();
  if (trimmed.isEmpty) {
    return trimmed;
  }

  final withScheme =
      trimmed.startsWith('http://') || trimmed.startsWith('https://')
      ? trimmed
      : 'http://$trimmed';
  final uri = Uri.tryParse(withScheme);
  if (uri == null || uri.host.isEmpty) {
    throw const FormatException('Enter a valid host URL.');
  }
  if (uri.scheme != 'http' && uri.scheme != 'https') {
    throw const FormatException(
      'Host URL must start with http:// or https://.',
    );
  }

  return Uri(
    scheme: uri.scheme,
    userInfo: uri.userInfo,
    host: uri.host,
    port: uri.hasPort ? uri.port : null,
    path: _normalizeBasePath(uri.path),
  ).toString();
}

String _joinPaths(String basePath, String nextPath) {
  final normalizedBase = _normalizeBasePath(basePath);
  final normalizedNext = _normalizeNextPath(nextPath);
  if (normalizedBase.isEmpty) {
    return normalizedNext;
  }
  if (normalizedNext.isEmpty) {
    return normalizedBase;
  }
  return '$normalizedBase$normalizedNext';
}

String _normalizeBasePath(String path) {
  if (path.isEmpty || path == '/') {
    return '';
  }
  return path.replaceFirst(RegExp(r'/+$'), '');
}

String _normalizeNextPath(String path) {
  if (path.isEmpty || path == '/') {
    return '';
  }

  final withLeadingSlash = path.startsWith('/') ? path : '/$path';
  return withLeadingSlash.replaceFirst(RegExp(r'/+$'), '');
}
