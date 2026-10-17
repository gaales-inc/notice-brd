import UIKit

/// The NoticeBrd app for iPhone and iPad: the screen page from
/// noticebrd.gaales.com, full screen and kept awake.
///
/// Everything a screen does — pairing, messages, staying connected — is the
/// web page's. The app adds what a web page on iOS can't have: no status bar
/// or home indicator, and a device that never locks while NoticeBrd is in
/// front, with no tap needed first.
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.backgroundColor = .black
        window.rootViewController = ScreenViewController(startURL: startURL())
        window.makeKeyAndVisible()
        self.window = window
    }

    /// A notice board doesn't lock while it's showing. iOS lets the device sleep
    /// again as soon as the app leaves the front, whatever this says.
    func sceneDidBecomeActive(_ scene: UIScene) {
        UIApplication.shared.isIdleTimerDisabled = true
        (window?.rootViewController as? ScreenViewController)?.cameToFront()
    }

    func sceneWillResignActive(_ scene: UIScene) {
        UIApplication.shared.isIdleTimerDisabled = false
    }
}

/// The page to show. A development build can point at another NoticeBrd with
/// the launch argument `-NoticeBrdURL http://localhost:3000/screen`.
func startURL() -> URL {
    if let value = UserDefaults.standard.string(forKey: "NoticeBrdURL"),
       let url = URL(string: value),
       url.scheme == "https" || url.scheme == "http" {
        return url
    }
    return URL(string: "https://noticebrd.gaales.com/screen")!
}
