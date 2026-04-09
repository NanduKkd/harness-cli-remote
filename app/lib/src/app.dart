import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'screens/pair_screen.dart';
import 'screens/workspaces_screen.dart';
import 'state/app_state.dart';

class GeminiRemoteApp extends ConsumerWidget {
  const GeminiRemoteApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final authState = ref.watch(authControllerProvider);
    ref.read(realtimeServiceProvider).configure(authState.valueOrNull);

    final baseTheme = ThemeData(
      useMaterial3: true,
      colorScheme: ColorScheme.fromSeed(
        seedColor: const Color(0xFFCD6A33),
        brightness: Brightness.light,
      ),
      scaffoldBackgroundColor: const Color(0xFFF7F1E8),
      cardTheme: const CardThemeData(
        elevation: 0,
        color: Colors.white,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(20)),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: Colors.white,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(16),
          borderSide: BorderSide.none,
        ),
      ),
    );
    final theme = baseTheme.copyWith(
      textTheme: baseTheme.textTheme.apply(
        bodyColor: const Color(0xFF2E2B27),
        displayColor: const Color(0xFF2E2B27),
      ),
      appBarTheme: baseTheme.appBarTheme.copyWith(
        titleTextStyle: baseTheme.textTheme.titleLarge?.copyWith(
          fontWeight: FontWeight.w700,
        ),
      ),
      visualDensity: const VisualDensity(horizontal: -1, vertical: -1),
    );

    return MaterialApp(
      title: 'CLI Remote',
      theme: theme,
      debugShowCheckedModeBanner: false,
      home: authState.when(
        data: (auth) =>
            auth == null ? const PairScreen() : const WorkspacesScreen(),
        loading: () => const _SplashScreen(),
        error: (error, _) => PairScreen(errorText: error.toString()),
      ),
    );
  }
}

class _SplashScreen extends StatelessWidget {
  const _SplashScreen();

  @override
  Widget build(BuildContext context) {
    return const Scaffold(body: Center(child: CircularProgressIndicator()));
  }
}
