/**
 * capacitorService.ts
 *
 * Central service layer for all Capacitor native-plugin interactions.
 * Every method silently no-ops when running on the web so the same code
 * can be used in both the web and native builds without branching at each
 * call-site.
 */

import { isNative, isAndroid } from './platformUtils';
import { createLogger } from './logger';

const log = createLogger('capacitor');

// ─── App theme constants ──────────────────────────────────────────────────────
// Keep in sync with the `theme_color` in public/manifest.json and index.html.
const APP_THEME_COLOR = '#10b981';

// ─── Status Bar ───────────────────────────────────────────────────────────────

/**
 * Apply the app status bar style.
 * No-ops on the web or when the plugin is unavailable.
 */
export async function initStatusBar(): Promise<void> {
  if (!isNative()) return;
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setStyle({ style: Style.Default });
    // On Android, set a translucent background that blends with the app.
    if (isAndroid()) {
      await StatusBar.setBackgroundColor({ color: APP_THEME_COLOR });
    }
  } catch (e) {
    log.warn('StatusBar init failed:', e);
  }
}

// ─── Splash Screen ────────────────────────────────────────────────────────────

/**
 * Hide the native splash screen after the React tree has mounted.
 */
export async function hideSplashScreen(): Promise<void> {
  if (!isNative()) return;
  try {
    const { SplashScreen } = await import('@capacitor/splash-screen');
    await SplashScreen.hide({ fadeOutDuration: 300 });
  } catch (e) {
    log.warn('SplashScreen hide failed:', e);
  }
}

// ─── App Lifecycle (Back Button – Android) ────────────────────────────────────

type BackButtonHandler = () => boolean | void;
let _backButtonHandler: BackButtonHandler | null = null;
let _backButtonListenerRegistered = false;

/**
 * Register a global back-button listener for Android.
 * The provided `handler` is called on every hardware back press.
 * Return `true` (or any truthy value) from the handler to prevent the default
 * behaviour (which closes the WebView / quits the app).
 *
 * Call this once during app startup. Pass a new handler to update the action.
 */
export async function registerBackButtonHandler(
  handler: BackButtonHandler
): Promise<void> {
  if (!isAndroid()) return;
  _backButtonHandler = handler;
  if (_backButtonListenerRegistered) return; // listener already attached
  try {
    const { App } = await import('@capacitor/app');
    App.addListener('backButton', ({ canGoBack }) => {
      if (_backButtonHandler) {
        const handled = _backButtonHandler();
        if (handled) return;
      }
      // Default: go back in browser history or exit the app
      if (canGoBack) {
        window.history.back();
      } else {
        App.exitApp();
      }
    });
    _backButtonListenerRegistered = true;
  } catch (e) {
    log.warn('App back button listener failed:', e);
  }
}
