// The native side: a small transparent window that only catches the mouse over the character, a tray menu and a settings
// window. Everything else lives in the pages (src/); they reach this file only through preload.ts.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { connect as xConnect } from "node:net";
import { setLang, t, type Lang } from "../src/i18n.ts";
import { BrowserWindow, Menu, Notification, Tray, app, desktopCapturer, dialog, globalShortcut, ipcMain, nativeImage, net, powerMonitor, protocol, screen, shell } from "electron";

const PET_SIZE = 300, CURSOR_MS = 50, ON_TOP_MS = 2_000;
const DIST = join(app.getAppPath(), "dist");
const LINKS = /^https:\/\/(www\.flyaiworld\.com|flyai-mine\.fly\.dev)\/|^https:\/\/x\.com\/intent\/|^https:\/\/dexscreener\.com\//;
const IDLE_S = 120, COMPUTE_MS = 5000;

let pet: BrowserWindow, settings: BrowserWindow | null = null, panel: BrowserWindow | null = null, tray: Tray;   // kept here so they aren't garbage collected
let hidden = false, quiet = false, coachOn = false;
// updates (2026-11-16, the user: "a function to update the app or show there is an update"): the newest GitHub release
// (tag flypet-v<x.y.z>) against this app's version, at start and every UPDATE_MS. A newer one: a notice from the fly, one
// system notification per version, and "Update to v..." at the top of its menu, which opens the download (the Microsoft
// Store's own page for the Store version, which updates itself)
const RELEASES = "https://api.github.com/repos/alextitonis/fly.ai/releases/latest";
const UPDATE_PAGE = "https://www.flyaiworld.com/flypet", STORE_PAGE = "ms-windows-store://pdp/?productid=9MZXQ4T6R3FC";
const UPDATE_MS = 6 * 3_600_000;
let update: string | null = null;
const parts = (v: string) => v.split(".").map((n) => Number(n) || 0);
export function newerVersion(a: string, b: string): boolean {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}
async function checkUpdate() {
  try {
    const r = await net.fetch(RELEASES, { headers: { "User-Agent": "FlyPet", Accept: "application/vnd.github+json" } });
    if (!r.ok) return;
    const v = String(((await r.json()) as { tag_name?: string }).tag_name ?? "").replace(/^flypet-v/, "");
    if (!/^\d+\.\d+\.\d+$/.test(v) || !newerVersion(v, app.getVersion()) || update === v) return;
    update = v;
    tray?.setContextMenu(menu());
    pet?.webContents.send("update", v);
    if (Notification.isSupported()) new Notification({ title: "Fly Pet", body: t("updateReady", { v }) }).show();
  } catch { /* offline: the next check */ }
}
function getUpdate() { void shell.openExternal(process.windowsStore ? STORE_PAGE : UPDATE_PAGE); }
const COACH_KEY = "Alt+Shift+C";   // the coach's hotkey (one hint); not Ctrl+Alt, which is AltGr on Turkish and Spanish keyboards
interface ComputeState { phase: "off" | "waiting" | "loading" | "running" | "error"; jobs: number; perMinute: number; engine: string }

// the pages load from app:// rather than file://, which can't fetch avatar.json or read a GIF's pixels
protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

function serveApp() {
  protocol.handle("app", (req) => {
    const file = normalize(join(DIST, decodeURIComponent(new URL(req.url).pathname)));
    if (!file.startsWith(DIST + sep)) return new Response(null, { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

function lockDown(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
}

const webPreferences = { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true };

function createPet() {
  pet = new BrowserWindow({
    width: PET_SIZE, height: PET_SIZE, title: "Fly Pet", transparent: true, frame: false, hasShadow: false, resizable: false, maximizable: false,
    fullscreenable: false, alwaysOnTop: true, skipTaskbar: true, focusable: false, show: false, webPreferences,
  });
  // always on top (2026-11-13, the user: Alt+Tab dropped it behind other windows): the highest level, put back whenever it
  // loses the focus (its chat takes the keyboard) and every ON_TOP_MS
  keepOnTop();
  pet.on("blur", () => setTimeout(keepOnTop, 50));
  pet.on("hide", () => setTimeout(keepOnTop, 50));
  pet.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  lockDown(pet);
  pet.once("ready-to-show", () => pet.showInactive());
  void pet.loadURL("app://fly/index.html");
}

function keepOnTop() {
  if (!pet || pet.isDestroyed() || !pet.isVisible()) return;
  pet.setAlwaysOnTop(true, "screen-saver");
  pet.moveTop();
}

// made when asked for and gone when closed: a second page held open all day costs about 70 MB. The pet keeps running.
function showSettings(section = "") {
  if (settings) {
    settings.show();
    settings.focus();
    if (section === "share") settings.webContents.send("share");
    return;
  }
  settings = new BrowserWindow({ width: 420, height: 660, title: "Fly Pet Settings", icon: join(DIST, "tray.png"), resizable: false, autoHideMenuBar: true, backgroundColor: "#0b0b0b", webPreferences });
  settings.setMenu(null);
  lockDown(settings);
  settings.on("closed", () => { settings = null; });
  void settings.loadURL(`app://fly/settings.html${section ? `#${section}` : ""}`);
}

// the pet's own window (2026-11-13): sign in, pick the fly, then its log, a chat and the alpha calls (src/panel.ts). Made when
// asked for, gone when closed, like settings
function showPanel(what = "") {
  if (panel) {
    panel.show();
    panel.focus();
    panel.webContents.send("panel", what);
    return;
  }
  panel = new BrowserWindow({ width: 440, height: 680, minWidth: 360, minHeight: 480, title: "Fly Pet", icon: join(DIST, "tray.png"), autoHideMenuBar: true, backgroundColor: "#0b0b0b", webPreferences });
  panel.setMenu(null);
  lockDown(panel);
  panel.on("closed", () => { panel = null; });
  if (!app.isPackaged) panel.webContents.openDevTools({ mode: "detach" });   // npm start: the console, for testing
  void panel.loadURL(`app://fly/panel.html${what ? `#${what}` : ""}`);
}

// the same menu from the tray and from right-clicking the fly: Windows 11 tucks a new tray icon away under its ^ arrow
function menu() {
  return Menu.buildFromTemplate([
    ...(update ? [{ label: t("menu.update", { v: update }), click: getUpdate }, { type: "separator" as const }] : []),
    { label: t("menu.open"), click: () => pet.webContents.send("open", "") },
    { label: t("menu.alpha"), click: () => pet.webContents.send("open", "alpha") },
    { label: t("menu.exp"), click: () => pet.webContents.send("open", "exp") },
    { type: "separator" },
    { label: t("menu.coach"), type: "checkbox", checked: coachOn, click: () => pet.webContents.send("coach", "toggle") },
    { label: t("menu.coachAsk"), accelerator: COACH_KEY, registerAccelerator: false, click: () => pet.webContents.send("coach", "hint") },
    { label: t("menu.coachPick"), click: () => showPanel("coach") },
    { type: "separator" },
    { label: t("menu.feed"), click: () => pet.webContents.send("feed") },
    { label: t("menu.hide"), type: "checkbox", checked: hidden, click: (item) => setHidden(item.checked) },
    { label: t("menu.quiet"), type: "checkbox", checked: quiet, click: (item) => setQuiet(item.checked) },
    { type: "separator" },
    { label: t("menu.share"), click: () => showSettings("share") },
    { label: t("menu.settings"), click: () => showSettings() },
    { label: t("menu.close"), click: () => app.quit() },
  ]);
}
function setHidden(on: boolean) {
  hidden = on;
  if (on) pet.hide(); else pet.showInactive();
  tray.setContextMenu(menu());
}
function setQuiet(on: boolean) {
  quiet = on;
  pet.webContents.send("quiet", on);
  tray.setContextMenu(menu());
}
function createTray() {
  tray = new Tray(join(DIST, "tray.png"));
  tray.setToolTip("Fly Pet");
  tray.setContextMenu(menu());
  tray.on("click", () => pet.webContents.send("open", ""));
}

/**
 * A transparent window still catches clicks, and on Linux a window that ignores clicks gets no mouse moves at all. So
 * the cursor is read here on every system, and the page answers with set-ignore for what's under it.
 */
function watchCursor() {
  setInterval(() => {
    if (pet.isDestroyed() || !pet.isVisible()) return;
    const c = screen.getCursorScreenPoint(), b = pet.getBounds();
    const x = c.x - b.x, y = c.y - b.y;
    pet.webContents.send("cursor", { x, y, inside: x >= 0 && y >= 0 && x < b.width && y < b.height });
  }, CURSOR_MS);
  setInterval(keepOnTop, ON_TOP_MS);                 // Windows can drop it
}

/**
 * Mining runs in its own hidden window, only while it's on and allowed: closing that window is the whole of stopping it, so
 * nothing runs or holds memory otherwise. Never on battery; without "any time", only after IDLE_S with no mouse or keyboard.
 */
let mineOn = false, mineAnyTime = false, miner: BrowserWindow | null = null;
let computeState: ComputeState = { phase: "off", jobs: 0, perMinute: 0, engine: "" };
function setComputeState(s: ComputeState) {
  computeState = s;
  settings?.webContents.send("compute-state", s);
}
function computeTick() {
  const allowed = mineOn && !powerMonitor.isOnBatteryPower() && (mineAnyTime || powerMonitor.getSystemIdleTime() >= IDLE_S);
  if (allowed && !miner) {
    miner = new BrowserWindow({ show: false, title: "Fly Pet mining", webPreferences: { ...webPreferences, backgroundThrottling: false } });
    lockDown(miner);
    miner.on("closed", () => {
      miner = null;
      setComputeState({ phase: mineOn ? "waiting" : "off", jobs: 0, perMinute: 0, engine: "" });
    });
    setComputeState({ phase: "loading", jobs: 0, perMinute: 0, engine: "" });
    void miner.loadURL("app://fly/miner.html");
  } else if (!allowed && miner) {
    miner.close();                             // its page gives its unfinished jobs back as it goes
  } else if (!allowed) {
    const phase = mineOn ? "waiting" : "off";
    if (computeState.phase !== phase) setComputeState({ phase, jobs: 0, perMinute: 0, engine: "" });
  }
}

function handleCalls() {
  ipcMain.on("compute", (_e, on: boolean, anyTime: boolean) => {
    mineOn = !!on;
    mineAnyTime = !!anyTime;
    computeTick();
  });
  ipcMain.handle("compute-state", () => computeState);
  ipcMain.on("compute-report", (e, s: Omit<ComputeState, "phase"> & { phase: "loading" | "running" | "error" }) => {
    if (miner && e.sender === miner.webContents) setComputeState(s);
  });
  ipcMain.handle("save-image", async (_e, dataUrl: string) => {
    const { canceled, filePath } = await dialog.showSaveDialog({ defaultPath: "fly-pet.png", filters: [{ name: "PNG", extensions: ["png"] }] });
    if (!canceled && filePath) await writeFile(filePath, nativeImage.createFromDataURL(dataUrl).toPNG());
  });
  ipcMain.on("place", (_e, x: number, y: number) => {
    // bounds, not position: setPosition can grow a window that crosses screens with different scaling
    pet.setBounds({ x: Math.round(x), y: Math.round(y), width: PET_SIZE, height: PET_SIZE });
  });
  // the fly's own chat (2026-11-13, the user: "the chat etc to be on itself not a separate thing/tab"): the window grows
  // around the fly for the chat panel, and takes the keyboard while it's open
  ipcMain.on("frame", (_e, x: number, y: number, w: number, h: number) => {
    pet.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(Math.max(PET_SIZE, Math.min(w, 600))), height: Math.round(Math.max(PET_SIZE, Math.min(h, 1000))) });
  });
  ipcMain.on("pet-focus", (_e, on: boolean) => {
    pet.setFocusable(!!on);
    if (on) pet.focus(); else pet.blur();
    keepOnTop();
  });
  ipcMain.on("menu", () => menu().popup({ window: pet }));
  ipcMain.on("panel", (_e, what: string) => showPanel(typeof what === "string" ? what : ""));
  ipcMain.on("panel-close", () => { panel?.close(); pet.webContents.send("open", ""); });   // picked: the chat opens on the fly
  ipcMain.on("quit", () => app.quit());
  ipcMain.on("perch", (_e, on: boolean) => perchWatch(!!on));
  // whether the settings row can turn it on at all: true where the watcher works, "wayland" for the row's note, false to
  // hide the row (anything else)
  ipcMain.handle("perch-able", () =>
    process.platform === "win32" || process.platform === "darwin" ? true : process.platform === "linux" ? perchLinuxAble() : false);
  // ---- the game coach (flytrade/COACH-PLAN.md): the pet only looks; it never sends input to a game ----------------
  // the open windows to pick the game from, with small thumbnails: only while the picker is open, never in a loop
  ipcMain.handle("coach-sources", async () => {
    const own = new Set(BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId()));
    const list = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 240, height: 135 }, fetchWindowIcons: false });
    return list.filter((s) => !own.has(s.id) && s.name && !s.thumbnail.isEmpty())
      .map((s) => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() }));
  });
  // the picked window's process name, as Task Manager shows it (Windows: tasklist, once per pick) - the coach matches its
  // tuned games on it. Elsewhere none: the server goes by the window title
  ipcMain.handle("coach-process", (_e, title: string) => new Promise<string | null>((resolve) => {
    if (process.platform !== "win32" || typeof title !== "string" || !title) return resolve(null);
    execFile("tasklist", ["/v", "/fo", "csv", "/nh", "/fi", `WINDOWTITLE eq ${title.replace(/"/g, "")}`], { timeout: 8000, windowsHide: true },
      (err, out) => resolve(err ? null : (/^"([^"]+\.exe)"/im.exec(out)?.[1] ?? null)));
  }));
  // finding the game by itself (2026-11-14, the user: "shouldn't it automatically select?"): the capturable windows with
  // their program name and install folder - one PowerShell call when Coach mode starts or a hint is asked, never in a
  // loop. The matching is done in the page (src/coach.ts) against the coach's game list: titles stay on this PC.
  ipcMain.handle("coach-detect", async () => {
    const own = new Set(BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId()));
    const sources = (await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }))
      .filter((s) => !own.has(s.id) && s.name);
    const procs = await windowPrograms();
    return sources.map((s) => {
      const p = procs.find((x) => x.t === s.name);
      return { id: s.id, name: s.name, process: p ? `${p.p}.exe` : null, path: p?.f ?? null };
    });
  });
  // how hard the whole app works (percent of one core, all its processes) and how long the user has been away
  ipcMain.handle("coach-load", () => ({
    cpu: app.getAppMetrics().reduce((s, m) => s + (m.cpu?.percentCPUUsage ?? 0), 0),
    idle: powerMonitor.getSystemIdleTime(),
  }));
  ipcMain.on("coach-state", (_e, on: boolean) => {
    coachOn = !!on;
    tray?.setContextMenu(menu());
  });
  ipcMain.on("lang", (_e, lang: Lang) => {
    setLang(lang);
    tray?.setContextMenu(menu());
  });
  ipcMain.on("set-ignore", (_e, through: boolean) => pet.setIgnoreMouseEvents(!!through));
  ipcMain.handle("work-area", () => screen.getDisplayMatching(pet.getBounds()).workArea);
  ipcMain.on("notify", (_e, title: string, body: string) => {
    if (Notification.isSupported()) new Notification({ title: String(title), body: String(body), silent: true }).show();
  });
  ipcMain.handle("open-url", (_e, url: string) => {
    if (!LINKS.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)) throw new Error("that link isn't ours");
    return shell.openExternal(url);
  });
  // no login items on Linux: the settings window hides the box when this says null
  // the Microsoft Store version (process.windowsStore): Windows itself starts it (the package's StartupTask; the user
  // turns it off in Task Manager > Startup apps), so the box is hidden there too
  ipcMain.handle("autostart-get", () => (process.platform === "linux" || process.windowsStore ? null : app.getLoginItemSettings().openAtLogin));
  ipcMain.on("autostart-set", (_e, on: boolean) => app.setLoginItemSettings({ openAtLogin: !!on }));
}

/** Windows: every program with a window - its name, its window's title and where it is installed (Get-Process). Elsewhere
 * nothing: the coach then goes by the window titles alone. A program run as admin may hide its folder: name only. */
function windowPrograms(): Promise<{ p: string; t: string; f: string | null }[]> {
  if (process.platform !== "win32") return Promise.resolve([]);
  const ps = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Process | Where-Object { $_.MainWindowTitle } | " +
    "ForEach-Object { [pscustomobject]@{ p = $_.ProcessName; t = $_.MainWindowTitle; f = $(try { $_.Path } catch { $null }) } } | ConvertTo-Json -Compress";
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 12_000, windowsHide: true, encoding: "utf8", maxBuffer: 4 << 20 },
      (err, out) => {
        if (err) return resolve([]);
        try {
          const j = JSON.parse(String(out).trim() || "[]");
          resolve((Array.isArray(j) ? j : [j]).filter((x) => x && x.p && x.t));
        } catch { resolve([]); }
      });
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {            // opening it again brings it back, and shows the way to close it
    if (hidden) setHidden(false);
    pet.webContents.send("open", "");
  });
  app.on("window-all-closed", () => {});     // it lives in the tray
  app.dock?.hide();                          // and on macOS not in the Dock
  if (process.platform === "win32") app.setAppUserModelId("com.flyaiworld.flypet");
  void app.whenReady().then(() => {
    serveApp();
    handleCalls();
    createPet();
    createTray();
    setTimeout(() => void checkUpdate(), 30_000);
    setInterval(() => void checkUpdate(), UPDATE_MS);
    watchCursor();
    setInterval(computeTick, COMPUTE_MS);
    globalShortcut.register(COACH_KEY, () => pet.webContents.send("coach", "hint"));   // false if another app holds it
  });
  app.on("will-quit", () => { globalShortcut.unregisterAll(); perchWatch(false); });
}

// ---- sitting on your windows (2026-11-18, flypet/EXPEDITIONS-PLAN.md; the user: "Also window perching") -------------------
// Windows, macOS and Linux X11 (2026-11-19, issue #56); Wayland has no window list to read and stays off (the settings row
// says so). While the setting is on, the window in front is read every 0.7 s and the pet hears its box in screen DIPs - or
// null for the desktop, our own windows, or a window with no room above it. A window manager without EWMH's
// _NET_ACTIVE_WINDOW (rare on X11) means no perching, not a wrong one. It only reads where a window is and an id for it:
// never its title, never its contents, never any input.
// Windows: a small PowerShell loop, GetForegroundWindow's box, process and class. macOS: the same loop in osascript's
// JavaScript, taking the first normal-level on-screen window from CGWindowListCopyWindowInfo - no permission prompt,
// because window names are never asked for. Linux: the X wire itself, spoken over one socket to the server that is
// already running (nothing to install): the root's _NET_ACTIVE_WINDOW, that window's _NET_WM_PID and its box.
const PERCH_MS = 700;
type PerchBox = { x: number; y: number; width: number; height: number };
type PerchWin = PerchBox & { id: string };
let perchProc: ChildProcess | null = null, perchLast = "";
function perchSend(msg: PerchWin | null) {
  const key = JSON.stringify(msg);
  if (key !== perchLast && pet && !pet.isDestroyed()) { perchLast = key; pet.webContents.send("perch", msg); }
}
function ownWindow(b: PerchBox): boolean {
  // the helpers can't see the pet's own pid the way Windows does (macOS windows belong to its helper processes, Linux
  // ones may not say), so ours are told by their box, which this process knows exactly
  return BrowserWindow.getAllWindows().some((w) => {
    if (!w.isVisible()) return false;
    const g = w.getBounds();
    return g.width === b.width && g.height === b.height && Math.abs(g.x - b.x) <= 2 && Math.abs(g.y - b.y) <= 2;
  });
}
const perchOk = (b: PerchBox) => b.width >= 240 && b.height >= 120 && [b.x, b.y, b.width, b.height].every((n) => Number.isFinite(n));
/** a box in screen pixels as DIPs for Linux, where Electron only offers the point conversions (the rect one is Windows
 * only, which is what the Windows watcher above uses); a box is just its two corners */
function dipRect(box: PerchBox): PerchBox {
  const a = screen.screenToDipPoint({ x: box.x, y: box.y }), b = screen.screenToDipPoint({ x: box.x + box.width, y: box.y + box.height });
  return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
}

/** Linux: on a Wayland session (or without any DISPLAY) there is no front window to read - the row explains, the watcher stays off */
function perchLinuxAble(): boolean | "wayland" {
  const way = process.env.XDG_SESSION_TYPE === "wayland" || (!!process.env.WAYLAND_DISPLAY && process.env.XDG_SESSION_TYPE !== "x11");
  return way || !process.env.DISPLAY ? "wayland" : true;
}
function perchWatch(on: boolean) {
  if (process.platform === "linux" && perchLinuxAble() !== true) on = false;
  if (!on) {
    perchProc?.kill(); perchProc = null; perchLast = "";
    x11Stop();
    return;
  }
  if (perchProc || x11) return;
  if (process.platform === "win32") {
    const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PERCH_PS], { windowsHide: true });
    perchProc = ps;
    let buf = "";
    ps.stdout?.setEncoding("utf8");
    ps.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        const [hwnd, pid, l, t_, r, b, zoomed, iconic, cls] = line.split("|");
        const box = { x: Number(l), y: Number(t_), width: Number(r) - Number(l), height: Number(b) - Number(t_) };
        const skip = !hwnd || Number(pid) === process.pid || zoomed === "1" || iconic === "1" || PERCH_SKIP.has(cls ?? "")
          || !perchOk(box);
        const dip = skip ? null : screen.screenToDipRect(null, box);
        perchSend(dip ? { id: hwnd, ...dip } : null);
      }
    });
    ps.on("exit", () => { if (perchProc === ps) perchProc = null; });
  } else if (process.platform === "darwin") {
    // its lines (on stderr, where osascript's console goes) are the front normal window's number and box in points, which
    // on macOS are the screen DIPs already; ours and the desktop are filtered here, where the boxes are known
    const ps = spawn("osascript", ["-l", "JavaScript", "-e", PERCH_JXA]);
    perchProc = ps;
    let buf = "";
    ps.stderr?.setEncoding("utf8");
    ps.stderr?.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        const [num, x, y, w, h] = line.split("|");
        const box = num ? { id: num, x: Number(x), y: Number(y), width: Number(w), height: Number(h) } : null;
        perchSend(box && perchOk(box) && !ownWindow(box) ? box : null);
      }
    });
    ps.on("exit", () => { if (perchProc === ps) perchProc = null; });
  } else void x11Start();
}
const PERCH_PS = `
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class FlyW {
  [StructLayout(LayoutKind.Sequential)] public struct Box { public int L; public int T; public int R; public int B; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Box b);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int p);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
}
"@
while ($true) {
  $h = [FlyW]::GetForegroundWindow(); $b = New-Object FlyW+Box; [void][FlyW]::GetWindowRect($h, [ref]$b)
  $p = 0; [void][FlyW]::GetWindowThreadProcessId($h, [ref]$p); $c = New-Object System.Text.StringBuilder 64; [void][FlyW]::GetClassName($h, $c, 64)
  [Console]::Out.WriteLine("$h|$p|$($b.L)|$($b.T)|$($b.R)|$($b.B)|$([int][FlyW]::IsZoomed($h))|$([int][FlyW]::IsIconic($h))|$c")
  Start-Sleep -Milliseconds 700
}`;
const PERCH_SKIP = new Set(["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "NotifyIconOverflowWindow", "Windows.UI.Core.CoreWindow"]);
// the front window (not the desktop, the dock, the menu bar, the pet or anything else of ours): the first normal-level
// on-screen window in front-to-back order, with only its number and its box taken - our own windows are told by the
// running app's name (Electron in a dev run, Fly Pet in the packaged one), so the detached dev tools are caught too
const PERCH_JXA = `
ObjC.import('Foundation'); ObjC.import('CoreGraphics')
const MINE = ${JSON.stringify([...new Set([basename(process.execPath).replace(/\.app$/, ""), app.getName()])])}
function front() {
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(20, 0), 'NSArray')   // 4 on-screen only | 16 without the desktop
  for (let i = 0; list && i < list.count; i++) {
    const w = list.objectAtIndex(i)
    if (w.objectForKey('kCGWindowLayer').intValue !== 0) continue                     // layer 0 = a normal window
    if (MINE.indexOf(String(w.objectForKey('kCGWindowOwnerName'))) >= 0) continue
    const b = w.objectForKey('kCGWindowBounds')
    if (!b) continue
    console.log(w.objectForKey('kCGWindowNumber').longLongValue + '|' +
      b.objectForKey('X').doubleValue + '|' + b.objectForKey('Y').doubleValue +
      '|' + b.objectForKey('Width').doubleValue + '|' + b.objectForKey('Height').doubleValue)
    return
  }
  console.log('')
}
while (true) { front(); $.NSThread.sleepForTimeInterval(0.7) }`;

// ---- linux: the X wire, spoken straight to the server that is already running (nothing to install) -----------------------
// One connection, made when the setting comes on and closed when it goes off. Every 0.7 s it asks exactly three things:
// the root's _NET_ACTIVE_WINDOW (the window in front), that window's _NET_WM_PID (to skip our own), and its box. The wire
// is little-endian (the first byte below asks for that); a reply is 32 bytes plus its length in 4-byte units, an error or
// an event is 32, and each carries the sequence number of its request, so one reply at a time is waited for by number.
type X11 = { sock: import("node:net").Socket; root: number; seq: number; buf: Buffer; pending: { seq: number; r: (msg: Buffer | null) => void } | null; setup: boolean; waiters: { n: number; r: (b: Buffer) => void }[] };
let x11: X11 | null = null, x11Atoms: { active: number; pid: number } | null = null, x11Timer: NodeJS.Timeout | null = null, x11Busy = false;
const pad4 = (n: number) => (4 - (n % 4)) % 4;

/** ~/.Xauthority's cookie for this display (or XAUTHORITY's), to open the connection: read once, never stored or sent anywhere else */
function x11Auth(display: number): { name: string; data: Buffer } | null {
  let b: Buffer;
  try { b = readFileSync(process.env.XAUTHORITY || join(homedir(), ".Xauthority")); } catch { return null; }
  const host = hostname();
  let best: { name: string; data: Buffer; rank: number } | null = null;
  for (let i = 0; i + 4 <= b.length;) {
    const family = b.readUInt16BE(i);
    const aLen = b.readUInt16BE(i + 2); i += 4;
    if (i + aLen + 2 > b.length) break;
    const addr = b.subarray(i, i + aLen); i += aLen;
    const nLen = b.readUInt16BE(i); i += 2;
    if (i + nLen > b.length) break;
    const num = b.toString("latin1", i, i + nLen); i += nLen;
    const naLen = b.readUInt16BE(i); i += 2;
    if (i + naLen > b.length) break;
    const name = b.toString("latin1", i, i + naLen); i += naLen;
    const dLen = b.readUInt16BE(i); i += 2;
    if (i + dLen > b.length) break;
    const data = b.subarray(i, i + dLen); i += dLen;
    if (num !== "" && num !== String(display)) continue;
    const rank = family === 256 && addr.toString("latin1") === host ? 3 : family === 0 || family === 6 ? 2 : family === 254 ? 1 : 0;
    if (rank && (!best || rank > best.rank)) best = { name, data, rank };
  }
  return best;
}
// every byte lands in x.buf: during the handshake exact lengths are drawn from its front, afterwards whole replies
function x11Feed(x: X11, chunk: Buffer) {
  x.buf = x.buf.length ? Buffer.concat([x.buf, chunk]) : chunk;
  if (x.setup) {
    while (x.waiters.length && x.buf.length >= x.waiters[0].n) {
      const w = x.waiters.shift()!; w.r(x.buf.subarray(0, w.n)); x.buf = x.buf.subarray(w.n);
    }
    return;
  }
  while (x.buf.length >= 32) {
    const total = x.buf[0] === 1 ? 32 + x.buf.readUInt32LE(4) * 4 : 32;
    if (x.buf.length < total) return;
    const msg = x.buf.subarray(0, total); x.buf = x.buf.subarray(total);
    if (x.pending && (msg[0] === 1 || msg[0] === 0) && msg.readUInt16LE(2) === x.pending.seq) {
      const p = x.pending; x.pending = null; p.r(msg[0] === 1 ? msg : null);
    }
  }
}
const x11Bytes = (x: X11, n: number) => new Promise<Buffer>((r) => { if (x.buf.length >= n) { r(x.buf.subarray(0, n)); x.buf = x.buf.subarray(n); } else x.waiters.push({ n, r }); });
function x11Request(x: X11, req: Buffer): Promise<Buffer | null> {
  return new Promise((r) => {
    if (x.sock.destroyed) return r(null);
    const seq = (x.seq = (x.seq + 1) & 0xffff);
    x.pending = { seq, r };
    x.sock.write(req);
  });
}
async function x11Intern(x: X11, name: string): Promise<number | null> {
  const bytes = Buffer.from(name, "latin1");
  const req = Buffer.alloc(8 + Math.ceil(bytes.length / 4) * 4);
  req[0] = 16; req[1] = 1;                            // InternAtom, only if it exists (it does, on any EWMH window manager)
  req.writeUInt16LE(2 + Math.ceil(bytes.length / 4), 2);
  req.writeUInt16LE(bytes.length, 4);
  bytes.copy(req, 8);
  const r = await x11Request(x, req);
  return r ? r.readUInt32LE(8) : null;
}
async function x11Cardinal(x: X11, win: number, prop: number): Promise<number | null> {
  if (!win || !prop) return null;
  const req = Buffer.alloc(24);
  req[0] = 20; req.writeUInt16LE(6, 2);               // GetProperty: the reply's format is its second byte, the value at 32
  req.writeUInt32LE(win, 4); req.writeUInt32LE(prop, 8); req.writeUInt32LE(0, 12);
  req.writeUInt32LE(0, 16); req.writeUInt32LE(1, 20);
  const r = await x11Request(x, req);
  return r && r[1] === 32 ? r.readUInt32LE(32) : null;
}
async function x11Geometry(x: X11, win: number): Promise<{ w: number; h: number } | null> {
  const req = Buffer.alloc(8);
  req[0] = 14; req.writeUInt16LE(2, 2);               // GetGeometry: root at 8, the box at 12 (relative to its frame)
  req.writeUInt32LE(win, 4);
  const r = await x11Request(x, req);
  return r ? { w: r.readUInt16LE(16), h: r.readUInt16LE(18) } : null;
}
async function x11Origin(x: X11, win: number, root: number): Promise<{ x: number; y: number } | null> {
  const req = Buffer.alloc(16);
  req[0] = 40; req.writeUInt16LE(4, 2);               // TranslateCoordinates: the frame's child at 8, the origin at 12
  req.writeUInt32LE(win, 4); req.writeUInt32LE(root, 8);
  const r = await x11Request(x, req);
  return r ? { x: r.readInt16LE(12), y: r.readInt16LE(14) } : null;
}
let x11Gen = 0;
function x11Stop() {
  x11Gen++;                                        // a connect still in flight when the setting went off is discarded
  if (x11Timer) { clearInterval(x11Timer); x11Timer = null; }
  if (x11) { const x = x11; x11 = null; x.pending?.r(null); x.pending = null; x.sock.destroy(); }
  x11Atoms = null; x11Busy = false;
}
async function x11Connect(): Promise<X11> {
  const d = /^([^:]*):(\d+)/.exec(process.env.DISPLAY ?? "");
  if (!d) throw new Error("no DISPLAY");
  const n = Number(d[2]);
  const x: X11 = { sock: null as unknown as X11["sock"], root: 0, seq: 0, buf: Buffer.alloc(0), pending: null, setup: true, waiters: [] };
  x.sock = xConnect(!d[1] || d[1] === "unix" ? { path: `/tmp/.X11-unix/X${n}` } : { host: d[1], port: 6000 + n });
  x.sock.on("data", (c: Buffer) => x11Feed(x, c));
  x.sock.on("error", () => x11Stop());
  await new Promise<void>((res, rej) => { x.sock.once("connect", res); x.sock.once("error", rej); });
  const auth = x11Auth(n) ?? { name: "", data: Buffer.alloc(0) };
  const hs = Buffer.alloc(12 + Math.ceil(auth.name.length / 4) * 4 + Math.ceil(auth.data.length / 4) * 4);
  hs[0] = 0x6c;                                      // 'l': the whole wire little-endian
  hs.writeUInt16LE(11, 2); hs.writeUInt16LE(0, 4);
  hs.writeUInt16LE(auth.name.length, 6); hs.writeUInt16LE(auth.data.length, 8);
  Buffer.from(auth.name, "latin1").copy(hs, 12);
  auth.data.copy(hs, 12 + Math.ceil(auth.name.length / 4) * 4);
  x.sock.write(hs);
  const head = await x11Bytes(x, 8);                 // [ok][pad][major@2][minor@4][length@6, in 4-byte units]
  if (head[0] !== 1) throw new Error("the X server refused the connection");
  const setup = Buffer.concat([head, await x11Bytes(x, head.readUInt16LE(6) * 4)]);
  // then: release, id base/mask, motion buffer, vendor length, max request, screen and format counts, byte orders,
  // scanline unit/pad, keycodes; the vendor string, the 8-byte formats, and the screens, whose first 4 bytes are the root
  const nScreens = setup[28], nFormats = setup[29], vendorLen = setup.readUInt16LE(24);
  x.root = setup.readUInt32LE(40 + vendorLen + pad4(vendorLen) + 8 * nFormats);
  if (!nScreens || !x.root) throw new Error("no screen on the X server");
  x.setup = false;
  return x;
}
async function x11Tick() {
  const x = x11;
  if (!x || x11Busy) return;
  x11Busy = true;
  try {
    if (!x11Atoms) x11Atoms = { active: (await x11Intern(x, "_NET_ACTIVE_WINDOW")) ?? 0, pid: (await x11Intern(x, "_NET_WM_PID")) ?? 0 };
    const win = await x11Cardinal(x, x.root, x11Atoms.active);      // 0 = none; 1 is a placeholder some compositors use
    let msg: PerchWin | null = null;
    if (win && win !== 1) {
      const pid = await x11Cardinal(x, win, x11Atoms.pid);          // Chromium sets it: our own windows are skipped here
      const geo = await x11Geometry(x, win), org = await x11Origin(x, win, x.root);
      if (geo && org) {
        const dip = dipRect({ x: org.x, y: org.y, width: geo.w, height: geo.h });
        const box = { id: `0x${win.toString(16)}`, ...dip };
        if (pid !== process.pid && perchOk(box) && !ownWindow(box)) msg = box;
      }
    }
    perchSend(msg);
  } catch { x11Stop(); }                             // the socket went away: off until the next time the setting is on
  finally { x11Busy = false; }
}
async function x11Start() {
  const gen = ++x11Gen;
  try {
    const x = await x11Connect();
    if (gen !== x11Gen) { x.sock.destroy(); return; }
    x11 = x;
    x11Timer = setInterval(() => void x11Tick(), PERCH_MS);
  } catch { if (gen === x11Gen) x11 = null; }        // no X server to talk to right now: no perching
}
