import AppKit
import WebKit
import UserNotifications
import ServiceManagement

// The Mac shell is deliberately thin: the review screens are the web app that
// `dak serve` already serves. This file only adds what a browser tab cannot:
// a real window, a menu bar count, notifications, and starting the server.

struct Settings {
    let home: URL
    let port: Int
    let token: String

    static func load() -> Settings {
        let env = ProcessInfo.processInfo.environment
        let home = URL(fileURLWithPath: env["DAK_HOME"] ?? (NSHomeDirectory() + "/.dak"))
        var port = Int(env["DAK_PORT"] ?? "") ?? 7474
        if env["DAK_PORT"] == nil, let toml = try? String(contentsOf: home.appendingPathComponent("config.toml"), encoding: .utf8) {
            for line in toml.split(separator: "\n") where line.hasPrefix("port") {
                if let n = Int(line.split(separator: "=").last?.trimmingCharacters(in: .whitespaces) ?? "") { port = n }
            }
        }
        let token = (try? String(contentsOf: home.appendingPathComponent("token"), encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return Settings(home: home, port: port, token: token)
    }

    var base: URL { URL(string: "http://127.0.0.1:\(port)/")! }
}

let TOOLBAR_HEIGHT: CGFloat = 40 // the tab row along the top: traffic lights centred in it, its empty parts drag the window

final class DakWebView: WKWebView {
    var controlRects: [CGRect] = []   // page coordinates, top-left origin
    var hasToolbar = true

    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        let y = isFlipped ? p.y : bounds.height - p.y
        if hasToolbar, y < TOOLBAR_HEIGHT, !controlRects.contains(where: { $0.contains(CGPoint(x: p.x, y: y)) }) {
            if event.clickCount == 2 { window?.performZoom(nil) } else { window?.performDrag(with: event) }
            return
        }
        super.mouseDown(with: event)
    }
}

struct Summary: Decodable {
    struct Item: Decodable { let id: String; let subject: String; let from: String; let kind: String; let preview: String }
    // A background turn Dak started on a closed Claude Code session.
    struct Wake: Decodable { let id: Int; let agent: String; let thread_id: String?; let from_name: String?; let subject: String?; let status: String }
    let latest_id: Int
    let unread: Int
    let threads: [Item]
    let wakes: [Wake]?
}

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, NSWindowDelegate {
    var settings = Settings.load()
    var window: NSWindow!
    var web: DakWebView!
    var status: NSStatusItem!
    var server: Process?
    var quitting = false
    var lastSeen = -1
    var timer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            UNUserNotificationCenter.current().getNotificationSettings { st in
                // What macOS allows, written down so a missing banner can be explained, not guessed at.
                log("notifications: granted=\(granted) auth=\(st.authorizationStatus.rawValue) alert=\(st.alertSetting.rawValue) style=\(st.alertStyle.rawValue) sound=\(st.soundSetting.rawValue) error=\(error?.localizedDescription ?? "none")")
            }
        }
        buildMenu()
        buildWindow()
        buildStatusItem()
        ensureServer { [weak self] in
            guard let self else { return }
            self.settings = Settings.load() // the server writes the token on first run
            self.web.load(URLRequest(url: self.settings.base))
            self.poll()
            self.timer = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: true) { [weak self] _ in self?.poll() }
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow(nil)
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        quitting = true
        server?.terminate()
    }

    // MARK: server

    /// Use a server that is already running (an agent may have started one); otherwise start our own.
    func ensureServer(then done: @escaping () -> Void) {
        ping { [weak self] alive in
            guard let self else { return }
            if alive { return DispatchQueue.main.async(execute: done) }
            guard let bin = self.dakBinary() else {
                DispatchQueue.main.async { self.showProblem("Could not find the dak program. Set DAK_BIN, or rebuild the app with mac/build.sh.") }
                return
            }
            let p = Process()
            p.executableURL = bin
            p.arguments = ["serve", "--port", String(self.settings.port)]
            p.standardOutput = FileHandle.nullDevice
            // Its errors go to ~/.dak/server.log, so a crash says why.
            let logURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".dak/server.log")
            if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil) }
            if let fh = try? FileHandle(forWritingTo: logURL) { fh.seekToEndOfFile(); p.standardError = fh } else { p.standardError = FileHandle.nullDevice }
            // If the server dies (Bun has crashed under us), start it again and reload the window:
            // a crash costs a second, not an inbox that stops updating.
            p.terminationHandler = { [weak self] proc in
                guard let self, !self.quitting else { return }
                log("server exited (\(proc.terminationStatus)); restarting")
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                    self.server = nil
                    self.ensureServer { self.web.load(URLRequest(url: self.settings.base)) }
                }
            }
            do { try p.run() } catch {
                DispatchQueue.main.async { self.showProblem("Could not start dak: \(error.localizedDescription)") }
                return
            }
            self.server = p
            self.waitForServer(tries: 40, then: done)
        }
    }

    func waitForServer(tries: Int, then done: @escaping () -> Void) {
        ping { [weak self] alive in
            if alive { return DispatchQueue.main.async(execute: done) }
            if tries == 0 { DispatchQueue.main.async { self?.showProblem("dak serve did not start on port \(self?.settings.port ?? 0).") }; return }
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.25) { self?.waitForServer(tries: tries - 1, then: done) }
        }
    }

    func ping(_ result: @escaping (Bool) -> Void) {
        var req = URLRequest(url: settings.base)
        req.timeoutInterval = 1
        URLSession.shared.dataTask(with: req) { _, response, _ in
            result((response as? HTTPURLResponse)?.statusCode == 200)
        }.resume()
    }

    func dakBinary() -> URL? {
        let fm = FileManager.default
        if let env = ProcessInfo.processInfo.environment["DAK_BIN"], fm.isExecutableFile(atPath: env) { return URL(fileURLWithPath: env) }
        if let bundled = Bundle.main.url(forResource: "dak", withExtension: nil), fm.isExecutableFile(atPath: bundled.path) { return bundled }
        for path in ["/opt/homebrew/bin/dak", "/usr/local/bin/dak", NSHomeDirectory() + "/.local/bin/dak"] where fm.isExecutableFile(atPath: path) {
            return URL(fileURLWithPath: path)
        }
        return nil
    }

    func showProblem(_ text: String) {
        web.loadHTMLString("""
        <html><body style="font: 14px -apple-system; color: #71717a; display: grid; place-items: center; height: 90vh; text-align: center">
        <div><b style="color:#c8102e">Dak could not start</b><p>\(text)</p></div></body></html>
        """, baseURL: nil)
    }

    // MARK: polling and notifications

    func poll() {
        guard let url = URL(string: "v1/summary", relativeTo: settings.base) else { return }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(settings.token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 2
        URLSession.shared.dataTask(with: req) { [weak self] data, response, _ in
            guard let self, let data, (response as? HTTPURLResponse)?.statusCode == 200,
                  let s = try? JSONDecoder().decode(Summary.self, from: data) else { return }
            DispatchQueue.main.async { self.apply(s) }
        }.resume()
    }

    func apply(_ s: Summary) {
        status.button?.title = s.unread > 0 ? " \(s.unread)" : ""
        NSApp.dockTile.badgeLabel = s.unread > 0 ? String(s.unread) : nil
        rebuildStatusMenu(s)
        // The first poll only records where we are, so launching does not replay old mail.
        if lastSeen >= 0, s.latest_id > lastSeen, let first = s.threads.first {
            notify(first, more: s.unread - 1)
        }
        lastSeen = s.latest_id
        // Say when Dak woke a closed session, so a session working on its own is never a surprise.
        let wakes = s.wakes ?? []
        if lastWake >= 0 { for w in wakes where w.id > lastWake { notifyWake(w) } }
        lastWake = max(lastWake, wakes.map(\.id).max() ?? 0)
    }

    var lastWake = -1

    func notifyWake(_ w: Summary.Wake) {
        let content = UNMutableNotificationContent()
        content.title = "Dak woke \(w.agent.capitalized)"
        content.body = "Its session was closed, so Dak is running a turn on it for \(w.from_name?.capitalized ?? "a message")\(w.subject.map { ": \($0)" } ?? ""). Don't type into it until it finishes."
        content.sound = .default
        if let t = w.thread_id { content.userInfo = ["thread": t] }
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "dak-wake-\(w.id)", content: content, trigger: nil)) { error in
            log("wake notice \(w.id): \(error?.localizedDescription ?? "posted")")
        }
    }

    func notify(_ item: Summary.Item, more: Int) {
        let content = UNMutableNotificationContent()
        let kind = item.kind == "pr" ? "PR" : item.kind == "doc" ? "Doc" : "Note"
        content.title = "\(item.from.capitalized) · \(kind)"
        content.body = item.subject + (more > 0 ? "  (+\(more) more waiting)" : "")
        content.sound = .default
        content.userInfo = ["thread": item.id]
        let req = UNNotificationRequest(identifier: "dak-\(item.id)-\(lastSeen)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req) { error in
            log("notify \(item.id): \(error?.localizedDescription ?? "posted") active=\(NSApp.isActive)")
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
        if let thread = response.notification.request.content.userInfo["thread"] as? String { open(thread: thread) }
        done()
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        // The window shows its own toast when it is in front; the banner is for when it is not.
        done(NSApp.isActive && window.isKeyWindow ? [] : [.banner, .sound])
    }

    func open(thread: String) {
        showWindow(nil)
        let js = "location.hash = '#\(thread)'; location.reload();"
        web.evaluateJavaScript(js)
    }

    // MARK: window and menus

    func buildWindow() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.userContentController.add(self, name: "dak")
        // Tell the page it is inside the app, before its first paint, so it draws the toolbar.
        config.userContentController.addUserScript(WKUserScript(source: "document.documentElement.classList.add('native')", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = DakWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "Dak"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        // No line under the title bar: it would cut across the window under the tab row.
        window.titlebarSeparatorStyle = .none
        window.delegate = self
        window.minSize = NSSize(width: 900, height: 600)
        // A translucent material behind the page: where the page is transparent (the
        // sidebar), the desktop shows through, as in Mail and Finder.
        let material = NSVisualEffectView()
        material.material = .sidebar
        material.blendingMode = .behindWindow
        material.state = .followsWindowActiveState
        window.contentView = material
        web.translatesAutoresizingMaskIntoConstraints = false
        material.addSubview(web)
        NSLayoutConstraint.activate([
            web.leadingAnchor.constraint(equalTo: material.leadingAnchor), web.trailingAnchor.constraint(equalTo: material.trailingAnchor),
            web.topAnchor.constraint(equalTo: material.topAnchor), web.bottomAnchor.constraint(equalTo: material.bottomAnchor),
        ])
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("DakMain")
        window.center()
        window.makeKeyAndOrderFront(nil)
        placeTrafficLights()
    }

    // Centre the close, minimise and zoom buttons in the page's 52pt toolbar, as a unified toolbar would.
    func placeTrafficLights() {
        guard let close = window.standardWindowButton(.closeButton), let container = close.superview?.superview else { return }
        var frame = container.frame
        frame.size.height = TOOLBAR_HEIGHT
        frame.origin.y = window.frame.height - TOOLBAR_HEIGHT
        container.frame = frame
        for (i, kind) in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].enumerated() {
            guard let b = window.standardWindowButton(kind) else { continue }
            b.setFrameOrigin(NSPoint(x: 20 + CGFloat(i) * 20, y: (TOOLBAR_HEIGHT - b.frame.height) / 2))
        }
    }

    func windowDidResize(_ notification: Notification) { placeTrafficLights() }
    func windowDidEnterFullScreen(_ notification: Notification) { web.evaluateJavaScript("document.documentElement.classList.add('fullscreen')") }
    func windowDidExitFullScreen(_ notification: Notification) { web.evaluateJavaScript("document.documentElement.classList.remove('fullscreen')"); placeTrafficLights() }

    // The page reports where its toolbar controls are, so clicks there reach them and the rest drags.
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        if let rects = body["controls"] as? [[Double]] {
            web.controlRects = rects.compactMap { $0.count == 4 ? CGRect(x: $0[0], y: $0[1], width: $0[2], height: $0[3]) : nil }
        }
        if let n = body["unread"] as? Int { NSApp.dockTile.badgeLabel = n > 0 ? String(n) : nil }
        // Start at login: a login item for this app, through macOS's own login items list.
        if let on = body["login"] as? Bool {
            do { if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() } }
            catch { log("login item: \(error.localizedDescription)") }
            reportLogin()
        }
        if body["loginState"] != nil { reportLogin() }
    }

    // Tells Settings whether Dak starts at login, and when macOS wants the user to approve it.
    func reportLogin() {
        let s = SMAppService.mainApp.status
        let state = s == .enabled ? "on" : s == .requiresApproval ? "approve" : "off"
        web.evaluateJavaScript("window.dak && window.dak.loginState && window.dak.loginState('\(state)')")
    }

    @objc func showWindow(_ sender: Any?) {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    @objc func openThread(_ sender: NSMenuItem) {
        if let id = sender.representedObject as? String { open(thread: id) }
    }

    @objc func reload(_ sender: Any?) { web.reload() }
    @objc func openSettings(_ sender: Any?) { showWindow(nil); web.evaluateJavaScript("window.dak && window.dak.settings()") }
    @objc func newMessage(_ sender: Any?) { showWindow(nil); web.evaluateJavaScript("window.dak && window.dak.compose()") }
    @objc func closeTab(_ sender: Any?) {
        web.evaluateJavaScript("window.dak && window.dak.closeTab ? window.dak.closeTab() : false") { [weak self] result, _ in
            if (result as? Bool) != true { self?.web.window?.performClose(nil) }
        }
    }
    @objc func findInPr(_ sender: Any?) { web.evaluateJavaScript("window.dak && window.dak.find && window.dak.find()") }

    func buildStatusItem() {
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let image = NSImage(systemSymbolName: "tray.and.arrow.down", accessibilityDescription: "Dak")
        image?.isTemplate = true
        status.button?.image = image
        status.button?.imagePosition = .imageLeading
        rebuildStatusMenu(nil)
    }

    func rebuildStatusMenu(_ s: Summary?) {
        let menu = NSMenu()
        if let s, !s.threads.isEmpty {
            let header = NSMenuItem(title: "Waiting on you", action: nil, keyEquivalent: "")
            header.isEnabled = false
            menu.addItem(header)
            for t in s.threads.prefix(8) {
                let item = NSMenuItem(title: "\(t.from.capitalized): \(t.subject)", action: #selector(openThread(_:)), keyEquivalent: "")
                item.representedObject = t.id
                item.target = self
                menu.addItem(item)
            }
        } else {
            let none = NSMenuItem(title: "Nothing waiting", action: nil, keyEquivalent: "")
            none.isEnabled = false
            menu.addItem(none)
        }
        menu.addItem(.separator())
        let openItem = NSMenuItem(title: "Open Dak", action: #selector(showWindow(_:)), keyEquivalent: "o")
        openItem.target = self
        menu.addItem(openItem)
        menu.addItem(NSMenuItem(title: "Quit Dak", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        status.menu = menu
    }

    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let app = NSMenu()
        let settingsItem = NSMenuItem(title: "Settings…", action: #selector(openSettings(_:)), keyEquivalent: ",")
        settingsItem.target = self
        app.addItem(settingsItem)
        let newItem = NSMenuItem(title: "New Message", action: #selector(newMessage(_:)), keyEquivalent: "n")
        newItem.target = self
        app.addItem(newItem)
        app.addItem(.separator())
        app.addItem(withTitle: "Reload", action: #selector(reload(_:)), keyEquivalent: "r")
        app.addItem(.separator())
        app.addItem(withTitle: "Hide Dak", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "Quit Dak", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = app
        // Edit menu, so copy, paste and select-all work inside the text boxes.
        let editItem = NSMenuItem()
        main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Find in PR…", action: #selector(findInPr(_:)), keyEquivalent: "f")
        editItem.submenu = edit
        let windowItem = NSMenuItem()
        main.addItem(windowItem)
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        // ⌘W closes the topic's tab, as in a browser; with no tab open it closes the window.
        win.addItem(withTitle: "Close Tab", action: #selector(closeTab(_:)), keyEquivalent: "w")
        let closeWin = NSMenuItem(title: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "W")
        win.addItem(closeWin)
        windowItem.submenu = win
        NSApp.mainMenu = main
    }

    // Links that leave Dak (GitHub, artifacts, files) open in the normal browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.allow) }
        if url.host != "127.0.0.1", url.scheme?.hasPrefix("http") == true {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        // The window only ever shows Dak's own page. Anything else it is pointed at (a file,
        // a download) opens in the browser instead: once the window left, nothing on screen
        // could bring it back.
        if action.targetFrame?.isMainFrame != false, url.host == "127.0.0.1", url.path != "/" && !url.path.isEmpty {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()

// A small log in ~/.dak/app.log for what the app cannot show on screen (notification permission, errors).
func log(_ line: String) {
  let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".dak/app.log")
  let text = "\(ISO8601DateFormatter().string(from: Date())) \(line)\n"
  if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(text.data(using: .utf8)!); try? h.close() }
  else { try? text.data(using: .utf8)!.write(to: url) }
}
