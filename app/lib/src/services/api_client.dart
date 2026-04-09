import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models.dart';

class ApiClient {
  ApiClient(this.auth);

  final AuthSession auth;

  static Future<String> pair({
    required String baseUrl,
    required String code,
  }) async {
    final uri = Uri.parse(baseUrl).replace(path: '/pair');
    final response = await http.post(
      uri,
      headers: {'content-type': 'application/json'},
      body: jsonEncode({'code': code}),
    );
    final body = _decode(response);
    _throwIfFailed(response, body);
    return body['token'] as String;
  }

  Future<List<Workspace>> listWorkspaces() async {
    final response = await http.get(_uri('/workspaces'), headers: _headers());
    if (response.statusCode >= 400) {
      _throwIfFailed(response, _decode(response));
    }
    final body = _decodeList(response);
    return body.map(Workspace.fromJson).toList();
  }

  Future<Workspace> createWorkspace({
    String? name,
    required String rootPath,
    required String provider,
  }) async {
    final response = await http.post(
      _uri('/workspaces'),
      headers: _headers(),
      body: jsonEncode({
        if (name != null && name.trim().isNotEmpty) 'name': name.trim(),
        'rootPath': rootPath,
        'provider': provider,
      }),
    );
    final body = _decode(response);
    _throwIfFailed(response, body);
    final workspaceJson = body['workspace'] is Map
        ? Map<String, dynamic>.from(body['workspace'] as Map)
        : body;
    return Workspace.fromJson(workspaceJson);
  }

  Future<DirectoryListing> browseDirectories({String? path}) async {
    final response = await http.get(
      _uri(
        '/workspaces/browse',
        query: {
          if (path != null && path.trim().isNotEmpty) 'path': path.trim(),
        },
      ),
      headers: _headers(),
    );
    final body = _decode(response);
    _throwIfFailed(response, body);
    return DirectoryListing.fromJson(body);
  }

  Future<Workspace> repairWorkspace(String workspaceId) async {
    final response = await http.post(
      _uri('/workspaces/$workspaceId/repair'),
      headers: _headers(),
    );
    final body = _decode(response);
    _throwIfFailed(response, body);
    final workspaceJson = body['workspace'] is Map
        ? Map<String, dynamic>.from(body['workspace'] as Map)
        : body;
    return Workspace.fromJson({
      ...workspaceJson,
      if (body['repairedAt'] != null) 'repairedAt': body['repairedAt'],
    });
  }

  Future<List<RemoteSession>> listSessions(String workspaceId) async {
    final response = await http.get(
      _uri('/sessions', query: {'workspaceId': workspaceId}),
      headers: _headers(),
    );
    if (response.statusCode >= 400) {
      _throwIfFailed(response, _decode(response));
    }
    final body = _decodeList(response);
    return body.map(RemoteSession.fromJson).toList();
  }

  Future<RemoteSession> createSession({
    required String workspaceId,
    required String prompt,
  }) async {
    final response = await http.post(
      _uri('/sessions'),
      headers: _headers(),
      body: jsonEncode({'workspaceId': workspaceId, 'prompt': prompt}),
    );
    final body = _decode(response);
    _throwIfFailed(response, body);
    return RemoteSession.fromJson(body);
  }

  Future<void> sendPrompt({
    required String sessionId,
    required String prompt,
  }) async {
    final response = await http.post(
      _uri('/sessions/$sessionId/prompts'),
      headers: _headers(),
      body: jsonEncode({'prompt': prompt}),
    );
    final body = _decode(response);
    _throwIfFailed(response, body);
  }

  Future<void> cancelSession(String sessionId) async {
    final response = await http.post(
      _uri('/sessions/$sessionId/cancel'),
      headers: _headers(),
    );
    final body = _decode(response);
    _throwIfFailed(response, body);
  }

  Future<List<SessionEvent>> getEvents({
    required String sessionId,
    required int afterSeq,
  }) async {
    final response = await http.get(
      _uri('/sessions/$sessionId/events', query: {'afterSeq': '$afterSeq'}),
      headers: _headers(),
    );
    if (response.statusCode >= 400) {
      _throwIfFailed(response, _decode(response));
    }
    final body = _decodeList(response);
    return body.map(SessionEvent.fromJson).toList();
  }

  Future<List<RunRecord>> listRuns(String sessionId) async {
    final response = await http.get(
      _uri('/sessions/$sessionId/runs'),
      headers: _headers(),
    );
    if (response.statusCode >= 400) {
      _throwIfFailed(response, _decode(response));
    }
    final body = _decodeList(response);
    return body.map(RunRecord.fromJson).toList();
  }

  Future<SessionExport> exportSession(String sessionId) async {
    final response = await http.get(
      _uri('/sessions/$sessionId/export'),
      headers: _headers(),
    );
    final body = _decode(response);
    _throwIfFailed(response, body);
    return SessionExport.fromJson(body);
  }

  Map<String, String> _headers() {
    return {
      'content-type': 'application/json',
      'authorization': 'Bearer ${auth.token}',
    };
  }

  Uri _uri(String path, {Map<String, String>? query}) {
    final base = Uri.parse(auth.baseUrl);
    return base.replace(path: path, queryParameters: query);
  }

  static Map<String, dynamic> _decode(http.Response response) {
    final text = response.body.trim();
    if (text.isEmpty) {
      return <String, dynamic>{};
    }

    return Map<String, dynamic>.from(jsonDecode(text) as Map);
  }

  static List<Map<String, dynamic>> _decodeList(http.Response response) {
    final text = response.body.trim();
    if (text.isEmpty) {
      return const [];
    }

    final decoded = jsonDecode(text) as List<dynamic>;
    return decoded
        .map((item) => Map<String, dynamic>.from(item as Map))
        .toList();
  }

  static void _throwIfFailed(
    http.Response response,
    Map<String, dynamic> body,
  ) {
    if (response.statusCode >= 400) {
      throw ApiException(
        body['error'] as String? ??
            'Request failed with ${response.statusCode}',
      );
    }
  }
}

class ApiException implements Exception {
  const ApiException(this.message);

  final String message;

  @override
  String toString() => message;
}
