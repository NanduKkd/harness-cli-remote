import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

class AppPalette {
  static const Color brandBlue = Color(0xFF77DDEE);
  static const Color brandYellow = Color(0xFFEEEE99);
  static const Color brandMint = Color(0xFFD2EEBF);

  static const Color canvas = Color(0xFFF5FAE9);
  static const Color surface = Color(0xFFFFFEF3);
  static const Color surfaceSoft = Color(0xFFF3F8E2);
  static const Color surfaceHighlight = Color(0xFFF9F9CB);
  static const Color outline = Color(0xFFD5E2C1);

  static const Color ink = Color(0xFF181714);
  static const Color mutedInk = Color(0xFF505448);
  static const Color neutral = Color(0xFF687062);
  static const Color shadow = Color(0x1611180E);

  static const Color info = Color(0xFF2D6E8D);
  static const Color success = Color(0xFF2E8A70);
  static const Color warning = Color(0xFF9A861F);
  static const Color error = Color(0xFFBB4A3D);

  static const Color providerGemini = info;
  static const Color providerCodex = Color(0xFF4A7869);
  static const Color providerClaude = Color(0xFFB56936);
  static const Color artifactSurface = Color(0xFFDDF3F8);

  static const List<Color> atmosphereGradient = <Color>[
    Color(0xFFDFF8FC),
    Color(0xFFEDF7D7),
    Color(0xFFFFFCD7),
  ];
}

ThemeData buildAppTheme() {
  final colorScheme =
      ColorScheme.fromSeed(
        seedColor: AppPalette.brandBlue,
        brightness: Brightness.light,
      ).copyWith(
        primary: AppPalette.brandBlue,
        onPrimary: AppPalette.ink,
        primaryContainer: const Color(0xFFBDEFF9),
        onPrimaryContainer: AppPalette.ink,
        secondary: AppPalette.brandYellow,
        onSecondary: AppPalette.ink,
        secondaryContainer: const Color(0xFFF7F7C3),
        onSecondaryContainer: AppPalette.ink,
        tertiary: AppPalette.brandMint,
        onTertiary: AppPalette.ink,
        surface: AppPalette.surface,
        onSurface: AppPalette.ink,
        error: AppPalette.error,
        onError: Colors.white,
        outline: AppPalette.outline,
      );

  final baseTheme = ThemeData(
    useMaterial3: true,
    colorScheme: colorScheme,
    scaffoldBackgroundColor: AppPalette.canvas,
    cardTheme: const CardThemeData(
      elevation: 0,
      color: AppPalette.surface,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(20)),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: AppPalette.surface,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(16),
        borderSide: BorderSide.none,
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(16),
        borderSide: BorderSide(color: AppPalette.outline),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(16),
        borderSide: BorderSide(color: AppPalette.brandBlue, width: 1.5),
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: AppPalette.brandBlue,
        foregroundColor: AppPalette.ink,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      ),
    ),
    floatingActionButtonTheme: const FloatingActionButtonThemeData(
      backgroundColor: AppPalette.brandYellow,
      foregroundColor: AppPalette.ink,
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: AppPalette.ink,
        backgroundColor: AppPalette.surface,
        side: const BorderSide(color: AppPalette.outline),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: AppPalette.info,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      ),
    ),
    chipTheme: ChipThemeData(
      backgroundColor: AppPalette.surfaceSoft,
      selectedColor: AppPalette.brandYellow,
      labelStyle: const TextStyle(
        color: AppPalette.ink,
        fontWeight: FontWeight.w600,
      ),
      side: const BorderSide(color: AppPalette.outline),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
    ),
    dividerColor: Colors.transparent,
    snackBarTheme: SnackBarThemeData(
      backgroundColor: AppPalette.ink,
      contentTextStyle: const TextStyle(color: AppPalette.surface),
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
    ),
  );

  return baseTheme.copyWith(
    textTheme: baseTheme.textTheme.apply(
      bodyColor: AppPalette.ink,
      displayColor: AppPalette.ink,
    ),
    appBarTheme: baseTheme.appBarTheme.copyWith(
      backgroundColor: Colors.transparent,
      foregroundColor: AppPalette.ink,
      surfaceTintColor: Colors.transparent,
      systemOverlayStyle: SystemUiOverlayStyle.dark,
      titleTextStyle: baseTheme.textTheme.titleLarge?.copyWith(
        fontWeight: FontWeight.w700,
        color: AppPalette.ink,
      ),
    ),
    visualDensity: const VisualDensity(horizontal: -1, vertical: -1),
  );
}
