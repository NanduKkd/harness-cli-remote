import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models.dart';
import '../services/api_client.dart';
import '../services/auth_storage.dart';
import '../services/realtime_service.dart';

final authStorageProvider = Provider<AuthStorage>((ref) => const AuthStorage());

final authControllerProvider =
    StateNotifierProvider<AuthController, AsyncValue<AuthSession?>>((ref) {
  final controller = AuthController(ref.read(authStorageProvider));
  unawaited(controller.load());
  return controller;
});

final apiClientProvider = Provider<ApiClient?>((ref) {
  final auth = ref.watch(authControllerProvider).valueOrNull;
  return auth == null ? null : ApiClient(auth);
});

final realtimeServiceProvider = Provider<RealtimeService>((ref) {
  final service = RealtimeService();
  ref.onDispose(service.dispose);
  return service;
});

final workspacesProvider = FutureProvider<List<Workspace>>((ref) async {
  final api = ref.watch(apiClientProvider);
  if (api == null) {
    return const [];
  }

  return api.listWorkspaces();
});

final sessionsProvider =
    FutureProvider.family<List<RemoteSession>, String>((ref, workspaceId) async {
  final api = ref.watch(apiClientProvider);
  if (api == null) {
    return const [];
  }

  return api.listSessions(workspaceId);
});

class AuthController extends StateNotifier<AsyncValue<AuthSession?>> {
  AuthController(this._storage) : super(const AsyncValue.loading());

  final AuthStorage _storage;

  Future<void> load() async {
    state = const AsyncValue.loading();
    state = await AsyncValue.guard(_storage.read);
  }

  Future<void> pair({
    required String baseUrl,
    required String code,
  }) async {
    final normalizedUrl = normalizeBaseUrl(baseUrl);
    state = const AsyncValue.loading();
    state = await AsyncValue.guard(() async {
      final token = await ApiClient.pair(baseUrl: normalizedUrl, code: code);
      final auth = AuthSession(baseUrl: normalizedUrl, token: token);
      await _storage.write(auth);
      return auth;
    });
  }

  Future<void> signOut() async {
    await _storage.clear();
    state = const AsyncValue.data(null);
  }
}

String normalizeBaseUrl(String input) {
  final trimmed = input.trim();
  if (trimmed.isEmpty) {
    return trimmed;
  }

  final withScheme = trimmed.startsWith('http://') || trimmed.startsWith('https://')
      ? trimmed
      : 'http://$trimmed';
  final uri = Uri.parse(withScheme);
  return uri.replace(path: '').toString().replaceAll(RegExp(r'/$'), '');
}
