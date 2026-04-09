import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models.dart';
import '../state/app_state.dart';
import '../widgets/chrome.dart';
import '../widgets/json_export_sheet.dart';

class SessionDetailScreen extends ConsumerStatefulWidget {
  const SessionDetailScreen({
    super.key,
    required this.workspace,
    required this.session,
  });

  final Workspace workspace;
  final RemoteSession session;

  @override
  ConsumerState<SessionDetailScreen> createState() =>
      _SessionDetailScreenState();
}

class _SessionDetailScreenState extends ConsumerState<SessionDetailScreen> {
  final List<SessionEvent> _events = [];
  late final TextEditingController _promptController;
  StreamSubscription<RealtimeEnvelope>? _messageSubscription;
  StreamSubscription<ConnectionStatus>? _statusSubscription;
  bool _loading = true;
  bool _sending = false;
  bool _exporting = false;
  String? _error;
  int _lastSeq = 0;
  ConnectionStatus _connectionStatus = ConnectionStatus.disconnected;

  @override
  void initState() {
    super.initState();
    _promptController = TextEditingController();
    final realtime = ref.read(realtimeServiceProvider);
    _connectionStatus = realtime.status;
    _messageSubscription = realtime.messages.listen(_handleRealtimeEvent);
    _statusSubscription = realtime.statuses.listen((status) async {
      final shouldCatchUp =
          _connectionStatus != ConnectionStatus.connected &&
          status == ConnectionStatus.connected;
      if (mounted) {
        setState(() {
          _connectionStatus = status;
        });
      }
      if (shouldCatchUp) {
        await _fetchEvents(afterSeq: _lastSeq);
      }
    });
    unawaited(_fetchEvents(afterSeq: 0));
  }

  @override
  void dispose() {
    _messageSubscription?.cancel();
    _statusSubscription?.cancel();
    _promptController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final liveText = _liveText();
    final entries = _conversationEntries(liveText);
    final isRunning = _isRunning();
    final messageStatus = _currentMessageStatus();
    final messageStatusTone = statusColor(messageStatus);
    final lastActivityAt = _latestActivityAt();

    return AtmosphereScaffold(
      title: 'Session',
      showAppBar: false,
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(10, 10, 10, 0),
            child: SectionCard(
              padding: const EdgeInsets.fromLTRB(6, 6, 8, 6),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  IconButton(
                    onPressed: () => Navigator.of(context).maybePop(),
                    tooltip: 'Back',
                    icon: const Icon(Icons.arrow_back_rounded),
                  ),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          widget.workspace.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.titleMedium
                              ?.copyWith(fontWeight: FontWeight.w700),
                        ),
                        const SizedBox(height: 3),
                        Wrap(
                          spacing: 10,
                          runSpacing: 2,
                          children: [
                            Text(
                              messageStatusLabel(messageStatus),
                              style: Theme.of(context).textTheme.bodySmall
                                  ?.copyWith(
                                    color: messageStatusTone,
                                    fontWeight: FontWeight.w700,
                                  ),
                            ),
                            Text(
                              _formatTime(lastActivityAt),
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 6),
                  PopupMenuButton<_SessionDetailAction>(
                    tooltip: 'Conversation actions',
                    icon: _exporting
                        ? const SizedBox(
                            height: 18,
                            width: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.more_vert_rounded),
                    onSelected: (action) {
                      if (_exporting) {
                        return;
                      }
                      if (action == _SessionDetailAction.downloadCurrent) {
                        _showExport();
                      } else if (action == _SessionDetailAction.refresh) {
                        _refreshConversation();
                      }
                    },
                    itemBuilder: (context) => [
                      const PopupMenuItem<_SessionDetailAction>(
                        value: _SessionDetailAction.downloadCurrent,
                        child: Text('Download Screen (current)'),
                      ),
                      const PopupMenuItem<_SessionDetailAction>(
                        value: _SessionDetailAction.refresh,
                        child: Text('Refresh'),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
          Expanded(child: _buildConversation(context, entries)),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(10, 6, 10, 10),
              child: SectionCard(
                padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _promptController,
                        minLines: 1,
                        maxLines: 4,
                        textInputAction: TextInputAction.send,
                        onSubmitted: (_) {
                          if (!_sending && !isRunning) {
                            _sendPrompt();
                          }
                        },
                        decoration: const InputDecoration(
                          hintText: 'Send a follow-up prompt',
                          isDense: true,
                          contentPadding: EdgeInsets.symmetric(
                            horizontal: 12,
                            vertical: 10,
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    FilledButton(
                      onPressed: _sending || isRunning ? null : _sendPrompt,
                      style: FilledButton.styleFrom(
                        minimumSize: const Size(0, 42),
                        padding: const EdgeInsets.symmetric(
                          horizontal: 14,
                          vertical: 10,
                        ),
                      ),
                      child: _sending
                          ? const SizedBox(
                              height: 18,
                              width: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.send_rounded),
                    ),
                    if (isRunning) ...[
                      const SizedBox(width: 6),
                      OutlinedButton(
                        onPressed: _cancelSession,
                        style: OutlinedButton.styleFrom(
                          minimumSize: const Size(0, 42),
                          padding: const EdgeInsets.symmetric(
                            horizontal: 12,
                            vertical: 10,
                          ),
                        ),
                        child: const Icon(Icons.stop_circle_outlined),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildConversation(
    BuildContext context,
    List<_TranscriptEntry> entries,
  ) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_error != null) {
      return ListView(
        padding: const EdgeInsets.all(10),
        children: [
          EmptyStateCard(title: 'Could not load conversation', body: _error!),
        ],
      );
    }

    if (entries.isEmpty) {
      return ListView(
        padding: const EdgeInsets.all(10),
        children: const [
          EmptyStateCard(
            title: 'Nothing yet',
            body:
                'Your prompts, replies, tool activity, and session notices will appear here as a readable conversation.',
          ),
        ],
      );
    }

    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 10),
      itemCount: entries.length,
      separatorBuilder: (_, _) => const SizedBox(height: 6),
      itemBuilder: (context, index) {
        final entry = entries[index];
        return switch (entry.kind) {
          _TranscriptEntryKind.user => _MessageBubble(
            entry: entry,
            alignment: Alignment.centerRight,
            backgroundColor: const Color(0xFFE36A39),
            foregroundColor: Colors.white,
            renderMarkdown: false,
          ),
          _TranscriptEntryKind.assistant => _MessageBubble(
            entry: entry,
            alignment: Alignment.centerLeft,
            backgroundColor: Colors.white,
            foregroundColor: const Color(0xFF2E2B27),
            renderMarkdown: !entry.isLive,
          ),
          _TranscriptEntryKind.tool => _ToolCallCard(
            key: ValueKey(
              '${entry.title}-${entry.ts.toIso8601String()}-${entry.state}',
            ),
            entry: entry,
          ),
          _TranscriptEntryKind.system => _SystemEventCard(entry: entry),
        };
      },
    );
  }

  List<_TranscriptEntry> _conversationEntries(String liveText) {
    final entries = <_TranscriptEntry>[];
    final openToolIndexes = <String, List<int>>{};

    for (final event in _events.where(
      (event) => event.type != 'message.delta',
    )) {
      switch (event.type) {
        case 'run.started':
          final prompt = _textOrNull(event.payload['prompt']);
          if (prompt != null) {
            entries.add(_TranscriptEntry.user(text: prompt, ts: event.ts));
          }
        case 'message.completed':
          final text = _textOrNull(event.payload['text']);
          if (text != null) {
            _appendEntry(
              entries,
              _TranscriptEntry.assistant(
                title: providerDisplayName(widget.workspace.provider),
                text: text,
                ts: event.ts,
              ),
            );
          }
        case 'tool.started':
          final toolName = _textOrNull(event.payload['toolName']) ?? 'tool';
          final entry = _TranscriptEntry.tool(
            toolName: toolName,
            ts: event.ts,
            state: _ToolState.running,
            requestSummary: _prettySummary(
              event.payload['toolInput'] ?? event.payload['toolInputSummary'],
            ),
            responseSummary: null,
          );
          entries.add(entry);
          openToolIndexes
              .putIfAbsent(_toolKey(event.runId, toolName), () => <int>[])
              .add(entries.length - 1);
        case 'tool.completed':
          final toolName = _textOrNull(event.payload['toolName']) ?? 'tool';
          final state = (event.payload['success'] as bool? ?? true)
              ? _ToolState.completed
              : _ToolState.failed;
          final updatedEntry = _TranscriptEntry.tool(
            toolName: toolName,
            ts: event.ts,
            state: state,
            requestSummary: _prettySummary(
              event.payload['toolInput'] ?? event.payload['toolInputSummary'],
            ),
            responseSummary: _prettyToolResponse(event.payload),
          );
          final stack = openToolIndexes[_toolKey(event.runId, toolName)];
          if (stack != null && stack.isNotEmpty) {
            final index = stack.removeLast();
            entries[index] = entries[index].copyWithTool(
              ts: event.ts,
              state: state,
              responseSummary: updatedEntry.responseSummary,
            );
          } else {
            entries.add(updatedEntry);
          }
        case 'run.cancelled':
          entries.add(
            _TranscriptEntry.system(
              title: 'Run cancelled',
              body: 'This turn was stopped from the mobile app.',
              ts: event.ts,
              tone: _SystemTone.warning,
            ),
          );
        case 'run.failed':
          entries.add(
            _TranscriptEntry.system(
              title: 'Run failed',
              body:
                  _prettySummary(event.payload['stderrTail']) ??
                  '${providerDisplayName(widget.workspace.provider)} did not finish this turn successfully.',
              ts: event.ts,
              tone: _SystemTone.error,
            ),
          );
        case 'notification':
          final notificationText = [
            _textOrNull(event.payload['message']),
            _prettySummary(event.payload['details']),
          ].whereType<String>().join('\n');
          if (notificationText.isNotEmpty) {
            entries.add(
              _TranscriptEntry.system(
                title: 'Notification',
                body: notificationText,
                ts: event.ts,
                tone: _SystemTone.info,
              ),
            );
          }
        default:
          break;
      }
    }

    if (liveText.isNotEmpty) {
      _appendEntry(
        entries,
        _TranscriptEntry.assistant(
          title: providerDisplayName(widget.workspace.provider),
          text: liveText,
          ts: _liveTimestamp(),
          isLive: true,
        ),
      );
    } else if (_isRunning()) {
      _appendEntry(
        entries,
        _TranscriptEntry.system(
          title: '${providerDisplayName(widget.workspace.provider)} is working',
          body: 'Waiting for the next streamed chunk from the active run.',
          ts: _liveTimestamp(),
          tone: _SystemTone.info,
        ),
      );
    }

    return entries;
  }

  String _currentMessageStatus() {
    for (final event in _events.reversed) {
      switch (event.type) {
        case 'message.delta':
        case 'run.started':
          return 'running';
        case 'run.completed':
        case 'message.completed':
          return 'completed';
        case 'run.failed':
          return 'failed';
        case 'run.cancelled':
          return 'cancelled';
        default:
          break;
      }
    }
    return widget.session.lastMessageStatus;
  }

  DateTime _latestActivityAt() {
    if (_events.isNotEmpty) {
      return _events.last.ts;
    }
    return widget.session.lastActivityAt;
  }

  Future<void> _showExport() async {
    final api = ref.read(apiClientProvider);
    if (api == null) {
      return;
    }

    setState(() {
      _exporting = true;
    });

    try {
      final export = await api.exportSession(widget.session.id);
      final jsonText = const JsonEncoder.withIndent(
        '  ',
      ).convert(export.toJson());
      if (!mounted) {
        return;
      }
      await showJsonExportSheet(
        context: context,
        title: 'Session export',
        jsonText: jsonText,
      );
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(error.toString())));
      }
    } finally {
      if (mounted) {
        setState(() {
          _exporting = false;
        });
      }
    }
  }

  Future<void> _refreshConversation() async {
    await _fetchEvents(afterSeq: _lastSeq);
  }

  Future<void> _fetchEvents({required int afterSeq}) async {
    final api = ref.read(apiClientProvider);
    if (api == null) {
      return;
    }

    try {
      final events = await api.getEvents(
        sessionId: widget.session.id,
        afterSeq: afterSeq,
      );
      if (!mounted) {
        return;
      }
      setState(() {
        _loading = false;
        _error = null;
        _mergeEvents(events);
      });
      if (events.any((event) => _eventAffectsSessionSummary(event.type))) {
        ref.invalidate(sessionsProvider(widget.workspace.id));
      }
    } catch (error) {
      if (!mounted) {
        return;
      }
      setState(() {
        _loading = false;
        _error = error.toString();
      });
    }
  }

  void _handleRealtimeEvent(RealtimeEnvelope envelope) {
    if (envelope.sessionId != widget.session.id || !mounted) {
      return;
    }

    setState(() {
      _mergeEvents([envelope.event]);
    });
    if (_eventAffectsSessionSummary(envelope.event.type)) {
      ref.invalidate(sessionsProvider(widget.workspace.id));
    }
  }

  void _mergeEvents(List<SessionEvent> incoming) {
    for (final event in incoming) {
      if (_events.any((existing) => existing.seq == event.seq)) {
        continue;
      }
      _events.add(event);
    }
    _events.sort((left, right) => left.seq.compareTo(right.seq));
    if (_events.isNotEmpty) {
      _lastSeq = _events.last.seq;
    }
  }

  bool _isRunning() {
    final runState = <String, bool>{};
    for (final event in _events) {
      final runId = event.runId;
      if (runId == null) {
        continue;
      }

      switch (event.type) {
        case 'run.started':
          runState[runId] = true;
        case 'run.completed':
        case 'run.cancelled':
        case 'run.failed':
          runState[runId] = false;
        default:
          break;
      }
    }
    return runState.values.any((value) => value);
  }

  String _liveText() {
    String? latestRunId;
    for (final event in _events) {
      if (event.type == 'run.started' && event.runId != null) {
        latestRunId = event.runId;
      }
    }
    if (latestRunId == null) {
      return '';
    }

    var fullText = '';
    var completed = false;
    for (final event in _events.where((item) => item.runId == latestRunId)) {
      switch (event.type) {
        case 'message.delta':
          fullText =
              event.payload['fullText'] as String? ??
              '$fullText${event.payload['text'] ?? ''}';
        case 'message.completed':
          fullText = event.payload['text'] as String? ?? fullText;
          completed = true;
        case 'run.cancelled':
        case 'run.failed':
        case 'run.completed':
          completed = true;
        default:
          break;
      }
    }

    return completed ? '' : fullText.trimRight();
  }

  DateTime _liveTimestamp() {
    for (final event in _events.reversed) {
      if (event.type == 'message.delta' || event.type == 'run.started') {
        return event.ts;
      }
    }
    return DateTime.now();
  }

  Future<void> _sendPrompt() async {
    final prompt = _promptController.text.trim();
    if (prompt.isEmpty) {
      return;
    }

    final api = ref.read(apiClientProvider);
    if (api == null) {
      return;
    }

    setState(() {
      _sending = true;
    });

    try {
      await api.sendPrompt(sessionId: widget.session.id, prompt: prompt);
      _promptController.clear();
      await _fetchEvents(afterSeq: _lastSeq);
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(error.toString())));
      }
    } finally {
      if (mounted) {
        setState(() {
          _sending = false;
        });
      }
    }
  }

  Future<void> _cancelSession() async {
    final api = ref.read(apiClientProvider);
    if (api == null) {
      return;
    }

    try {
      await api.cancelSession(widget.session.id);
      await _fetchEvents(afterSeq: _lastSeq);
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(error.toString())));
      }
    }
  }
}

enum _SessionDetailAction { downloadCurrent, refresh }

enum _TranscriptEntryKind { user, assistant, tool, system }

enum _ToolState { running, completed, failed }

enum _SystemTone { info, warning, error }

class _TranscriptEntry {
  const _TranscriptEntry._({
    required this.kind,
    required this.title,
    required this.ts,
    this.text,
    this.isLive = false,
    this.state,
    this.requestSummary,
    this.responseSummary,
    this.tone,
  });

  factory _TranscriptEntry.user({required String text, required DateTime ts}) {
    return _TranscriptEntry._(
      kind: _TranscriptEntryKind.user,
      title: 'You',
      text: text,
      ts: ts,
    );
  }

  factory _TranscriptEntry.assistant({
    required String title,
    required String text,
    required DateTime ts,
    bool isLive = false,
  }) {
    return _TranscriptEntry._(
      kind: _TranscriptEntryKind.assistant,
      title: title,
      text: text,
      ts: ts,
      isLive: isLive,
    );
  }

  factory _TranscriptEntry.tool({
    required String toolName,
    required DateTime ts,
    required _ToolState state,
    required String? requestSummary,
    required String? responseSummary,
  }) {
    return _TranscriptEntry._(
      kind: _TranscriptEntryKind.tool,
      title: toolName,
      ts: ts,
      state: state,
      requestSummary: requestSummary,
      responseSummary: responseSummary,
    );
  }

  factory _TranscriptEntry.system({
    required String title,
    required String body,
    required DateTime ts,
    required _SystemTone tone,
  }) {
    return _TranscriptEntry._(
      kind: _TranscriptEntryKind.system,
      title: title,
      text: body,
      ts: ts,
      tone: tone,
    );
  }

  final _TranscriptEntryKind kind;
  final String title;
  final DateTime ts;
  final String? text;
  final bool isLive;
  final _ToolState? state;
  final String? requestSummary;
  final String? responseSummary;
  final _SystemTone? tone;

  _TranscriptEntry copyWithTool({
    required DateTime ts,
    required _ToolState state,
    required String? responseSummary,
  }) {
    return _TranscriptEntry._(
      kind: kind,
      title: title,
      ts: ts,
      state: state,
      requestSummary: requestSummary,
      responseSummary: responseSummary,
    );
  }
}

void _appendEntry(List<_TranscriptEntry> entries, _TranscriptEntry next) {
  if (entries.isNotEmpty && _isDuplicateConversationEntry(entries.last, next)) {
    return;
  }
  entries.add(next);
}

bool _isDuplicateConversationEntry(
  _TranscriptEntry previous,
  _TranscriptEntry next,
) {
  if (previous.kind != next.kind) {
    return false;
  }

  if (previous.kind == _TranscriptEntryKind.assistant ||
      previous.kind == _TranscriptEntryKind.user) {
    return _normalizedMessageText(previous.text) ==
        _normalizedMessageText(next.text);
  }

  if (previous.kind == _TranscriptEntryKind.system) {
    return previous.title == next.title &&
        _normalizedMessageText(previous.text) ==
            _normalizedMessageText(next.text);
  }

  return false;
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({
    required this.entry,
    required this.alignment,
    required this.backgroundColor,
    required this.foregroundColor,
    required this.renderMarkdown,
  });

  final _TranscriptEntry entry;
  final Alignment alignment;
  final Color backgroundColor;
  final Color foregroundColor;
  final bool renderMarkdown;

  @override
  Widget build(BuildContext context) {
    final maxWidth = MediaQuery.sizeOf(context).width * 0.86;
    final textStyle = TextStyle(
      color: foregroundColor,
      height: 1.36,
      fontSize: 13,
    );
    return Align(
      alignment: alignment,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: maxWidth),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: backgroundColor,
            borderRadius: BorderRadius.circular(18),
            boxShadow: entry.kind == _TranscriptEntryKind.assistant
                ? const [
                    BoxShadow(
                      color: Color(0x12000000),
                      blurRadius: 14,
                      offset: Offset(0, 4),
                    ),
                  ]
                : null,
          ),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(11, 10, 11, 10),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              spacing: 7,
              children: [
                Row(
                  children: [
                    Text(
                      entry.title,
                      style: TextStyle(
                        color: foregroundColor.withValues(alpha: 0.78),
                        fontSize: 11,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 0.3,
                      ),
                    ),
                    const SizedBox(width: 6),
                    Text(
                      _formatTime(entry.ts),
                      style: TextStyle(
                        color: foregroundColor.withValues(alpha: 0.62),
                        fontSize: 11,
                      ),
                    ),
                    if (entry.isLive) ...[
                      const Spacer(),
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 8,
                          vertical: 3,
                        ),
                        decoration: BoxDecoration(
                          color: foregroundColor.withValues(alpha: 0.14),
                          borderRadius: BorderRadius.circular(999),
                        ),
                        child: Text(
                          'Live',
                          style: TextStyle(
                            color: foregroundColor,
                            fontSize: 10,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                    ],
                  ],
                ),
                if (renderMarkdown)
                  MarkdownBody(
                    data: entry.text ?? '',
                    softLineBreak: true,
                    styleSheet: _markdownStyleSheet(
                      context,
                      textColor: foregroundColor,
                      codeBackground: foregroundColor.withValues(alpha: 0.08),
                    ),
                  )
                else
                  SelectableText(entry.text ?? '', style: textStyle),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ToolCallCard extends StatefulWidget {
  const _ToolCallCard({super.key, required this.entry});

  final _TranscriptEntry entry;

  @override
  State<_ToolCallCard> createState() => _ToolCallCardState();
}

class _ToolCallCardState extends State<_ToolCallCard> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final entry = widget.entry;
    final state = entry.state ?? _ToolState.running;
    final status = switch (state) {
      _ToolState.running => ('Running', const Color(0xFF9A5F16)),
      _ToolState.completed => ('Completed', const Color(0xFF29785A)),
      _ToolState.failed => ('Failed', const Color(0xFFB33D2E)),
    };
    final hasDetails =
        entry.requestSummary != null || entry.responseSummary != null;

    return Align(
      alignment: Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.sizeOf(context).width * 0.94,
        ),
        child: SectionCard(
          padding: const EdgeInsets.fromLTRB(10, 9, 10, 9),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            spacing: 6,
            children: [
              Row(
                children: [
                  Icon(_toolIcon(entry.title), size: 16, color: status.$2),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      entry.title,
                      style: Theme.of(context).textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    status.$1,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: status.$2,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(width: 8),
                  if (hasDetails)
                    TextButton(
                      onPressed: () {
                        setState(() {
                          _expanded = !_expanded;
                        });
                      },
                      style: TextButton.styleFrom(
                        visualDensity: VisualDensity.compact,
                        minimumSize: Size.zero,
                        padding: const EdgeInsets.symmetric(
                          horizontal: 6,
                          vertical: 4,
                        ),
                        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      ),
                      child: Text(_expanded ? 'Hide Details' : 'Show Details'),
                    ),
                ],
              ),
              Text(
                _formatTime(entry.ts),
                style: Theme.of(context).textTheme.bodySmall,
              ),
              if (_expanded && entry.requestSummary != null)
                _ToolDetailBlock(label: 'Input', body: entry.requestSummary!),
              if (_expanded && entry.responseSummary != null)
                _ToolDetailBlock(
                  label: state == _ToolState.failed ? 'Error' : 'Result',
                  body: entry.responseSummary!,
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ToolDetailBlock extends StatelessWidget {
  const _ToolDetailBlock({required this.label, required this.body});

  final String label;
  final String body;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(9),
      decoration: BoxDecoration(
        color: const Color(0xFFFBF7F1),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        spacing: 4,
        children: [
          Text(
            label,
            style: Theme.of(
              context,
            ).textTheme.labelLarge?.copyWith(fontWeight: FontWeight.w700),
          ),
          SelectableText(
            body,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(height: 1.3),
          ),
        ],
      ),
    );
  }
}

MarkdownStyleSheet _markdownStyleSheet(
  BuildContext context, {
  required Color textColor,
  required Color codeBackground,
}) {
  final baseTextStyle = Theme.of(context).textTheme.bodyMedium?.copyWith(
    color: textColor,
    height: 1.36,
    fontSize: 13,
  );
  final codeStyle = Theme.of(context).textTheme.bodySmall?.copyWith(
    color: textColor,
    fontFamily: 'monospace',
    height: 1.3,
  );

  return MarkdownStyleSheet.fromTheme(Theme.of(context)).copyWith(
    p: baseTextStyle,
    h1: baseTextStyle?.copyWith(fontWeight: FontWeight.w700, fontSize: 18),
    h2: baseTextStyle?.copyWith(fontWeight: FontWeight.w700, fontSize: 16),
    h3: baseTextStyle?.copyWith(fontWeight: FontWeight.w700, fontSize: 14),
    listBullet: baseTextStyle,
    blockquote: baseTextStyle,
    strong: baseTextStyle?.copyWith(fontWeight: FontWeight.w700),
    em: baseTextStyle?.copyWith(fontStyle: FontStyle.italic),
    code: codeStyle,
    codeblockDecoration: BoxDecoration(
      color: codeBackground,
      borderRadius: BorderRadius.circular(10),
    ),
    codeblockPadding: const EdgeInsets.all(10),
    a: baseTextStyle?.copyWith(
      color: textColor,
      decoration: TextDecoration.underline,
      fontWeight: FontWeight.w600,
    ),
  );
}

IconData _toolIcon(String toolName) {
  final normalized = toolName.toLowerCase();
  if (normalized.contains('web')) {
    return Icons.public_rounded;
  }
  if (normalized.contains('bash') || normalized.contains('command')) {
    return Icons.terminal_rounded;
  }
  if (normalized.contains('mcp')) {
    return Icons.hub_outlined;
  }
  return Icons.build_circle_outlined;
}

class _SystemEventCard extends StatelessWidget {
  const _SystemEventCard({required this.entry});

  final _TranscriptEntry entry;

  @override
  Widget build(BuildContext context) {
    final tone = switch (entry.tone ?? _SystemTone.info) {
      _SystemTone.info => const Color(0xFF2F5BA8),
      _SystemTone.warning => const Color(0xFF9A5F16),
      _SystemTone.error => const Color(0xFFB33D2E),
    };

    return Center(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.sizeOf(context).width * 0.92,
        ),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            color: tone.withValues(alpha: 0.08),
            borderRadius: BorderRadius.circular(16),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.center,
            spacing: 4,
            children: [
              Text(
                entry.title,
                style: Theme.of(context).textTheme.labelLarge?.copyWith(
                  color: tone,
                  fontWeight: FontWeight.w700,
                ),
                textAlign: TextAlign.center,
              ),
              if ((entry.text ?? '').isNotEmpty)
                SelectableText(
                  entry.text!,
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: const Color(0xFF544A40),
                    height: 1.3,
                  ),
                ),
              Text(
                _formatTime(entry.ts),
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

String _toolKey(String? runId, String toolName) =>
    '${runId ?? 'none'}::$toolName';

bool _eventAffectsSessionSummary(String type) {
  return type == 'message.completed' ||
      type == 'run.started' ||
      type == 'run.completed' ||
      type == 'run.failed' ||
      type == 'run.cancelled';
}

String? _prettyToolResponse(Map<String, dynamic> payload) {
  final response = payload['toolResponse'] ?? payload['toolResponseSummary'];
  return _prettySummary(response);
}

String? _prettySummary(Object? raw) {
  final value = _normalizeValue(raw);
  if (value == null) {
    return null;
  }

  if (value is Map) {
    if (value.isEmpty) {
      return null;
    }

    final error = value['error'];
    if (error != null) {
      return _prettySummary(error);
    }

    final returnDisplay = _textOrNull(value['returnDisplay']);
    if (returnDisplay != null && returnDisplay.length > 2) {
      return _clip(returnDisplay, 420);
    }

    final llmContent = value['llmContent'];
    final llmSummary = _prettySummary(llmContent);
    if (llmSummary != null && llmSummary.isNotEmpty) {
      return llmSummary;
    }

    final lines = <String>[];
    for (final entry in value.entries.take(5)) {
      lines.add('${_humanize(entry.key)}: ${_inlineSummary(entry.value)}');
    }
    if (value.length > 5) {
      lines.add('More details available in the host transcript.');
    }
    return lines.join('\n');
  }

  if (value is List) {
    if (value.isEmpty) {
      return null;
    }
    final lines = value.take(4).map(_inlineSummary).toList();
    if (value.length > 4) {
      lines.add('More items omitted.');
    }
    return lines.join('\n');
  }

  final text = value.toString().trim();
  if (text.isEmpty) {
    return null;
  }
  return _clip(text, 420);
}

Object? _normalizeValue(Object? value) {
  if (value == null) {
    return null;
  }

  if (value is String) {
    final trimmed = value.trim();
    if (trimmed.isEmpty) {
      return null;
    }
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return jsonDecode(trimmed);
      } catch (_) {
        return trimmed;
      }
    }
    return trimmed;
  }

  return value;
}

String _inlineSummary(Object? value) {
  final normalized = _normalizeValue(value);
  if (normalized == null) {
    return 'none';
  }

  if (normalized is Map) {
    final interesting = normalized.entries
        .take(2)
        .map(
          (entry) =>
              '${_humanize(entry.key)} ${_clip(_inlineSummary(entry.value), 42)}',
        );
    return interesting.join(', ');
  }

  if (normalized is List) {
    return normalized.isEmpty
        ? 'empty list'
        : '${normalized.length} item${normalized.length == 1 ? '' : 's'}';
  }

  return _clip(normalized.toString().replaceAll('\n', ' '), 80);
}

String _humanize(String key) {
  final withSpaces = key
      .replaceAllMapped(RegExp('([A-Z])'), (match) => ' ${match.group(1)}')
      .replaceAll('_', ' ')
      .trim();
  if (withSpaces.isEmpty) {
    return key;
  }
  return '${withSpaces[0].toUpperCase()}${withSpaces.substring(1)}';
}

String? _textOrNull(Object? value) {
  final text = value?.toString().trim();
  if (text == null || text.isEmpty || text == 'null') {
    return null;
  }
  return text;
}

String _normalizedMessageText(String? value) {
  return (value ?? '').replaceAll(RegExp(r'\s+'), ' ').trim();
}

String _clip(String value, int limit) {
  final normalized = value.trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return '${normalized.substring(0, limit)}...';
}

String _formatTime(DateTime value) {
  final hour = value.hour % 12 == 0 ? 12 : value.hour % 12;
  final minute = value.minute.toString().padLeft(2, '0');
  final suffix = value.hour >= 12 ? 'PM' : 'AM';
  return '${value.month}/${value.day} $hour:$minute $suffix';
}
