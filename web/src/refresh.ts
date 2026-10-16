/**
 * Reloads the app. A home-screen app on iPhone and iPad has no address bar
 * and no pull-to-refresh, so the screen and the dashboard each offer this.
 * The service worker is asked to check for a newer build first (briefly: a
 * stuck network shouldn't stop the reload), and pages load network-first, so
 * the reload gets the latest NoticeBrd.
 */
export async function refreshApp() {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    if (registration) await Promise.race([registration.update(), new Promise((r) => window.setTimeout(r, 1500))]);
  } catch {
    /* reload anyway */
  }
  window.location.reload();
}
