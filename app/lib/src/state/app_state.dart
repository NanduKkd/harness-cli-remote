import 'dart:async';

import 'package:http/http.dart' as http;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../base_url.dart';
import '../models.dart';
import '../services/api_client.dart';
import '../services/artifact_download_bridge.dart';
import '../services/auth_storage.dart';
import '../services/realtime_service.dart';
import '../services/session_monitor_bridge.dart';

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

final artifactDownloadBridgeProvider = Provider<ArtifactDownloadBridge>(
  (ref) => const ArtifactDownloadBridge(),
);

final recentHostsProvider = FutureProvider<List<String>>((ref) async {
  return ref.read(authStorageProvider).readRecentHosts();
});

final httpClientProvider = Provider<http.Client>((ref) {
  final client = http.Client();
  ref.onDispose(client.close);
  return client;
});

final realtimeServiceProvider = Provider<RealtimeService>((ref) {
  final service = RealtimeService();
  ref.onDispose(service.dispose);
  return service;
});

final sessionMonitorBridgeProvider = Provider<SessionMonitorBridge>((ref) {
  return const SessionMonitorBridge();
});

final workspacesProvider = FutureProvider<List<Workspace>>((ref) async {
  final api = ref.watch(apiClientProvider);
  if (api == null) {
    return const [];
  }

  return api.listWorkspaces();
});

final sessionsProvider = FutureProvider.family<List<RemoteSession>, String>((
  ref,
  workspaceId,
) async {
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

  Future<void> pair({required String baseUrl, required String code}) async {
    final normalizedUrl = normalizeBaseUrl(baseUrl);
    final token = await ApiClient.pair(baseUrl: normalizedUrl, code: code);
    final auth = AuthSession(baseUrl: normalizedUrl, token: token);
    await _storage.write(auth);
    state = AsyncValue.data(auth);
  }

  Future<void> signOut() async {
    await _storage.clear();
    state = const AsyncValue.data(null);
  }
}
