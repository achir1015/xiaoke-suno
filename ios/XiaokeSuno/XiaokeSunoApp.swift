import SwiftUI
import UIKit
import WebKit

/// 小柯機器人SUNO工具 — iPhone／iPad 版
/// 畫面：WKWebView 開啟 App 內建的手機版網頁（和 Android 版同一份程式），由 LocalServer 在 127.0.0.1 提供。
/// Suno 網頁：第二個 WKWebView 疊在畫面上，位置由網頁告訴我們（sunoBounds），只在「Suno 網頁」分頁顯示。
/// 網頁呼叫 App：window.webkit.messageHandlers.xks.postMessage({cmd, args}) → Promise（下載、存檔、Suno 登入在 Native.swift）。
@main
struct XiaokeSunoApp: App {
    init() {
        LocalServer.shared.start()
    }

    var body: some Scene {
        WindowGroup {
            WebContainer()
                .background(Color(red: 0.051, green: 0.051, blue: 0.071))
                .ignoresSafeArea()
        }
    }
}

struct WebContainer: UIViewRepresentable {
    func makeUIView(context: Context) -> UIView { Web.shared.root }
    func updateUIView(_ v: UIView, context: Context) {}
}

final class Web: NSObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate, WKUIDelegate {
    static let shared = Web()
    let root = UIView()
    let view: WKWebView
    let suno: WKWebView
    let native = Native()
    private var sunoShown = false
    private var observers: [NSKeyValueObservation] = []
    private var selfTested = false

    override init() {
        let bg = UIColor(red: 0.051, green: 0.051, blue: 0.071, alpha: 1)
        let ver = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
        let model = "\(UIDevice.current.model) iOS \(UIDevice.current.systemVersion)"
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        // 讓網頁知道自己在 iPhone／iPad App 裡（js/mobile/android.js 會改用 App 的存檔、Suno 連線）；網頁錯誤轉到系統記錄
        let shim = WKUserScript(source: """
            window.XiaokeIOS = { version: \(Self.js(ver)), model: \(Self.js(model)), platform: 'ios' };
            (function () {
              function send(k, a) { try { window.webkit.messageHandlers.xks.postMessage({ cmd: 'log', args: [k, Array.prototype.map.call(a, function (x) { return x && x.stack ? x.stack : String(x); }).join(' ')] }); } catch (e) {} }
              var ce = console.error.bind(console);
              console.error = function () { send('error', arguments); ce.apply(null, arguments); };
              window.addEventListener('error', function (e) { send('pageerror', [e.message + ' @' + e.filename + ':' + e.lineno]); });
              window.addEventListener('unhandledrejection', function (e) { send('rejection', [e.reason]); });
            })();
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        cfg.userContentController.addUserScript(shim)
        view = WKWebView(frame: .zero, configuration: cfg)
        let scfg = WKWebViewConfiguration()
        scfg.websiteDataStore = .default()
        scfg.allowsInlineMediaPlayback = true
        suno = WKWebView(frame: .zero, configuration: scfg)
        super.init()
        cfg.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "xks")
        native.web = self

        root.backgroundColor = bg
        view.frame = root.bounds
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.navigationDelegate = self
        view.uiDelegate = self
        view.isOpaque = false
        view.backgroundColor = bg
        view.scrollView.backgroundColor = bg
        view.scrollView.isScrollEnabled = false
        view.scrollView.bounces = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        if #available(iOS 16.4, *) { view.isInspectable = true; suno.isInspectable = true }
        suno.navigationDelegate = self
        suno.uiDelegate = self
        suno.isHidden = true
        suno.backgroundColor = UIColor(red: 0.063, green: 0.063, blue: 0.078, alpha: 1)
        suno.allowsBackForwardNavigationGestures = true
        root.addSubview(view)
        root.addSubview(suno)
        observers = [
            suno.observe(\.url) { [weak self] _, _ in self?.tellSuno() },
            suno.observe(\.canGoBack) { [weak self] _, _ in self?.tellSuno() },
        ]
        view.load(URLRequest(url: LocalServer.shared.url))
        suno.load(URLRequest(url: URL(string: "https://suno.com/")!))
    }

    static func js(_ s: String) -> String {
        let d = (try? JSONSerialization.data(withJSONObject: [s])) ?? Data("[\"\"]".utf8)
        return String(String(decoding: d, as: UTF8.self).dropFirst().dropLast())
    }

    /// 在畫面網頁執行 JavaScript
    func eval(_ code: String) { DispatchQueue.main.async { self.view.evaluateJavaScript(code, completionHandler: nil) } }

    func tellSuno() {
        let o: [String: Any] = ["url": suno.url?.absoluteString ?? "", "canBack": suno.canGoBack, "canForward": suno.canGoForward]
        if let d = try? JSONSerialization.data(withJSONObject: o) { eval("window.__xkSuno&&window.__xkSuno(\(String(decoding: d, as: UTF8.self)))") }
    }

    // MARK: 網址：畫面網頁的外部連結用 Safari 開；Suno 網頁內可以自由瀏覽（登入、工作區）
    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let u = a.request.url else { decisionHandler(.allow); return }
        if w === suno {
            decisionHandler(["http", "https", "about", "blob", "data"].contains(u.scheme ?? "") ? .allow : .cancel)
            return
        }
        if u.host != "127.0.0.1", u.scheme?.hasPrefix("http") == true, a.targetFrame?.isMainFrame != false {
            UIApplication.shared.open(u); decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }
    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures f: WKWindowFeatures) -> WKWebView? {
        if w === suno { suno.load(a.request) } else if let u = a.request.url { UIApplication.shared.open(u) }
        return nil
    }
    func webView(_ w: WKWebView, didFinish nav: WKNavigation!) {
        if w === suno { tellSuno(); return }
        selfTest(w)
    }
    func webViewWebContentProcessDidTerminate(_ w: WKWebView) { w.reload() }

    /// 掃描 QR Code 要用相機：只允許 App 自己的畫面網頁
    func webView(_ w: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(w === view && origin.host == "127.0.0.1" ? .grant : .deny)
    }

    // MARK: Suno 網頁的位置（CSS 像素＝點）
    func sunoBounds(_ x: Double, _ y: Double, _ w: Double, _ h: Double) {
        DispatchQueue.main.async {
            self.suno.frame = CGRect(x: x, y: y, width: max(1, w), height: max(1, h))
            self.suno.isHidden = !(self.sunoShown && w > 1 && h > 1)
        }
    }
    func sunoVisible(_ v: Bool) {
        DispatchQueue.main.async {
            self.sunoShown = v
            self.suno.isHidden = !(v && self.suno.frame.width > 1)
        }
    }
    func sunoNav(_ action: String, _ url: String) {
        DispatchQueue.main.async {
            switch action {
            case "back": if self.suno.canGoBack { self.suno.goBack() }
            case "forward": if self.suno.canGoForward { self.suno.goForward() }
            case "reload": self.suno.reload()
            case "home": self.suno.load(URLRequest(url: URL(string: "https://suno.com/")!))
            case "url": if url.hasPrefix("https://"), let u = URL(string: url) { self.suno.load(URLRequest(url: u)) }
            default: break
            }
        }
    }

    // MARK: 網頁呼叫的功能
    func userContentController(_ u: WKUserContentController, didReceive m: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = m.body as? [String: Any], let cmd = body["cmd"] as? String else { replyHandler(nil, "bad message"); return }
        let args = body["args"] as? [Any] ?? []
        let s = { (i: Int) -> String in args.count > i ? "\(args[i])" : "" }
        let d = { (i: Int) -> Double in args.count > i ? ((args[i] as? NSNumber)?.doubleValue ?? 0) : 0 }
        switch cmd {
        case "call":
            let method = s(0), a = s(1)
            Task {
                do {
                    let r = try await self.native.dispatch(method, a)
                    DispatchQueue.main.async { replyHandler(r, nil) }
                } catch {
                    DispatchQueue.main.async { replyHandler(nil, error.localizedDescription) }
                }
            }
        case "sunoBounds": sunoBounds(d(0), d(1), d(2), d(3)); replyHandler(true, nil)
        case "sunoVisible": sunoVisible((args.first as? NSNumber)?.boolValue ?? false); replyHandler(true, nil)
        case "sunoNav": sunoNav(s(0), s(1)); replyHandler(true, nil)
        case "openUrl":
            if let url = URL(string: s(0)), ["github.com", "achir1015.github.io", "platform.openai.com", "suno.com"].contains(url.host ?? "") { UIApplication.shared.open(url) }
            replyHandler(true, nil)
        case "log":
            NSLog("[web %@] %@", s(0), s(1))
            replyHandler(true, nil)
        default:
            replyHandler(nil, "unknown command \(cmd)")
        }
    }

    // 實機自我檢查：devicectl 帶環境變數 XK_SELFTEST=1 啟動才會跑，結果寫到 App 的 Documents（selftest.txt、selftest.png）
    private func selfTest(_ w: WKWebView) {
        guard ProcessInfo.processInfo.environment["XK_SELFTEST"] == "1", !selfTested else { return }
        selfTested = true
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
            w.evaluateJavaScript("document.querySelector('.modal-head .icon-btn')?.click(); document.querySelector('#nav-suno')?.click(); 1") { _, _ in
                DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                    let js = """
                    JSON.stringify({ ready: document.documentElement.dataset.ready, mobile: document.documentElement.classList.contains('mobile'), version: window.XK_VERSION, ios: !!window.XiaokeIOS,
                      w: innerWidth, h: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth + 1,
                      navTop: Math.round(document.querySelector('#side').getBoundingClientRect().top), qr: !!document.querySelector('#snQR') && !document.querySelector('#snQR').hidden,
                      host: JSON.stringify(document.querySelector('#sunoHost').getBoundingClientRect()), zhVoices: speechSynthesis.getVoices().filter((v) => /^zh/i.test(v.lang)).length,
                      pill: document.querySelector('#sunoPill').textContent, errors: (window.__xkErrors || []).length })
                    """
                    w.evaluateJavaScript(js) { r, e in
                        let extra = " | sunoFrame=\(NSCoder.string(for: self.suno.frame)) sunoHidden=\(self.suno.isHidden) sunoURL=\(self.suno.url?.absoluteString ?? "")"
                        try? (String(describing: r ?? e ?? "nil") + extra).write(to: docs.appendingPathComponent("selftest.txt"), atomically: true, encoding: .utf8)
                        let snap = WKSnapshotConfiguration()
                        w.takeSnapshot(with: snap) { img, _ in try? img?.pngData()?.write(to: docs.appendingPathComponent("selftest.png")) }
                    }
                }
            }
        }
    }
}
