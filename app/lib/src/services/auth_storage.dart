import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../models.dart';

class AuthStorage {
  const AuthStorage();

  static const _baseUrlKey = 'base_url';
  static const _tokenKey = 'token';
  static const _recentHostsKey = 'recent_hosts';
  static const _recentHostsLimit = 5;

  FlutterSecureStorage get _storage => const FlutterSecureStorage();

  Future<AuthSession?> read() async {
    final baseUrl = await _storage.read(key: _baseUrlKey);
    final token = await _storage.read(key: _tokenKey);
    if (baseUrl == null || token == null) {
      return null;
    }

    return AuthSession(baseUrl: baseUrl, token: token);
  }

  Future<void> write(AuthSession session) async {
    await _storage.write(key: _baseUrlKey, value: session.baseUrl);
    await _storage.write(key: _tokenKey, value: session.token);
    await writeRecentHost(session.baseUrl);
  }

  Future<void> clear() async {
    await _storage.delete(key: _baseUrlKey);
    await _storage.delete(key: _tokenKey);
  }

  Future<List<String>> readRecentHosts() async {
    final raw = await _storage.read(key: _recentHostsKey);
    if (raw == null || raw.trim().isEmpty) {
      return <String>[];
    }

    final decoded = jsonDecode(raw);
    if (decoded is! List) {
      return <String>[];
    }

    return decoded
        .whereType<String>()
        .map((host) => host.trim())
        .where((host) => host.isNotEmpty)
        .toList(growable: true);
  }

  Future<void> writeRecentHost(String baseUrl) async {
    final trimmed = baseUrl.trim();
    if (trimmed.isEmpty) {
      return;
    }

    final hosts = await readRecentHosts();
    hosts.remove(trimmed);
    hosts.insert(0, trimmed);

    final limitedHosts = hosts.take(_recentHostsLimit).toList(growable: false);
    await _storage.write(key: _recentHostsKey, value: jsonEncode(limitedHosts));
  }
}
