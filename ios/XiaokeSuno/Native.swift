import Foundation
import UIKit
import WebKit

/// 網頁 call(方法, 參數) 的實作（和 Android 版 Bridge.java 相同的方法名稱與回傳格式）
/// Suno 登入：WKWebView 的 cookie 裡 auth.suno.com 的 __client（長效），需要時向 Suno 的登入服務（Clerk）換短效權杖。
/// 檔案：App 的「文件／小柯SUNO」，在「檔案」App →「我的 iPhone／iPad」看得到。
final class Native {
    weak var web: Web?
    let auth = Auth()
    let folder: URL = {
        let d = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("小柯SUNO", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()

    struct Fail: LocalizedError { let msg: String; var errorDescription: String? { msg } }

    func dispatch(_ m: String, _ argsJson: String) async throws -> Any {
        let a = (try? JSONSerialization.jsonObject(with: Data(argsJson.utf8))) as? [Any] ?? []
        let s = { (i: Int) -> String in a.count > i ? "\(a[i])" : "" }
        switch m {
        case "suno": return try await suno(s(0), s(1), s(2))
        case "sunoLogin": return ["loggedIn": (try await auth.token()) != nil]
        case "importLogin": return try await importLogin(s(0))
        case "logout": return await logout()
        case "download": return try await download(s(0), s(1), s(3))
        case "writeText":
            // 網頁拿掉了開頭的 BOM（iOS 傳字串會吃掉），旗標是 bom 時在這裡補上
            var d = s(3) == "bom" ? Data([0xEF, 0xBB, 0xBF]) : Data()
            d.append(Data(s(1).utf8))
            return try write(s(0), d)
        case "listFiles": return (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
        case "exists": return FileManager.default.fileExists(atPath: path(s(0)))
        case "readText": return try String(contentsOfFile: path(s(0)), encoding: .utf8)
        case "readB64": return try Data(contentsOf: URL(fileURLWithPath: path(s(0)))).base64EncodedString()
        case "sunoEval": return try await sunoEval(s(0))
        case "notify": return true
        default: throw Fail(msg: "沒有這個功能：\(m)")
        }
    }

    // MARK: Suno 連線
    static let ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

    func suno(_ method: String, _ url: String, _ body: String) async throws -> [String: Any] {
        guard url.hasPrefix("https://studio-api-prod.suno.com/") || url.hasPrefix("https://suno.com/a/api/"), let u = URL(string: url) else { throw Fail(msg: "不允許的網址") }
        guard let t = try await auth.token() else { return ["status": -1] }
        var r = URLRequest(url: u, timeoutInterval: 30)
        r.httpMethod = method
        r.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        r.setValue(Self.ua, forHTTPHeaderField: "User-Agent")
        r.setValue("application/json, text/plain, */*", forHTTPHeaderField: "Accept")
        if !body.isEmpty { r.httpBody = Data(body.utf8); r.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, resp) = try await URLSession.shared.data(for: r)
        let h = resp as? HTTPURLResponse
        if h?.statusCode == 401 || h?.statusCode == 403 { await auth.reset() }
        return ["status": h?.statusCode ?? 0, "text": String(decoding: data, as: UTF8.self), "retry": h?.value(forHTTPHeaderField: "Retry-After") ?? ""]
    }

    /// 從電腦帶來的登入 cookie：[[名稱, 值, 網域, 到期秒數]]
    func importLogin(_ json: String) async throws -> [String: Any] {
        guard let list = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [[Any]] else { throw Fail(msg: "QR Code 內容不正確") }
        var n = 0
        for c in list where c.count >= 3 {
            let name = "\(c[0])", value = "\(c[1])", domain = "\(c[2])"
            let exp = (c.count > 3 ? (c[3] as? NSNumber)?.doubleValue : nil) ?? 0
            guard name.hasPrefix("__client"), domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")).hasSuffix("suno.com") else { continue }
            var p: [HTTPCookiePropertyKey: Any] = [.name: name, .value: value, .domain: domain, .path: "/", .secure: "TRUE"]
            p[.expires] = exp > Date().timeIntervalSince1970 ? Date(timeIntervalSince1970: exp) : Date().addingTimeInterval(31_536_000)
            if let ck = HTTPCookie(properties: p) { await Auth.set(ck); n += 1 }
        }
        await auth.reset()
        if n == 0 { throw Fail(msg: "QR Code 裡沒有 Suno 登入資料") }
        web?.sunoNav("reload", "")
        return ["count": n]
    }

    /// 只清 Suno 的登入與網站資料（App 自己的設定、歌曲庫在 127.0.0.1，不能一起清掉）
    func logout() async -> Bool {
        await MainActor.run {
            let store = WKWebsiteDataStore.default()
            store.httpCookieStore.getAllCookies { all in
                for c in all where c.domain.contains("suno") || c.domain.contains("clerk") { store.httpCookieStore.delete(c) }
            }
            store.fetchDataRecords(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes()) { recs in
                store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), for: recs.filter { $0.displayName.contains("suno") || $0.displayName.contains("clerk") }) {}
            }
        }
        await auth.reset()
        web?.sunoNav("home", "")
        return true
    }

    /// 在 Suno 網頁執行會回傳 Promise 的程式（抓取這一頁的歌）
    func sunoEval(_ code: String) async throws -> String {
        let r = try await evalOnSuno(code)
        return r.map { "\($0)" } ?? "[]"
    }

    @MainActor private func evalOnSuno(_ code: String) async throws -> Any? {
        guard let web else { throw Fail(msg: "Suno 網頁還沒準備好") }
        return try await web.suno.callAsyncJavaScript("return await (\(code));", arguments: [:], in: nil, contentWorld: .page)
    }

    // MARK: 存檔
    static func clean(_ n: String) -> String {
        n.components(separatedBy: CharacterSet(charactersIn: "\\/:*?\"<>|")).joined(separator: "_").trimmingCharacters(in: .whitespaces)
    }
    func path(_ uri: String) -> String { uri.hasPrefix("file://") ? String(uri.dropFirst(7)) : uri }

    /// 同名的舊檔先刪掉（同一首歌重新下載時沿用原本檔名）
    func write(_ name: String, _ data: Data) throws -> [String: Any] {
        let f = folder.appendingPathComponent(Self.clean(name))
        try? FileManager.default.removeItem(at: f)
        try data.write(to: f, options: .atomic)
        return ["uri": "file://" + f.path, "path": "小柯SUNO/" + f.lastPathComponent]
    }

    func download(_ url: String, _ name: String, _ key: String) async throws -> [String: Any] {
        guard url.hasPrefix("https://"), let u = URL(string: url) else { throw Fail(msg: "不允許的網址") }
        var r = URLRequest(url: u, timeoutInterval: 120)
        r.setValue(Self.ua, forHTTPHeaderField: "User-Agent")
        let (tmp, resp) = try await URLSession.shared.download(for: r)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard code < 400 else { throw Fail(msg: "下載失敗（\(code)）") }
        let size = (try? FileManager.default.attributesOfItem(atPath: tmp.path)[.size] as? NSNumber)?.int64Value ?? 0
        if size < 1000 { throw Fail(msg: "檔案內容不完整") }
        let f = folder.appendingPathComponent(Self.clean(name))
        try? FileManager.default.removeItem(at: f)
        try FileManager.default.moveItem(at: tmp, to: f)
        web?.eval("window.__xkDl&&window.__xkDl(\(Web.js(key)),\(size),\(size))")
        return ["uri": "file://" + f.path, "path": "小柯SUNO/" + f.lastPathComponent]
    }
}

/// Suno 登入權杖：同一時間只換一次，快過期才重新換
actor Auth {
    static let clerk = "https://auth.suno.com"
    static let clerkV = "5.117.0"
    private var jwt: String?
    private var exp: Double = 0

    func reset() { jwt = nil }

    @MainActor static func cookies() async -> [HTTPCookie] {
        await withCheckedContinuation { c in WKWebsiteDataStore.default().httpCookieStore.getAllCookies { c.resume(returning: $0) } }
    }
    @MainActor static func set(_ ck: HTTPCookie) async {
        await withCheckedContinuation { c in WKWebsiteDataStore.default().httpCookieStore.setCookie(ck) { c.resume() } }
    }

    static func header(_ all: [HTTPCookie], host: String) -> String {
        all.filter { c in
            let d = c.domain.hasPrefix(".") ? String(c.domain.dropFirst()) : c.domain
            return host == d || (c.domain.hasPrefix(".") && host.hasSuffix("." + d))
        }.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
    }

    static func jwtExp(_ t: String) -> Double {
        let parts = t.split(separator: ".")
        guard parts.count > 1 else { return 0 }
        var b = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b.count % 4 != 0 { b += "=" }
        guard let d = Data(base64Encoded: b), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return 0 }
        return (o["exp"] as? NSNumber)?.doubleValue ?? 0
    }

    /// Clerk 回應更新的 cookie（例如新的 __client）存回 WKWebView
    static func keep(_ resp: URLResponse) async {
        guard let h = resp as? HTTPURLResponse, let url = h.url else { return }
        let fields = h.allHeaderFields.reduce(into: [String: String]()) { r, kv in r["\(kv.key)"] = "\(kv.value)" }
        for c in HTTPCookie.cookies(withResponseHeaderFields: fields, for: url) { await set(c) }
    }

    func token() async throws -> String? {
        if let jwt, exp - 60 > Date().timeIntervalSince1970 { return jwt }
        let cookie = Self.header(await Self.cookies(), host: "auth.suno.com")
        guard cookie.contains("__client=") else { jwt = nil; return nil }
        var r1 = URLRequest(url: URL(string: "\(Self.clerk)/v1/client?_clerk_js_version=\(Self.clerkV)")!, timeoutInterval: 20)
        r1.setValue(cookie, forHTTPHeaderField: "Cookie")
        r1.setValue("https://suno.com", forHTTPHeaderField: "Origin")
        r1.setValue(Native.ua, forHTTPHeaderField: "User-Agent")
        r1.httpShouldHandleCookies = false
        let (d1, resp1) = try await URLSession.shared.data(for: r1)
        await Self.keep(resp1)
        guard (resp1 as? HTTPURLResponse)?.statusCode == 200,
              let o = try? JSONSerialization.jsonObject(with: d1) as? [String: Any], let res = o["response"] as? [String: Any] else { jwt = nil; return nil }
        var sid = res["last_active_session_id"] as? String ?? ""
        if sid.isEmpty, let ss = res["sessions"] as? [[String: Any]], let first = ss.first { sid = first["id"] as? String ?? "" }
        guard !sid.isEmpty else { jwt = nil; return nil }
        var r2 = URLRequest(url: URL(string: "\(Self.clerk)/v1/client/sessions/\(sid)/tokens?_clerk_js_version=\(Self.clerkV)")!, timeoutInterval: 20)
        r2.httpMethod = "POST"
        r2.setValue(Self.header(await Self.cookies(), host: "auth.suno.com"), forHTTPHeaderField: "Cookie")
        r2.setValue("https://suno.com", forHTTPHeaderField: "Origin")
        r2.setValue(Native.ua, forHTTPHeaderField: "User-Agent")
        r2.httpShouldHandleCookies = false
        let (d2, resp2) = try await URLSession.shared.data(for: r2)
        await Self.keep(resp2)
        guard (resp2 as? HTTPURLResponse)?.statusCode == 200,
              let o2 = try? JSONSerialization.jsonObject(with: d2) as? [String: Any], let t = o2["jwt"] as? String, !t.isEmpty else { jwt = nil; return nil }
        jwt = t
        exp = Self.jwtExp(t)
        return t
    }
}
