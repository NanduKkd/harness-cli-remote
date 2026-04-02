import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../models.dart';

class AuthStorage {
  const AuthStorage();

  static const _baseUrlKey = 'base_url';
  static const _tokenKey = 'token';

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
  }

  Future<void> clear() async {
    await _storage.delete(key: _baseUrlKey);
    await _storage.delete(key: _tokenKey);
  }
}
