import UIKit
import WebKit

/// The screen page, edge to edge on black: no status bar, no home indicator.
final class ScreenViewController: UIViewController {
    private let startURL: URL
    private var webView: WKWebView!
    private let notice = UILabel()
    private var retry: Task<Void, Never>?
    /// A page has loaded at least once; until then a failure leaves nothing on screen.
    private var loadedOnce = false
    private var failedURL: URL?

    /// Seconds between attempts while NoticeBrd can't be reached.
    private static let retrySeconds: UInt64 = 10

    init(startURL: URL) {
        self.startURL = startURL
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    /// A stray swipe at an edge doesn't pull down Control Center or go home: iOS waits for a second one.
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .all }

    override func loadView() {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        // The page reads this to know the app keeps the device awake (web/src/device.ts).
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1"
        configuration.applicationNameForUserAgent = "Mobile/15E148 NoticeBrdApp/\(version)"
        // The screen's identity is a cookie; the default store keeps it across launches.
        configuration.websiteDataStore = .default()

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        webView.navigationDelegate = self
        webView.uiDelegate = self
        #if DEBUG
        if #available(iOS 16.4, *) {
            webView.isInspectable = true // Safari → Develop, to debug the page
        }
        #endif
        webView.translatesAutoresizingMaskIntoConstraints = false
        self.webView = webView

        notice.text = "Can't reach NoticeBrd. Retrying…"
        notice.textColor = UIColor(white: 0.42, alpha: 1)
        notice.font = .preferredFont(forTextStyle: .title3)
        notice.textAlignment = .center
        notice.numberOfLines = 0
        notice.isHidden = true
        notice.translatesAutoresizingMaskIntoConstraints = false

        let root = UIView()
        root.backgroundColor = .black
        root.addSubview(webView)
        root.addSubview(notice)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: root.topAnchor),
            webView.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            notice.centerYAnchor.constraint(equalTo: root.centerYAnchor),
            notice.leadingAnchor.constraint(equalTo: root.layoutMarginsGuide.leadingAnchor),
            notice.trailingAnchor.constraint(equalTo: root.layoutMarginsGuide.trailingAnchor),
        ])
        view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        load(startURL)
    }

    private func load(_ url: URL) {
        retry?.cancel()
        retry = nil
        webView.load(URLRequest(url: url))
    }

    /// Back in front after a failed load: try again now rather than at the next retry.
    func cameToFront() {
        if let url = failedURL { load(url) }
    }

    private func failed(_ error: Error) {
        let error = error as NSError
        // Replaced by a newer navigation: not a failure.
        if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled { return }
        let url = (error.userInfo[NSURLErrorFailingURLErrorKey] as? URL) ?? webView.url ?? startURL
        failedURL = url
        // A failed reload leaves the page that was showing, still working; say nothing over it.
        notice.isHidden = loadedOnce
        retry?.cancel()
        retry = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: Self.retrySeconds * 1_000_000_000)
            guard !Task.isCancelled, let self, self.failedURL != nil else { return }
            self.load(url)
        }
    }
}

extension ScreenViewController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loadedOnce = true
        failedURL = nil
        notice.isHidden = true
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    /// iOS can end a page's process to free memory, leaving a blank view. A screen can't stay blank.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        load(webView.url ?? startURL)
    }

    /// NoticeBrd's own pages stay in the app; any other link opens in Safari.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if url.host == startURL.host || ["about", "blob", "data"].contains(url.scheme ?? "") {
            decisionHandler(.allow)
            return
        }
        UIApplication.shared.open(url)
        decisionHandler(.cancel)
    }
}

/// The page's alert() and confirm() — unpairing asks first — as iOS alerts.
extension ScreenViewController: WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor () -> Void
    ) {
        guard presentedViewController == nil else {
            completionHandler()
            return
        }
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor (Bool) -> Void
    ) {
        guard presentedViewController == nil else {
            completionHandler(false)
            return
        }
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }

    /// Links that open a new window go to Safari.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url { UIApplication.shared.open(url) }
        return nil
    }
}
