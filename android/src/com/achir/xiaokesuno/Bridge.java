package com.achir.xiaokesuno;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.util.Base64;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebStorage;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 網頁呼叫的 Android 功能（window.XiaokeAndroid）。
 * 非同步的工作一律用 call(id, 方法, 參數 JSON)：在背景執行緒做完後呼叫網頁的 window.__xkRes(id, ok, 結果)。
 * Suno 登入：長效的 __client cookie（auth.suno.com）放在 CookieManager，需要時向 Suno 的登入服務（Clerk）換短效權杖。
 */
final class Bridge {
    static final String REPO = "achir1015/xiaoke-suno";
    static final String FOLDER = "小柯SUNO";
    static final String CLERK = "https://auth.suno.com";
    static final String CLERK_V = "5.117.0";
    static final String UA = "Mozilla/5.0 (Linux; Android " + Build.VERSION.RELEASE + ") AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";

    final MainActivity a;
    final ExecutorService pool = Executors.newFixedThreadPool(4);
    volatile JSONObject updateStatus = st("idle", 0);
    volatile String jwt = null;
    volatile long jwtExp = 0;
    TextToSpeech tts;
    volatile boolean ttsReady = false;
    volatile String ttsVoiceName = "";

    Bridge(MainActivity a) {
        this.a = a;
        initTts();
    }

    static JSONObject st(String state, int pct) {
        JSONObject o = new JSONObject();
        try { o.put("state", state); o.put("pct", pct); } catch (Exception ignored) { }
        return o;
    }
    static String ok(Object... kv) {
        JSONObject o = new JSONObject();
        try { o.put("status", "ok"); for (int i = 0; i + 1 < kv.length; i += 2) o.put((String) kv[i], kv[i + 1]); } catch (Exception ignored) { }
        return o.toString();
    }
    static String err(Exception e) {
        JSONObject o = new JSONObject();
        try { o.put("status", "error"); o.put("message", String.valueOf(e.getMessage())); } catch (Exception ignored) { }
        return o.toString();
    }
    static String version(Context c) {
        try { return c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionName; } catch (Exception e) { return "0"; }
    }

    @JavascriptInterface
    public String appInfo() { return ok("name", a.getString(R.string.app_name), "version", version(a), "platform", "android", "sdk", Build.VERSION.SDK_INT, "model", Build.MODEL); }

    // ================= 非同步呼叫 =================
    interface Job { Object run(JSONArray args) throws Exception; }

    @JavascriptInterface
    public void call(final String id, final String method, final String argsJson) {
        pool.execute(() -> {
            try {
                JSONArray args = new JSONArray(argsJson == null ? "[]" : argsJson);
                Object r = dispatch(method, args);
                a.js("window.__xkRes(" + JSONObject.quote(id) + ",true," + toJs(r) + ")");
            } catch (Exception e) {
                a.js("window.__xkRes(" + JSONObject.quote(id) + ",false," + JSONObject.quote(String.valueOf(e.getMessage())) + ")");
            }
        });
    }

    static String toJs(Object r) {
        if (r == null) return "null";
        if (r instanceof JSONObject || r instanceof JSONArray || r instanceof Boolean || r instanceof Number) return r.toString();
        return JSONObject.quote(r.toString());
    }

    Object dispatch(String m, JSONArray a1) throws Exception {
        switch (m) {
            case "suno": return suno(a1.getString(0), a1.getString(1), a1.optString(2, ""));
            case "sunoLogin": { JSONObject o = new JSONObject(); o.put("loggedIn", token() != null); return o; }
            case "importLogin": return importLogin(new JSONArray(a1.getString(0)));
            case "logout": return logout();
            case "download": return download(a1.getString(0), a1.getString(1), a1.getString(2), a1.getString(3));
            case "writeText": return writeBytes(a1.getString(0), a1.getString(1).getBytes("UTF-8"), a1.optString(2, "text/plain"));
            case "listFiles": return listFiles();
            case "exists": return exists(a1.getString(0));
            case "readText": return new String(read(a1.getString(0)), "UTF-8");
            case "readB64": return Base64.encodeToString(read(a1.getString(0)), Base64.NO_WRAP);
            case "sunoEval": return sunoEval(a1.getString(0));
            case "notify": { final String t = a1.optString(0); a.runOnUiThread(() -> Toast.makeText(a, t, Toast.LENGTH_LONG).show()); return true; }
            default: throw new Exception("沒有這個功能：" + m);
        }
    }

    // ================= Suno 登入與連線 =================
    static long jwtExpOf(String t) {
        try {
            String p = t.split("\\.")[1];
            JSONObject o = new JSONObject(new String(Base64.decode(p, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING), "UTF-8"));
            return o.optLong("exp", 0);
        } catch (Exception e) { return 0; }
    }

    static final class Resp { int status; String text = ""; String retry; Map<String, List<String>> headers; }

    static Resp http(String method, String url, String body, Map<String, String> headers) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setRequestProperty("User-Agent", UA);
        c.setRequestProperty("Accept", "application/json, text/plain, */*");
        for (Map.Entry<String, String> e : headers.entrySet()) c.setRequestProperty(e.getKey(), e.getValue());
        if (body != null && !body.isEmpty()) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            try (OutputStream o = c.getOutputStream()) { o.write(body.getBytes("UTF-8")); }
        } else if ("POST".equals(method)) {
            c.setDoOutput(true);
            c.setFixedLengthStreamingMode(0);
        }
        Resp r = new Resp();
        try {
            r.status = c.getResponseCode();
            r.retry = c.getHeaderField("Retry-After");
            r.headers = c.getHeaderFields();
            InputStream in = r.status >= 400 ? c.getErrorStream() : c.getInputStream();
            if (in != null) r.text = new String(readAll(in), "UTF-8");
        } finally { c.disconnect(); }
        return r;
    }

    /** Clerk 回應裡更新的 cookie（例如 __client）存回 CookieManager */
    static void keepCookies(Resp r, String url) {
        if (r.headers == null) return;
        CookieManager cm = CookieManager.getInstance();
        for (Map.Entry<String, List<String>> e : r.headers.entrySet()) {
            if (e.getKey() == null || !"set-cookie".equalsIgnoreCase(e.getKey())) continue;
            for (String v : e.getValue()) cm.setCookie(url, v);
        }
        cm.flush();
    }

    /** 目前可用的 Suno 權杖；沒有登入回傳 null */
    synchronized String token() throws Exception {
        long now = System.currentTimeMillis() / 1000;
        if (jwt != null && jwtExp - 60 > now) return jwt;
        String ck = CookieManager.getInstance().getCookie(CLERK);
        if (ck == null || !ck.contains("__client=")) { jwt = null; return null; }
        Map<String, String> h = new java.util.HashMap<>();
        h.put("Cookie", ck);
        h.put("Origin", "https://suno.com");
        Resp r1 = http("GET", CLERK + "/v1/client?_clerk_js_version=" + CLERK_V, null, h);
        keepCookies(r1, CLERK);
        if (r1.status != 200) { jwt = null; return null; }
        JSONObject resp = new JSONObject(r1.text).optJSONObject("response");
        String sid = resp == null ? "" : resp.optString("last_active_session_id", "");
        if (sid.isEmpty() && resp != null && resp.optJSONArray("sessions") != null && resp.getJSONArray("sessions").length() > 0) sid = resp.getJSONArray("sessions").getJSONObject(0).optString("id");
        if (sid.isEmpty()) { jwt = null; return null; }
        h.put("Cookie", CookieManager.getInstance().getCookie(CLERK));
        Resp r2 = http("POST", CLERK + "/v1/client/sessions/" + sid + "/tokens?_clerk_js_version=" + CLERK_V, null, h);
        keepCookies(r2, CLERK);
        if (r2.status != 200) { jwt = null; return null; }
        String t = new JSONObject(r2.text).optString("jwt", "");
        if (t.isEmpty()) { jwt = null; return null; }
        jwt = t;
        jwtExp = jwtExpOf(t);
        return jwt;
    }

    /** 帶權杖呼叫 Suno；沒有登入時 status = -1 */
    JSONObject suno(String method, String url, String body) throws Exception {
        if (!(url.startsWith("https://studio-api-prod.suno.com/") || url.startsWith("https://suno.com/a/api/"))) throw new Exception("不允許的網址");
        JSONObject o = new JSONObject();
        String t = token();
        if (t == null) { o.put("status", -1); return o; }
        Map<String, String> h = new java.util.HashMap<>();
        h.put("Authorization", "Bearer " + t);
        Resp r = http(method, url, body, h);
        if (r.status == 401 || r.status == 403) jwt = null;
        o.put("status", r.status);
        o.put("text", r.text);
        o.put("retry", r.retry == null ? "" : r.retry);
        return o;
    }

    /** 從電腦帶來的登入 cookie：[[名稱, 值, 網域, 到期秒數]] */
    Object importLogin(JSONArray list) throws Exception {
        CookieManager cm = CookieManager.getInstance();
        long now = System.currentTimeMillis() / 1000;
        int n = 0;
        for (int i = 0; i < list.length(); i++) {
            JSONArray c = list.getJSONArray(i);
            String name = c.getString(0), value = c.getString(1), domain = c.getString(2);
            long exp = c.optLong(3, 0);
            if (!name.startsWith("__client") || !domain.replaceFirst("^\\.", "").endsWith("suno.com")) continue;
            long age = exp > now ? exp - now : 31536000;
            String host = domain.replaceFirst("^\\.", "");
            String v = name + "=" + value + "; Path=/; Secure; SameSite=Lax; Max-Age=" + age + (domain.startsWith(".") ? "; Domain=" + domain : "");
            cm.setCookie("https://" + host, v);
            n++;
        }
        cm.flush();
        jwt = null;
        if (n == 0) throw new Exception("QR Code 裡沒有 Suno 登入資料");
        a.sunoNav("reload", "");
        JSONObject o = new JSONObject();
        o.put("count", n);
        return o;
    }

    Object logout() {
        CookieManager cm = CookieManager.getInstance();
        cm.removeAllCookies(null);
        cm.flush();
        WebStorage.getInstance().deleteAllData();
        jwt = null;
        a.sunoNav("home", "");
        return true;
    }

    /** 在 Suno 網頁執行會回傳 Promise 的程式：結果先放在 window.__xkR，再輪詢讀回來 */
    String sunoEval(String code) throws Exception {
        final String[] box = { null };
        final Object lock = new Object();
        String start = "(function(){window.__xkR=undefined;Promise.resolve(" + code + ").then(function(v){window.__xkR=String(v)},function(e){window.__xkR='__ERR__'+e})})();";
        a.sunoEval(start, v -> { });
        long until = System.currentTimeMillis() + 180000;
        while (System.currentTimeMillis() < until) {
            Thread.sleep(500);
            a.sunoEval("window.__xkR===undefined?null:window.__xkR", v -> { synchronized (lock) { box[0] = v; lock.notifyAll(); } });
            synchronized (lock) { lock.wait(3000); }
            String v = box[0];
            box[0] = null;
            if (v != null && !"null".equals(v)) {
                String s = (String) new JSONTokener(v).nextValue();
                if (s.startsWith("__ERR__")) throw new Exception(s.substring(7));
                return s;
            }
        }
        throw new Exception("Suno 網頁沒有回應");
    }

    // ================= 存檔：「下載/小柯SUNO」 =================
    static String clean(String name) { return name.replaceAll("[\\\\/:*?\"<>|]", "_").trim(); }

    /** 同名的舊檔（本 App 存的）先刪掉，同一首歌重新下載時檔名才不會變成 (1) */
    void removeSame(String name) {
        if (Build.VERSION.SDK_INT < 29) { new File(new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), FOLDER), name).delete(); return; }
        try {
            a.getContentResolver().delete(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    MediaStore.MediaColumns.DISPLAY_NAME + "=? AND " + MediaStore.MediaColumns.RELATIVE_PATH + "=?",
                    new String[]{ name, Environment.DIRECTORY_DOWNLOADS + "/" + FOLDER + "/" });
        } catch (Exception ignored) { }
    }

    static final class Out { Uri uri; File file; OutputStream out; String shown; }

    Out open(String name, String mime) throws Exception {
        name = clean(name);
        removeSame(name);
        Out o = new Out();
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + FOLDER);
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            o.uri = a.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (o.uri == null) throw new Exception("無法建立檔案");
            o.out = a.getContentResolver().openOutputStream(o.uri);
        } else {
            File d = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), FOLDER);
            d.mkdirs();
            o.file = new File(d, name);
            o.out = new FileOutputStream(o.file);
            o.uri = Uri.fromFile(o.file);
        }
        o.shown = "下載/" + FOLDER + "/" + name;
        return o;
    }

    JSONObject close(Out o) throws Exception {
        o.out.close();
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.IS_PENDING, 0);
            a.getContentResolver().update(o.uri, v, null, null);
        }
        JSONObject r = new JSONObject();
        r.put("uri", o.uri.toString());
        r.put("path", o.shown);
        return r;
    }

    void abort(Out o) {
        try { o.out.close(); } catch (Exception ignored) { }
        try { if (o.uri != null && Build.VERSION.SDK_INT >= 29) a.getContentResolver().delete(o.uri, null, null); else if (o.file != null) o.file.delete(); } catch (Exception ignored) { }
    }

    JSONObject writeBytes(String name, byte[] data, String mime) throws Exception {
        Out o = open(name, mime);
        try { o.out.write(data); } catch (Exception e) { abort(o); throw e; }
        return close(o);
    }

    /** 下載網址到檔案（Suno 官方下載的有時效網址、封面）；進度用 window.__xkDl(key, 已下載, 總大小) */
    JSONObject download(String url, String name, String mime, String key) throws Exception {
        if (!url.startsWith("https://")) throw new Exception("不允許的網址");
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(60000);
        c.setRequestProperty("User-Agent", UA);
        int code = c.getResponseCode();
        if (code >= 400) { c.disconnect(); throw new Exception("下載失敗（" + code + "）"); }
        long total = c.getContentLengthLong();
        Out o = open(name, mime);
        long got = 0, last = 0;
        try (InputStream in = c.getInputStream()) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) {
                o.out.write(buf, 0, n);
                got += n;
                long now = System.currentTimeMillis();
                if (now - last > 300) { last = now; a.js("window.__xkDl&&window.__xkDl(" + JSONObject.quote(key) + "," + got + "," + total + ")"); }
            }
        } catch (Exception e) { abort(o); c.disconnect(); throw e; }
        c.disconnect();
        if (got < 1000 || (total > 0 && got < total)) { abort(o); throw new Exception("檔案內容不完整"); }
        return close(o);
    }

    JSONArray listFiles() {
        JSONArray out = new JSONArray();
        if (Build.VERSION.SDK_INT < 29) {
            String[] f = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), FOLDER).list();
            if (f != null) for (String s : f) out.put(s);
            return out;
        }
        try (Cursor cur = a.getContentResolver().query(MediaStore.Downloads.EXTERNAL_CONTENT_URI, new String[]{ MediaStore.MediaColumns.DISPLAY_NAME },
                MediaStore.MediaColumns.RELATIVE_PATH + "=?", new String[]{ Environment.DIRECTORY_DOWNLOADS + "/" + FOLDER + "/" }, null)) {
            while (cur != null && cur.moveToNext()) out.put(cur.getString(0));
        } catch (Exception ignored) { }
        return out;
    }

    boolean exists(String uri) {
        try {
            Uri u = Uri.parse(uri);
            if ("file".equals(u.getScheme())) return new File(u.getPath()).exists();
            try (Cursor c = a.getContentResolver().query(u, new String[]{ MediaStore.MediaColumns.SIZE }, null, null, null)) { return c != null && c.moveToFirst() && c.getLong(0) > 0; }
        } catch (Exception e) { return false; }
    }

    byte[] read(String uri) throws Exception {
        Uri u = Uri.parse(uri);
        ContentResolver cr = a.getContentResolver();
        try (InputStream in = cr.openInputStream(u)) { return readAll(in); }
    }

    static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        return bo.toByteArray();
    }

    // ================= Suno 網頁的位置與操作（同步） =================
    @JavascriptInterface public void sunoBounds(double x, double y, double w, double h) { a.sunoBounds(x, y, w, h); }
    @JavascriptInterface public void sunoVisible(boolean v) { a.sunoVisible(v); }
    @JavascriptInterface public void sunoNav(String action, String url) { a.sunoNav(action, url); }

    /** 只允許開啟本專案、Suno、OpenAI 金鑰頁面的網址 */
    @JavascriptInterface
    public boolean openUrl(String url) {
        if (!(url.startsWith("https://github.com/achir1015/") || url.startsWith("https://achir1015.github.io/") || url.startsWith("https://platform.openai.com/") || url.startsWith("https://suno.com/"))) return false;
        try { a.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); return true; } catch (Exception e) { return false; }
    }

    // ================= 語音說明：系統的文字轉語音 =================
    void initTts() {
        tts = new TextToSpeech(a.getApplicationContext(), status -> {
            if (status != TextToSpeech.SUCCESS) return;
            Locale[] prefer = { Locale.TAIWAN, new Locale("zh", "TW"), Locale.TRADITIONAL_CHINESE, new Locale("yue", "HK"), Locale.CHINESE, Locale.SIMPLIFIED_CHINESE };
            for (Locale l : prefer) {
                if (tts.isLanguageAvailable(l) >= TextToSpeech.LANG_AVAILABLE) { tts.setLanguage(l); ttsReady = true; break; }
            }
            try { Voice v = tts.getVoice(); if (v != null) ttsVoiceName = v.getName() + "（" + v.getLocale().toLanguageTag() + "）"; } catch (Exception ignored) { }
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) { }
                @Override public void onDone(String id) { done(id); }
                @Override public void onError(String id) { done(id); }
                @Override public void onStop(String id, boolean interrupted) { done(id); }
            });
        });
    }
    void done(String id) { a.js("window.__xkTtsDone&&window.__xkTtsDone(" + JSONObject.quote(id) + ")"); }
    @JavascriptInterface public boolean ttsAvailable() { return ttsReady; }
    @JavascriptInterface public String ttsVoice() { return ttsVoiceName.isEmpty() ? "手機語音" : ttsVoiceName; }
    @JavascriptInterface
    public void ttsSpeak(String text, double rate, String id) {
        if (!ttsReady) { done(id); return; }
        tts.setSpeechRate((float) Math.max(0.5, Math.min(2.0, rate)));
        Bundle p = new Bundle();
        p.putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, id);
        tts.speak(text, TextToSpeech.QUEUE_FLUSH, p, id);
    }
    @JavascriptInterface public void ttsStop() { if (tts != null) tts.stop(); }

    void shutdown() {
        pool.shutdownNow();
        try { if (tts != null) { tts.stop(); tts.shutdown(); } } catch (Exception ignored) { }
    }

    // ================= 版本更新：GitHub Releases 最新版的 .apk =================
    static String get(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(10000);
        c.setReadTimeout(15000);
        c.setRequestProperty("Accept", "application/vnd.github+json");
        c.setRequestProperty("User-Agent", "XiaokeSuno-Android");
        try (InputStream in = c.getInputStream()) { return new String(readAll(in), "UTF-8"); } finally { c.disconnect(); }
    }

    static String latestTag() throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL("https://github.com/" + REPO + "/releases/latest").openConnection();
        c.setInstanceFollowRedirects(false);
        c.setConnectTimeout(10000);
        c.setRequestProperty("User-Agent", "XiaokeSuno-Android");
        try {
            String loc = c.getHeaderField("Location");
            if (loc == null || !loc.contains("/releases/tag/")) throw new Exception("查詢失敗（" + c.getResponseCode() + "）");
            return loc.substring(loc.lastIndexOf('/') + 1);
        } finally { c.disconnect(); }
    }

    @JavascriptInterface
    public String checkUpdate() {
        try {
            String tag, apk = "", page, notes = "";
            try {
                JSONObject o = new JSONObject(get("https://api.github.com/repos/" + REPO + "/releases/latest"));
                tag = o.optString("tag_name");
                page = o.optString("html_url");
                notes = o.optString("body", "");
                JSONArray as = o.optJSONArray("assets");
                for (int i = 0; as != null && i < as.length(); i++) {
                    JSONObject x = as.getJSONObject(i);
                    if (x.optString("name").toLowerCase().endsWith(".apk")) apk = x.getString("browser_download_url");
                }
            } catch (Exception e) {
                tag = latestTag();
                String ver = tag.replaceAll("^[vV]", "");
                page = "https://github.com/" + REPO + "/releases/tag/" + tag;
                apk = "https://github.com/" + REPO + "/releases/download/" + tag + "/XiaokeSuno-" + ver + "-android.apk";
            }
            return ok("current", version(a), "latest", tag.replaceAll("^[vV]", ""), "url", apk, "page", page, "notes", notes);
        } catch (Exception e) { return err(e); }
    }

    @JavascriptInterface
    public String updateStatus() { return updateStatus.toString(); }

    @JavascriptInterface
    public String installUpdate(final String url, final String ver) {
        if (!url.startsWith("https://github.com/" + REPO + "/releases/download/")) return err(new Exception("bad url"));
        if (!a.getPackageManager().canRequestPackageInstalls()) {
            a.runOnUiThread(() -> {
                try { a.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + a.getPackageName()))); } catch (Exception ignored) { }
            });
            updateStatus = st("permission", 0);
            return ok();
        }
        final DownloadManager dm = (DownloadManager) a.getSystemService(Context.DOWNLOAD_SERVICE);
        String file = "XiaokeSuno-" + ver + ".apk";
        File old = new File(a.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), file);
        if (old.exists()) old.delete();
        DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url))
                .setTitle(a.getString(R.string.app_name) + " v" + ver)
                .setMimeType("application/vnd.android.package-archive")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalFilesDir(a, Environment.DIRECTORY_DOWNLOADS, file);
        final long id = dm.enqueue(req);
        updateStatus = st("downloading", 0);
        final Context app = a.getApplicationContext();
        BroadcastReceiver done = new BroadcastReceiver() {
            public void onReceive(Context c, Intent i) {
                if (i.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1) != id) return;
                try { app.unregisterReceiver(this); } catch (Exception ignored) { }
                Uri uri = dm.getUriForDownloadedFile(id);
                if (uri == null) { updateStatus = st("error", 0); return; }
                updateStatus = st("launching", 100);
                Intent v = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                try { app.startActivity(v); } catch (Exception e) { updateStatus = st("error", 0); }
            }
        };
        IntentFilter f = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(done, f, Context.RECEIVER_EXPORTED);
        else app.registerReceiver(done, f);
        new Thread(() -> {
            while ("downloading".equals(updateStatus.optString("state"))) {
                try (Cursor cur = dm.query(new DownloadManager.Query().setFilterById(id))) {
                    if (cur != null && cur.moveToFirst()) {
                        long got = cur.getLong(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                        long all = cur.getLong(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                        int s = cur.getInt(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                        if (s == DownloadManager.STATUS_FAILED) { updateStatus = st("error", 0); break; }
                        if (all > 0) updateStatus = st("downloading", (int) (got * 100 / all));
                    }
                } catch (Exception ignored) { }
                try { Thread.sleep(500); } catch (InterruptedException e) { break; }
            }
        }).start();
        return ok();
    }
}
