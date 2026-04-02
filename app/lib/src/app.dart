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

    final theme = ThemeData(
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
          borderRadius: BorderRadius.all(Radius.circular(24)),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: Colors.white,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(18),
          borderSide: BorderSide.none,
        ),
      ),
    );

    return MaterialApp(
      title: 'Gemini Remote',
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
    return const Scaffold(
      body: Center(
        child: CircularProgressIndicator(),
      ),
    );
  }
}
