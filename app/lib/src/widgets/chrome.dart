import 'package:flutter/material.dart';

import '../models.dart';
import '../theme.dart';

class AtmosphereScaffold extends StatelessWidget {
  const AtmosphereScaffold({
    super.key,
    required this.title,
    required this.body,
    this.actions,
    this.floatingActionButton,
    this.showAppBar = true,
  });

  final String title;
  final Widget body;
  final List<Widget>? actions;
  final Widget? floatingActionButton;
  final bool showAppBar;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: AppPalette.atmosphereGradient,
        ),
      ),
      child: Scaffold(
        backgroundColor: Colors.transparent,
        appBar: showAppBar
            ? AppBar(
                title: Text(title),
                backgroundColor: Colors.transparent,
                actions: actions,
              )
            : null,
        body: SafeArea(child: body),
        floatingActionButton: floatingActionButton,
      ),
    );
  }
}

class SectionCard extends StatelessWidget {
  const SectionCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(16),
  });

  final Widget child;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(padding: padding, child: child),
    );
  }
}

class StatusPill extends StatelessWidget {
  const StatusPill({super.key, required this.label, required this.color});

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: color,
          fontWeight: FontWeight.w700,
          fontSize: 12,
        ),
      ),
    );
  }
}

class EmptyStateCard extends StatelessWidget {
  const EmptyStateCard({super.key, required this.title, required this.body});

  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        spacing: 8,
        children: [
          Text(
            title,
            style: Theme.of(
              context,
            ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
          ),
          Text(body),
        ],
      ),
    );
  }
}

Color statusColor(String status) {
  switch (status) {
    case 'running':
    case 'connected':
      return AppPalette.success;
    case 'completed':
    case 'installed':
    case 'idle':
      return AppPalette.info;
    case 'cancelled':
      return AppPalette.warning;
    case 'failed':
    case 'missing':
      return AppPalette.error;
    default:
      return AppPalette.neutral;
  }
}

Color connectionColor(ConnectionStatus status) {
  switch (status) {
    case ConnectionStatus.connected:
      return AppPalette.success;
    case ConnectionStatus.connecting:
      return AppPalette.warning;
    case ConnectionStatus.disconnected:
      return AppPalette.neutral;
  }
}

String connectionLabel(ConnectionStatus status) {
  switch (status) {
    case ConnectionStatus.connected:
      return 'Live';
    case ConnectionStatus.connecting:
      return 'Reconnecting';
    case ConnectionStatus.disconnected:
      return 'Offline';
  }
}

Color providerColor(String provider) {
  switch (provider) {
    case 'codex':
      return AppPalette.providerCodex;
    case 'gemini':
    default:
      return AppPalette.providerGemini;
  }
}
