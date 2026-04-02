import 'package:flutter/material.dart';

import '../models.dart';

class AtmosphereScaffold extends StatelessWidget {
  const AtmosphereScaffold({
    super.key,
    required this.title,
    required this.body,
    this.actions,
    this.floatingActionButton,
  });

  final String title;
  final Widget body;
  final List<Widget>? actions;
  final Widget? floatingActionButton;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            Color(0xFFFFF4E8),
            Color(0xFFF5E7D7),
            Color(0xFFEFE4DE),
          ],
        ),
      ),
      child: Scaffold(
        backgroundColor: Colors.transparent,
        appBar: AppBar(
          title: Text(title),
          backgroundColor: Colors.transparent,
          actions: actions,
        ),
        body: SafeArea(
          child: body,
        ),
        floatingActionButton: floatingActionButton,
      ),
    );
  }
}

class SectionCard extends StatelessWidget {
  const SectionCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(20),
  });

  final Widget child;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: padding,
        child: child,
      ),
    );
  }
}

class StatusPill extends StatelessWidget {
  const StatusPill({
    super.key,
    required this.label,
    required this.color,
  });

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: color,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

class EmptyStateCard extends StatelessWidget {
  const EmptyStateCard({
    super.key,
    required this.title,
    required this.body,
  });

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
            style: Theme.of(context).textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w700,
                ),
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
      return const Color(0xFF29785A);
    case 'completed':
    case 'installed':
    case 'idle':
      return const Color(0xFF2F5BA8);
    case 'cancelled':
      return const Color(0xFF9A5F16);
    case 'failed':
    case 'missing':
      return const Color(0xFFB33D2E);
    default:
      return const Color(0xFF5F6670);
  }
}

Color connectionColor(ConnectionStatus status) {
  switch (status) {
    case ConnectionStatus.connected:
      return const Color(0xFF29785A);
    case ConnectionStatus.connecting:
      return const Color(0xFF9A5F16);
    case ConnectionStatus.disconnected:
      return const Color(0xFF5F6670);
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
