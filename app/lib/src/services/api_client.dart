import 'dart:convert';

import 'package:http/http.dart' as http;

import '../base_url.dart';
import '../models.dart';

class ApiClient {
  ApiClient(this.auth, {http.Client? client}) : _client = client;

  final AuthSession auth;
  final http.Client? _client;

  static Future<String> pair({
    required String baseUrl,
    required String password,
    http.Client? client,
  }) async {
    final uri = resolveBaseUrlPath(baseUrl, '/pair');
    final response = client != null
        ? await client.post(
            uri,
            headers: {'content-type': 'application/json'},
            body: jsonEncode({'password': password}),
          )
        : await http.post(
            uri,
            headers: {'content-type': 'application/json'},
            body: jsonEncode({'password': password}),
          );
    final body = _decode(response);
    _throwIfFailed(response, body);
    return body['token'] as String;
  }

  Future<List<Workspace>> listWorkspaces() async {
    final response = await _get('/workspaces');
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
    final response = await _post(
      '/workspaces',
      headers: _headers(includeJsonContentType: true),
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
    final response = await _get(
      '/workspaces/browse',
      query: {if (path != null && path.trim().isNotEmpty) 'path': path.trim()},
    );
    final body = _decode(response);
    _throwIfFailed(response, body);
    return DirectoryListing.fromJson(body);
  }

  Future<Workspace> repairWorkspace(String workspaceId) async {
    final response = await _post('/workspaces/$workspaceId/repair');
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
    final response = await _get(
      '/sessions',
      query: {'workspaceId': workspaceId},
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
    String? model,
  }) async {
    final response = await _post(
      '/sessions',
      headers: _headers(includeJsonContentType: true),
      body: jsonEncode({
        'workspaceId': workspaceId,
        'prompt': prompt,
        if (model != null && model.trim().isNotEmpty) 'model': model.trim(),
      }),
    );
    final body = _decode(response);
    _throwIfFailed(response, body);
    return RemoteSession.fromJson(body);
  }

  Future<void> sendPrompt({
    required String sessionId,
    required String prompt,
    String? model,
  }) async {
    final response = await _post(
      '/sessions/$sessionId/prompts',
      headers: _headers(includeJsonContentType: true),
      body: jsonEncode({
        'prompt': prompt,
        if (model != null && model.trim().isNotEmpty) 'model': model.trim(),
      }),
    );
    final body = _decode(response);
    _throwIfFailed(response, body);
  }

  Future<void> cancelSession(String sessionId) async {
    final response = await _post('/sessions/$sessionId/cancel');
    final body = _decode(response);
    _throwIfFailed(response, body);
  }

  Future<void> deleteSession(String sessionId) async {
    final response = await _delete('/sessions/$sessionId');
    final body = _decode(response);
    _throwIfFailed(response, body);
  }

  Future<List<SessionEvent>> getEvents({
    required String sessionId,
    int afterSeq = 0,
    int? beforeSeq,
    int? limit,
  }) async {
    final response = await _get(
      '/sessions/$sessionId/events',
      query: {
        'afterSeq': '$afterSeq',
        if (beforeSeq != null) 'beforeSeq': '$beforeSeq',
        if (limit != null) 'limit': '$limit',
        'payload': 'summary',
      },
    );
    if (response.statusCode >= 400) {
      _throwIfFailed(response, _decode(response));
    }
    final body = _decodeList(response);
    return body.map(SessionEvent.fromJson).toList();
  }

  Future<List<RunRecord>> listRuns(String sessionId) async {
    final response = await _get('/sessions/$sessionId/runs');
    if (response.statusCode >= 400) {
      _throwIfFailed(response, _decode(response));
    }
    final body = _decodeList(response);
    return body.map(RunRecord.fromJson).toList();
  }

  Future<SessionExport> exportSession(String sessionId) async {
    final response = await _get('/sessions/$sessionId/export');
    final body = _decode(response);
    _throwIfFailed(response, body);
    return SessionExport.fromJson(body);
  }

  Map<String, String> _headers({bool includeJsonContentType = false}) {
    return {
      'authorization': 'Bearer ${auth.token}',
      if (includeJsonContentType) 'content-type': 'application/json',
    };
  }

  Future<http.Response> _get(String path, {Map<String, String>? query}) {
    final uri = _uri(path, query: query);
    final headers = _headers();
    final client = _client;
    if (client != null) {
      return client.get(uri, headers: headers);
    }
    return http.get(uri, headers: headers);
  }

  Future<http.Response> _post(
    String path, {
    Map<String, String>? query,
    Map<String, String>? headers,
    Object? body,
  }) {
    final uri = _uri(path, query: query);
    final requestHeaders = headers ?? _headers();
    final client = _client;
    if (client != null) {
      return client.post(uri, headers: requestHeaders, body: body);
    }
    return http.post(uri, headers: requestHeaders, body: body);
  }

  Future<http.Response> _delete(
    String path, {
    Map<String, String>? query,
    Map<String, String>? headers,
    Object? body,
  }) {
    final uri = _uri(path, query: query);
    final requestHeaders = headers ?? _headers();
    final client = _client;
    if (client != null) {
      return client.delete(uri, headers: requestHeaders, body: body);
    }
    return http.delete(uri, headers: requestHeaders, body: body);
  }

  Uri _uri(String path, {Map<String, String>? query}) {
    return resolvePath(path, query: query);
  }

  Uri resolvePath(String path, {Map<String, String>? query}) {
    return resolveBaseUrlPath(auth.baseUrl, path, queryParameters: query);
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
      final error = body['error'] as String?;
      final message = body['message'] as String?;
      throw ApiException(
        error == 'Internal Server Error' && message != null
            ? message
            : error ?? message ?? 'Request failed with ${response.statusCode}',
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
