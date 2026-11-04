package com.achir.xiaokesuno;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.AssetFileDescriptor;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.util.Log;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * 小柯機器人SUNO工具 — Android 版
 * 畫面：和桌面版同一份網頁（APK 的 assets/web），從 https://appassets.androidplatform.net/ 載入。
 * Suno 網頁：第二個 WebView 疊在畫面上，位置由網頁告訴我們（sunoBounds），只在「Suno 網頁」分頁顯示。
 * 下載好的 MP3 從 /media/<content uri> 讀出來給試聽用（支援 Range，才能拖曳進度）。
 * 離開 App（finish）時兩個 WebView 一併銷毀：下載、連線、語音都會停止。
 */
public class MainActivity extends Activity {
    static final String TAG = "XiaokeSuno";
    static final String ORIGIN = "https://appassets.androidplatform.net";
    static final String SUNO_HOME = "https://suno.com/";
    static final int REQ_CAM = 2;

    WebView web, suno;
    FrameLayout root;
    Bridge bridge;
    long lastBack = 0;
    PermissionRequest pendingCam;
    String[] pendingRes;
    boolean sunoShown = false;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED);
        WebView.setWebContentsDebuggingEnabled(BuildFlags.DEBUG);   // python build.py debug 才開
        root = new FrameLayout(this);
        web = new WebView(this);
        web.setBackgroundColor(0xFF0D0D12);
        suno = new WebView(this);
        suno.setBackgroundColor(0xFF101014);
        suno.setVisibility(View.GONE);
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        root.addView(suno, new FrameLayout.LayoutParams(1, 1));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setTextZoom(100);
        s.setUserAgentString(s.getUserAgentString() + " XiaokeSunoAndroid/" + Bridge.version(this));

        bridge = new Bridge(this);
        web.addJavascriptInterface(bridge, "XiaokeAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (!ORIGIN.equals(u.getScheme() + "://" + u.getHost())) return null;
                String p = u.getPath();
                if (p != null && p.startsWith("/media/")) return media(Uri.decode(p.substring(7)), req.getRequestHeaders());
                return serve(p);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (ORIGIN.equals(u.getScheme() + "://" + u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception ignored) { }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            /** 掃描電腦的 QR Code 要用相機：先問 Android 的權限，再允許網頁使用 */
            @Override
            public void onPermissionRequest(final PermissionRequest r) {
                boolean video = false;
                for (String x : r.getResources()) if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(x)) video = true;
                if (!video) { r.deny(); return; }
                String[] res = { PermissionRequest.RESOURCE_VIDEO_CAPTURE };
                if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) { r.grant(res); return; }
                pendingCam = r;
                pendingRes = res;
                requestPermissions(new String[]{ Manifest.permission.CAMERA }, REQ_CAM);
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.d(TAG, m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
                return true;
            }
        });

        setupSuno();
        web.loadUrl(ORIGIN + "/index.html");
    }

    /** 內建的 Suno 網頁：登入（電子郵件等）、瀏覽工作區、抓取這一頁的歌 */
    void setupSuno() {
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(suno, true);
        WebSettings s = suno.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportMultipleWindows(false);
        suno.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                String sc = req.getUrl().getScheme();
                return !("http".equals(sc) || "https".equals(sc));
            }

            @Override
            public void doUpdateVisitedHistory(WebView v, String url, boolean reload) { tellSuno(); }

            @Override
            public void onPageFinished(WebView v, String url) { tellSuno(); }
        });
        // 網頁上 Suno 自己的下載鈕：交給 Android 下載到「下載/小柯SUNO」
        suno.setDownloadListener((url, ua, cd, mime, len) -> {
            if (!URLUtil.isNetworkUrl(url)) { Toast.makeText(this, "請改用小柯的「下載所選」", Toast.LENGTH_LONG).show(); return; }
            try {
                String name = URLUtil.guessFileName(url, cd, mime);
                DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url))
                        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                        .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, Bridge.FOLDER + "/" + name);
                String ck = CookieManager.getInstance().getCookie(url);
                if (ck != null) r.addRequestHeader("Cookie", ck);
                ((DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE)).enqueue(r);
                Toast.makeText(this, "下載中：" + name, Toast.LENGTH_SHORT).show();
            } catch (Exception e) { Toast.makeText(this, "下載失敗：" + e.getMessage(), Toast.LENGTH_LONG).show(); }
        });
        suno.loadUrl(SUNO_HOME);
    }

    void tellSuno() {
        if (suno == null) return;
        JSONObject o = new JSONObject();
        try { o.put("url", suno.getUrl()); o.put("canBack", suno.canGoBack()); o.put("canForward", suno.canGoForward()); } catch (Exception ignored) { }
        js("window.__xkSuno&&window.__xkSuno(" + o + ")");
    }

    // ---- 網頁告訴我們 Suno 網頁要放在哪裡（CSS 像素） ----
    void sunoBounds(double x, double y, double w, double h) {
        runOnUiThread(() -> {
            if (suno == null) return;
            float d = getResources().getDisplayMetrics().density;
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(Math.max(1, (int) Math.round(w * d)), Math.max(1, (int) Math.round(h * d)));
            lp.leftMargin = (int) Math.round(x * d);
            lp.topMargin = (int) Math.round(y * d);
            suno.setLayoutParams(lp);
            if (sunoShown && w > 0 && h > 0) suno.setVisibility(View.VISIBLE);
        });
    }

    void sunoVisible(boolean v) {
        runOnUiThread(() -> {
            sunoShown = v;
            if (suno == null) return;
            suno.setVisibility(v && suno.getLayoutParams().width > 1 ? View.VISIBLE : View.GONE);
            if (v) suno.requestFocus();
        });
    }

    void sunoNav(String action, String url) {
        runOnUiThread(() -> {
            if (suno == null) return;
            if ("back".equals(action) && suno.canGoBack()) suno.goBack();
            else if ("forward".equals(action) && suno.canGoForward()) suno.goForward();
            else if ("reload".equals(action)) suno.reload();
            else if ("home".equals(action)) suno.loadUrl(SUNO_HOME);
            else if ("url".equals(action) && url != null && url.startsWith("https://")) suno.loadUrl(url);
        });
    }

    /** 在 Suno 網頁執行 JavaScript，cb 收到 JSON 編碼的結果 */
    void sunoEval(String code, android.webkit.ValueCallback<String> cb) {
        runOnUiThread(() -> { if (suno != null) suno.evaluateJavascript(code, cb); else cb.onReceiveValue("null"); });
    }

    /** 回傳 assets/web 裡的檔案 */
    WebResourceResponse serve(String path) {
        try {
            if (path == null || path.equals("/")) path = "/index.html";
            String m = mime(path);
            Map<String, String> h = new HashMap<>();
            h.put("Cache-Control", "no-store");
            InputStream in = getAssets().open("web" + Uri.decode(path));
            return new WebResourceResponse(m, m.startsWith("text") || m.endsWith("json") || m.endsWith("svg+xml") ? "utf-8" : null, 200, "OK", h, in);
        } catch (Exception e) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, null);
        }
    }

    /** 下載好的音檔（content://），支援 Range */
    WebResourceResponse media(String uri, Map<String, String> reqHeaders) {
        try {
            Uri u = Uri.parse(uri);
            if (!"content".equals(u.getScheme())) throw new Exception("bad uri");
            AssetFileDescriptor fd = getContentResolver().openAssetFileDescriptor(u, "r");
            long size = fd.getLength();
            InputStream in = fd.createInputStream();
            String mt = uri.toLowerCase().contains("wav") ? "audio/wav" : "audio/mpeg";
            Map<String, String> h = new HashMap<>();
            h.put("Accept-Ranges", "bytes");
            String range = null;
            for (Map.Entry<String, String> e : reqHeaders.entrySet()) if ("range".equalsIgnoreCase(e.getKey())) range = e.getValue();
            if (range != null && range.startsWith("bytes=") && size > 0) {
                String[] p = range.substring(6).split("-", -1);
                long start = p[0].isEmpty() ? 0 : Long.parseLong(p[0]);
                long end = p.length > 1 && !p[1].isEmpty() ? Math.min(size - 1, Long.parseLong(p[1])) : size - 1;
                long skip = start;
                while (skip > 0) { long n = in.skip(skip); if (n <= 0) break; skip -= n; }
                h.put("Content-Range", "bytes " + start + "-" + end + "/" + size);
                h.put("Content-Length", String.valueOf(end - start + 1));
                return new WebResourceResponse(mt, null, 206, "Partial Content", h, in);
            }
            if (size > 0) h.put("Content-Length", String.valueOf(size));
            return new WebResourceResponse(mt, null, 200, "OK", h, in);
        } catch (Exception e) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, null);
        }
    }

    static String mime(String p) {
        p = p.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        return "application/octet-stream";
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] res) {
        if (req == REQ_CAM && pendingCam != null) {
            if (res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED) pendingCam.grant(pendingRes);
            else { pendingCam.deny(); Toast.makeText(this, "沒有相機權限：可以到「設定 → 應用程式 → 小柯SUNO → 權限」打開", Toast.LENGTH_LONG).show(); }
            pendingCam = null;
        }
    }

    /** 返回鍵：Suno 網頁開著且能上一頁 → 上一頁；否則交給網頁一層一層關；在首頁按兩次才離開 */
    @Override
    public void onBackPressed() {
        if (sunoShown && suno != null && suno.getVisibility() == View.VISIBLE && suno.canGoBack()) { suno.goBack(); return; }
        web.evaluateJavascript("(function(){try{return !!(window.__xkBack&&window.__xkBack())}catch(e){return false}})()", v -> {
            if ("true".equals(v)) return;
            long now = System.currentTimeMillis();
            if (now - lastBack < 2000) { finish(); return; }
            lastBack = now;
            Toast.makeText(this, "再按一次返回鍵離開", Toast.LENGTH_SHORT).show();
        });
    }

    /** 在畫面網頁執行 JavaScript（給 Bridge 回傳結果用） */
    void js(final String code) {
        runOnUiThread(() -> { if (web != null) web.evaluateJavascript(code, null); });
    }

    @Override
    protected void onPause() { super.onPause(); web.onPause(); CookieManager.getInstance().flush(); }

    @Override
    protected void onResume() { super.onResume(); web.onResume(); }

    @Override
    protected void onDestroy() {
        bridge.shutdown();
        CookieManager.getInstance().flush();
        web.removeJavascriptInterface("XiaokeAndroid");
        for (WebView v : new WebView[]{ web, suno }) { v.loadUrl("about:blank"); v.destroy(); }
        web = null;
        suno = null;
        super.onDestroy();
    }
}
