import 'package:flutter/material.dart';

import '../models.dart';
import 'chrome.dart';

class RunDiagnosticsCard extends StatelessWidget {
  const RunDiagnosticsCard({
    super.key,
    required this.session,
    required this.runs,
    required this.isLoading,
    required this.errorText,
    required this.onRefresh,
  });

  final RemoteSession session;
  final List<RunRecord> runs;
  final bool isLoading;
  final String? errorText;
  final VoidCallback onRefresh;

  @override
  Widget build(BuildContext context) {
    final completed = runs.where((run) => run.status == 'completed').length;
    final failed = runs.where((run) => run.status == 'failed').length;
    final cancelled = runs.where((run) => run.cancelledByUser).length;

    return SectionCard(
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        spacing: 8,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  'Run diagnostics',
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              IconButton(
                onPressed: onRefresh,
                tooltip: 'Refresh diagnostics',
                icon: const Icon(Icons.refresh_rounded),
              ),
            ],
          ),
          Text(
            'Session ${_shortId(session.id)} is ${session.status}. Runs are listed with exit codes, tails, and completion status.',
          ),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              _MetricChip(label: 'Runs', value: '${runs.length}'),
              _MetricChip(label: 'Completed', value: '$completed'),
              _MetricChip(label: 'Failed', value: '$failed'),
              _MetricChip(label: 'Cancelled', value: '$cancelled'),
            ],
          ),
          if (isLoading)
            const Center(child: CircularProgressIndicator())
          else if (errorText != null)
            Text(
              errorText!,
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: Theme.of(context).colorScheme.error,
              ),
            )
          else if (runs.isEmpty)
            Text(
              'No run records have been returned for this session yet.',
              style: Theme.of(context).textTheme.bodyMedium,
            )
          else ...[
            ...runs
                .take(3)
                .map(
                  (run) => Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: _RunTile(run: run),
                  ),
                ),
            if (runs.length > 3)
              Text(
                'Showing the latest 3 of ${runs.length} runs.',
                style: Theme.of(context).textTheme.bodySmall,
              ),
          ],
        ],
      ),
    );
  }
}

class _MetricChip extends StatelessWidget {
  const _MetricChip({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: const Color(0xFFFFF4E8),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        '$label $value',
        style: Theme.of(
          context,
        ).textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w700),
      ),
    );
  }
}

class _RunTile extends StatelessWidget {
  const _RunTile({required this.run});

  final RunRecord run;

  @override
  Widget build(BuildContext context) {
    final statusColorValue = statusColor(run.status);
    final subtitle = _buildSubtitle(run);
    final details = <Widget>[
      _TailBlock(label: 'Prompt', body: run.prompt),
      if ((run.stdoutTail ?? '').trim().isNotEmpty)
        _TailBlock(label: 'Stdout tail', body: run.stdoutTail!),
      if ((run.stderrTail ?? '').trim().isNotEmpty)
        _TailBlock(label: 'Stderr tail', body: run.stderrTail!),
      if (run.cancelledByUser)
        const _TailBlock(
          label: 'Cancelled',
          body: 'This run was cancelled by the user from the mobile app.',
        ),
      if (run.exitCode != null)
        _TailBlock(label: 'Exit code', body: '${run.exitCode}'),
    ];

    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFE4D5C6)),
      ),
      child: Theme(
        data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
        child: ExpansionTile(
          tilePadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          childrenPadding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
          title: Row(
            children: [
              Expanded(
                child: Text(
                  _shortPrompt(run.prompt),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(
                    context,
                  ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700),
                ),
              ),
              const SizedBox(width: 8),
              StatusPill(label: run.status, color: statusColorValue),
            ],
          ),
          subtitle: Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(subtitle, style: Theme.of(context).textTheme.bodySmall),
          ),
          children: details.isEmpty
              ? [
                  const Padding(
                    padding: EdgeInsets.only(top: 4),
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: Text('No run tails were captured.'),
                    ),
                  ),
                ]
              : details,
        ),
      ),
    );
  }

  String _buildSubtitle(RunRecord run) {
    final parts = <String>[
      'Started ${_formatTime(run.startedAt)}',
      if (run.endedAt != null)
        'Ended ${_formatTime(run.endedAt!)}'
      else
        'In progress',
      if (run.exitCode != null) 'Exit ${run.exitCode}',
      if (run.cancelledByUser) 'Cancelled by user',
    ];
    return parts.join(' · ');
  }

  String _shortPrompt(String prompt) {
    final trimmed = prompt.trim();
    if (trimmed.isEmpty) {
      return 'Run ${_shortId(run.id)}';
    }
    return trimmed.replaceAll(RegExp(r'\s+'), ' ');
  }
}

class _TailBlock extends StatelessWidget {
  const _TailBlock({required this.label, required this.body});

  final String label;
  final String body;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: const Color(0xFFFFFBF7),
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
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
              fontFamily: 'monospace',
              height: 1.4,
            ),
          ),
        ],
      ),
    );
  }
}

String _shortId(String value) {
  if (value.length <= 12) {
    return value;
  }
  return '${value.substring(0, 8)}...${value.substring(value.length - 4)}';
}

String _formatTime(DateTime value) {
  final hour = value.hour % 12 == 0 ? 12 : value.hour % 12;
  final minute = value.minute.toString().padLeft(2, '0');
  final suffix = value.hour >= 12 ? 'PM' : 'AM';
  return '${value.month}/${value.day} $hour:$minute $suffix';
}
