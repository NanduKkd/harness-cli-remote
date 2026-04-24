import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'package:gemini_remote_app/src/base_url.dart';
import 'package:gemini_remote_app/src/models.dart';
import 'package:gemini_remote_app/src/services/api_client.dart';

class RecordingHttpClient extends http.BaseClient {
  RecordingHttpClient(this._handler);

  final Future<http.StreamedResponse> Function(http.BaseRequest request)
  _handler;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    return _handler(request);
  }
}

http.StreamedResponse jsonResponse(
  Map<String, dynamic> body, {
  int statusCode = 200,
  http.BaseRequest? request,
}) {
  return http.StreamedResponse(
    Stream<List<int>>.value(utf8.encode(jsonEncode(body))),
    statusCode,
    headers: const {'content-type': 'application/json'},
    request: request,
  );
}

http.StreamedResponse jsonListResponse(
  List<Map<String, dynamic>> body, {
  int statusCode = 200,
  http.BaseRequest? request,
}) {
  return http.StreamedResponse(
    Stream<List<int>>.value(utf8.encode(jsonEncode(body))),
    statusCode,
    headers: const {'content-type': 'application/json'},
    request: request,
  );
}

void main() {
  const auth = AuthSession(
    baseUrl: 'http://127.0.0.1:8918',
    token: 'test-token',
  );
  const prefixedAuth = AuthSession(
    baseUrl: 'http://127.0.0.1:8918/ieb8izzxc0bt',
    token: 'test-token',
  );

  test('normalizeBaseUrl preserves path prefixes', () {
    expect(
      normalizeBaseUrl(
        'http://127.0.0.1:8918/ieb8izzxc0bt/?from=tunnel#fragment',
      ),
      'http://127.0.0.1:8918/ieb8izzxc0bt',
    );
  });

  test('websocketUri preserves path prefixes', () {
    expect(
      prefixedAuth.websocketUri.toString(),
      'ws://127.0.0.1:8918/ieb8izzxc0bt/ws?token=test-token',
    );
  });

  test('pair sends the configured password in the request body', () async {
    late http.Request request;
    final client = RecordingHttpClient((incoming) async {
      request = incoming as http.Request;
      return jsonResponse({'token': 'paired-token'}, request: incoming);
    });

    final token = await ApiClient.pair(
      baseUrl: auth.baseUrl,
      password: 'my-secret-password',
      client: client,
    );

    expect(token, 'paired-token');
    expect(request.method, 'POST');
    expect(request.url.path, '/pair');
    expect(request.headers['content-type'], 'application/json');
    expect(jsonDecode(request.body), {'password': 'my-secret-password'});
  });

  test(
    'cancelSession omits JSON content-type when there is no request body',
    () async {
      late http.BaseRequest request;
      final client = RecordingHttpClient((incoming) async {
        request = incoming;
        return jsonResponse({'ok': true}, request: incoming);
      });
      final api = ApiClient(auth, client: client);

      await api.cancelSession('session-123');

      expect(request.method, 'POST');
      expect(request.url.path, '/sessions/session-123/cancel');
      expect(request.headers['authorization'], 'Bearer test-token');
      expect(request.headers.containsKey('content-type'), isFalse);
    },
  );

  test(
    'deleteSession omits JSON content-type when there is no request body',
    () async {
      late http.BaseRequest request;
      final client = RecordingHttpClient((incoming) async {
        request = incoming;
        return jsonResponse({'ok': true}, request: incoming);
      });
      final api = ApiClient(auth, client: client);

      await api.deleteSession('session-123');

      expect(request.method, 'DELETE');
      expect(request.url.path, '/sessions/session-123');
      expect(request.headers['authorization'], 'Bearer test-token');
      expect(request.headers.containsKey('content-type'), isFalse);
    },
  );

  test(
    'repairWorkspace omits JSON content-type when there is no request body',
    () async {
      late http.BaseRequest request;
      final client = RecordingHttpClient((incoming) async {
        request = incoming;
        return jsonResponse({
          'workspace': {
            'id': 'workspace-1',
            'name': 'Workspace',
            'rootPath': '/tmp/workspace',
            'provider': 'gemini',
            'hookStatus': 'installed',
          },
          'repairedAt': '2026-04-14T12:00:00.000Z',
        }, request: incoming);
      });
      final api = ApiClient(auth, client: client);

      final workspace = await api.repairWorkspace('workspace-1');

      expect(workspace.id, 'workspace-1');
      expect(request.method, 'POST');
      expect(request.url.path, '/workspaces/workspace-1/repair');
      expect(request.headers['authorization'], 'Bearer test-token');
      expect(request.headers.containsKey('content-type'), isFalse);
    },
  );

  test(
    'createSession still sends JSON content-type and encoded body',
    () async {
      late http.Request request;
      final client = RecordingHttpClient((incoming) async {
        request = incoming as http.Request;
        return jsonResponse({
          'id': 'session-123',
          'workspaceId': 'workspace-1',
          'model': 'gemini-2.5-pro',
          'providerSessionId': null,
          'geminiSessionId': null,
          'transcriptPath': null,
          'status': 'running',
          'lastMessageStatus': 'running',
          'createdAt': '2026-04-14T12:00:00.000Z',
          'updatedAt': '2026-04-14T12:00:00.000Z',
          'lastActivityAt': '2026-04-14T12:00:00.000Z',
          'lastRunId': 'run-1',
          'lastPrompt': 'Hello',
        }, request: incoming);
      });
      final api = ApiClient(auth, client: client);

      final session = await api.createSession(
        workspaceId: 'workspace-1',
        prompt: 'Hello',
        model: 'gemini-2.5-pro',
      );

      expect(session.id, 'session-123');
      expect(session.lastPrompt, 'Hello');
      expect(request.method, 'POST');
      expect(request.url.path, '/sessions');
      expect(request.headers['authorization'], 'Bearer test-token');
      expect(request.headers['content-type'], 'application/json');
      expect(jsonDecode(request.body), {
        'workspaceId': 'workspace-1',
        'prompt': 'Hello',
        'model': 'gemini-2.5-pro',
      });
    },
  );

  test('resolvePath appends API routes to the stored path prefix', () {
    final api = ApiClient(prefixedAuth);

    expect(
      api.resolvePath('/sessions/session-123/events').toString(),
      'http://127.0.0.1:8918/ieb8izzxc0bt/sessions/session-123/events',
    );
    expect(
      api.resolvePath('/artifacts/artifact-1/download').toString(),
      'http://127.0.0.1:8918/ieb8izzxc0bt/artifacts/artifact-1/download',
    );
  });

  test('getEvents requests summary payloads', () async {
    late http.BaseRequest request;
    final client = RecordingHttpClient((incoming) async {
      request = incoming;
      return jsonListResponse([
        {
          'sessionId': 'session-123',
          'runId': 'run-1',
          'seq': 1,
          'type': 'tool.completed',
          'ts': '2026-04-14T12:00:00.000Z',
          'payload': {
            'toolName': 'Read',
            'success': true,
            'toolResponseSummary': 'summary',
          },
        },
      ], request: incoming);
    });
    final api = ApiClient(auth, client: client);

    final events = await api.getEvents(sessionId: 'session-123', afterSeq: 42);

    expect(events.single.payload['toolResponseSummary'], 'summary');
    expect(request.url.path, '/sessions/session-123/events');
    expect(request.url.queryParameters, {
      'afterSeq': '42',
      'payload': 'summary',
    });
  });

  test(
    'sendPrompt surfaces the backend message for generic 500 responses',
    () async {
      final client = RecordingHttpClient((incoming) async {
        return jsonResponse(
          {
            'statusCode': 500,
            'error': 'Internal Server Error',
            'message':
                'This session cannot be resumed because Gemini did not persist a session id.',
          },
          statusCode: 500,
          request: incoming,
        );
      });
      final api = ApiClient(auth, client: client);

      expect(
        () => api.sendPrompt(sessionId: 'session-123', prompt: 'follow up'),
        throwsA(
          isA<ApiException>().having(
            (error) => error.message,
            'message',
            'This session cannot be resumed because Gemini did not persist a session id.',
          ),
        ),
      );
    },
  );
}
